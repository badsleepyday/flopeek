"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const readline = require("node:readline");

const NATIVE_PROTOCOL_VERSION = "flopeek-native-protocol/v1";
const MAX_STDERR_TAIL_BYTES = 16 * 1024;

function nativeProcessEnvironment(platform = process.platform, environment = process.env, overrides = {}) {
  const linuxAllocatorDefaults = platform === "linux" ? {
    MALLOC_ARENA_MAX: environment.MALLOC_ARENA_MAX || "1",
    MALLOC_TRIM_THRESHOLD_: environment.MALLOC_TRIM_THRESHOLD_ || "131072",
  } : {};
  return { ...environment, ...linuxAllocatorDefaults, ...overrides };
}

class NativeProtocolClientError extends Error {
  constructor(code, message, response = null) {
    super(message);
    this.name = "NativeProtocolClientError";
    this.code = code;
    this.response = response;
  }
}

class NativeProtocolClient {
  constructor(options = {}) {
    if (!options.command) throw new TypeError("Native protocol client requires a command.");
    this.command = options.command;
    this.args = [...(options.args || [])];
    this.cwd = options.cwd;
    this.requestTimeoutMs = Math.max(1, Number(options.requestTimeoutMs) || 30_000);
    // Mutation deadlines and authority-recovery deadlines have different
    // responsibilities. A deliberately tight scan deadline must not also
    // become the startup/read deadline used to determine whether SQLite
    // committed before the timed-out response became observable.
    this.recoveryTimeoutMs = Math.max(1, Number(options.recoveryTimeoutMs) || 30_000);
    this.spawn = options.spawn || defaultSpawn;
    this.env = { ...(options.env || {}) };
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.nextRequestNumber = 0;
    this.lastResponseStats = null;
    this.lastStartStats = null;
    this.startPromise = null;
    this.closed = false;
    this.stderrTail = "";
  }

