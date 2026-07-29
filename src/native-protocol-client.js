"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const readline = require("node:readline");

const NATIVE_PROTOCOL_VERSION = "flopeek-native-protocol/v1";

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
    this.spawn = options.spawn || defaultSpawn;
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.nextRequestNumber = 0;
    this.lastResponseStats = null;
    this.closed = false;
  }

  async start() {
    if (this.child && !this.closed) return this;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.closed = false;
    const child = this.spawn(this.command, [...this.args, "--native-serve"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.#handleLine(line));
    child.on("error", (error) => this.#fail(new NativeProtocolClientError("process-error", error.message)));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.closed = true;
      this.#fail(new NativeProtocolClientError("process-exit", `Native protocol process exited (${signal ?? code ?? "unknown"}).`));
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
    return this;
  }

  async request(method, params = {}) {
    if (!this.child || this.closed) throw new NativeProtocolClientError("not-running", "Native protocol process is not running.");
    if (typeof method !== "string" || !method.trim()) throw new TypeError("Native protocol method must be a non-empty string.");
    const requestId = `native-${++this.nextRequestNumber}`;
    const payload = `${JSON.stringify({ protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, method, params })}\n`;
    const requestBytes = Buffer.byteLength(payload, "utf8");
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new NativeProtocolClientError("request-timeout", `Native protocol request ${requestId} timed out.`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        requestBytes,
        requestStartedAt: process.hrtime.bigint(),
        writeMilliseconds: 0,
        writeBlocked: false,
      });
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
    if (!this.child || this.closed) return;
    try {
      await this.request("shutdown");
    } finally {
      this.child.stdin.end();
    }
  }

  // JSONL requests are sequential, so there is no second request that can
  // cooperatively interrupt a running SQLite transaction. Terminating this
  // isolated child is the cancellation boundary: SQLite rolls back an active
  // transaction, while a commit that already won remains a complete graph.
  async abort(reason = "Native scan cancelled.") {
    const child = this.child;
    if (!child || this.closed) return false;
    const error = new NativeProtocolClientError("native-request-cancelled", reason);
    this.closed = true;
    this.#fail(error);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.destroy();
    child.kill();
    await exited;
    return true;
  }

  getLastResponseStats() {
    return this.lastResponseStats ? { ...this.lastResponseStats } : null;
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
  NativeProtocolClientError,
};