  async start(options = {}) {
    if (this.startPromise) return this.startPromise;
    if (this.child && !this.closed) return this;
    const startedAt = process.hrtime.bigint();
    this.startPromise = this.#start(startedAt, options.timeoutMs);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start(startedAt, timeoutMs) {
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.closed = false;
    this.stderrTail = "";
    const child = this.spawn(this.command, [...this.args, "--native-serve"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: nativeProcessEnvironment(process.platform, process.env, this.env),
    });
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.#handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => this.#fail(new NativeProtocolClientError("process-error", error.message)));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.closed = true;
      const diagnostic = this.stderrTail.trim();
      const suffix = diagnostic ? `\n${diagnostic}` : "";
      this.#fail(new NativeProtocolClientError("process-exit", `Native protocol process exited (${signal ?? code ?? "unknown"}).${suffix}`));
    });
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(new NativeProtocolClientError("process-start-failed", error.message));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    const spawnedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    try {
      // A spawned process is not necessarily ready to serve JSONL yet. Probe
      // the protocol before exposing the session so cold scans never fold
      // binary initialization into an unrelated source-analysis phase.
      const health = await this.request("health", {}, { timeoutMs });
      if (!health || typeof health !== "object" || Array.isArray(health)) {
        throw new NativeProtocolClientError("invalid-response", "Native protocol health response is invalid.");
      }
      this.lastStartStats = Object.freeze({
        spawnedMilliseconds,
        readyMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        healthRequestId: this.lastResponseStats?.requestId || null,
      });
    } catch (error) {
      await this.abort("Native protocol failed its startup health check.");
      throw error;
    }
    return this;
  }

  async request(method, params = {}, options = {}) {
    if (!this.child || this.closed) throw new NativeProtocolClientError("not-running", "Native protocol process is not running.");
    if (typeof method !== "string" || !method.trim()) throw new TypeError("Native protocol method must be a non-empty string.");
    const timeoutMs = options.timeoutMs === undefined
      ? this.requestTimeoutMs
      : Math.max(1, Number(options.timeoutMs) || this.requestTimeoutMs);
    const requestId = `native-${++this.nextRequestNumber}`;
    const payload = `${JSON.stringify({ protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, method, params })}\n`;
    const requestBytes = Buffer.byteLength(payload, "utf8");
    const response = new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timeout: null,
        requestBytes,
        requestStartedAt: process.hrtime.bigint(),
        writeMilliseconds: 0,
        writeBlocked: false,
      };
      pending.timeout = setTimeout(() => {
        if (this.pending.get(requestId) !== pending) return;
        this.pending.delete(requestId);
        const error = new NativeProtocolClientError("request-timeout", `Native protocol request ${requestId} (${method}) timed out.`);
        error.requestId = requestId;
        error.method = method;
        // JSONL requests are sequential. A timed-out child cannot be reused:
        // it may still be inside a SQLite transaction or may have committed
        // immediately before the response became observable. Reject only
        // after the process boundary is closed so callers can safely reopen
        // the store and determine the last-complete authority.
        this.#terminate(error).then(
          () => pending.reject(error),
          (terminationError) => {
            error.terminationError = terminationError;
            pending.reject(error);
          },
        );
      }, timeoutMs);
      this.pending.set(requestId, pending);
    });
    try {
      const writeStarted = process.hrtime.bigint();
      const writeBlocked = !this.child.stdin.write(payload);
      if (writeBlocked) {
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            this.child.stdin.off("error", onError);
            resolve();
          };
          const onError = (error) => {
            this.child.stdin.off("drain", onDrain);
            reject(error);
          };
          this.child.stdin.once("drain", onDrain);
          this.child.stdin.once("error", onError);
        });
      }
      const pending = this.pending.get(requestId);
      if (pending) {
        pending.writeMilliseconds = Number(process.hrtime.bigint() - writeStarted) / 1_000_000;
        pending.writeBlocked = writeBlocked;
      }
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(new NativeProtocolClientError("write-failed", error.message));
      }
    }
    return response;
  }

  async close() {
    const child = this.child;
    if (!child || this.closed) return;
    // `shutdown` is acknowledged before Rust drops its session-owned SQLite
    // connections. Wait for the child exit so callers can immediately remove
    // a temporary repository on Windows without racing an open database file.
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await this.request("shutdown");
    } finally {
      child.stdin.end();
    }
    await exited;
  }

  // JSONL requests are sequential, so there is no second request that can
  // cooperatively interrupt a running SQLite transaction. Terminating this
  // isolated child is the cancellation boundary: SQLite rolls back an active
  // transaction, while a commit that already won remains a complete graph.
  async abort(reason = "Native scan cancelled.") {
    const child = this.child;
    if (!child || this.closed) return false;
    const error = new NativeProtocolClientError("native-request-cancelled", reason);
    await this.#terminate(error);
    return true;
  }

  async #terminate(error) {
    const child = this.child;
    this.closed = true;
    this.#fail(error);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.destroy();
    child.kill();
    await exited;
  }

  getLastResponseStats() {
    return this.lastResponseStats ? { ...this.lastResponseStats } : null;
  }

  getLastStartStats() {
    return this.lastStartStats ? { ...this.lastStartStats } : null;
  }

  #handleLine(line) {
    const parseStarted = process.hrtime.bigint();
    const responseBytes = Buffer.byteLength(line, "utf8");
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.#fail(new NativeProtocolClientError("invalid-response", "Native protocol emitted invalid JSON."));
      return;
    }
    if (response?.protocolVersion !== NATIVE_PROTOCOL_VERSION || typeof response.requestId !== "string") {
      this.#fail(new NativeProtocolClientError("invalid-response", "Native protocol emitted an incompatible response."));
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.lastResponseStats = {
      requestId: response.requestId,
      requestBytes: pending.requestBytes,
      requestWriteMilliseconds: pending.writeMilliseconds,
      requestWriteBlocked: pending.writeBlocked,
      roundTripMilliseconds: Number(process.hrtime.bigint() - pending.requestStartedAt) / 1_000_000,
      responseBytes,
      parseMilliseconds: Number(process.hrtime.bigint() - parseStarted) / 1_000_000,
    };
    clearTimeout(pending.timeout);
    this.pending.delete(response.requestId);
    if (response.status === "ok") pending.resolve(response.result);
    else pending.reject(new NativeProtocolClientError(response.error?.code || "native-error", response.error?.message || "Native protocol request failed.", response));
  }

  #fail(error) {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }
}

module.exports = {
  NATIVE_PROTOCOL_VERSION,
  NativeProtocolClient,
  nativeProcessEnvironment,
  NativeProtocolClientError,
};
