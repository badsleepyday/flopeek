"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCoreCompatibilityDigest } = require("../../src/core-compatibility");
const { createNativeFallbackCoreClient } = require("../../src/core-runtime");
const { createJsCoreClient } = require("../../src/js-core-client");
const { createNativeCoreClient } = require("../../src/native-core-client");
const { NativeProtocolClient } = require("../../src/native-protocol-client");

const ROOT = path.resolve(__dirname, "..", "..");
const BINARY = process.env.FLOPEEK_NATIVE_CORE_BINARY
  || path.join(
    ROOT,
    "native",
    "flopeek-core",
    "target",
    "release",
    process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core",
  );
const CRASH_POINTS = Object.freeze([
  "after-begin-build",
  "after-fact-storage",
  "before-current-pointer-promotion",
  "after-graph-payload-write",
]);
const SESSIONS = new WeakMap();

function write(root, relative, body) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function protocol(crashPoint = null, requestTimeoutMs = 30_000, delayPoint = null, delayMs = 5_000) {
  return new NativeProtocolClient({
    command: BINARY,
    args: [],
    cwd: ROOT,
    requestTimeoutMs,
    recoveryTimeoutMs: 30_000,
    spawn: (command, args, options) => childProcess.spawn(command, args, {
      ...options,
      env: {
        ...process.env,
        ...(crashPoint ? { FLOPEEK_NATIVE_TEST_CRASH_POINT: crashPoint } : {}),
        ...(delayPoint ? {
          FLOPEEK_NATIVE_TEST_DELAY_POINT: delayPoint,
          FLOPEEK_NATIVE_TEST_DELAY_MS: String(delayMs),
        } : {}),
      },
    }),
  });
}

function native(crashPoint = null, requestTimeoutMs = 30_000, delayPoint = null, delayMs = 5_000) {
  const session = protocol(crashPoint, requestTimeoutMs, delayPoint, delayMs);
  const client = createNativeCoreClient({ native: session, sourceAuthority: "rust" });
  SESSIONS.set(client, session);
  return client;
}

test("timeout before SQLite promotion proves rollback before JavaScript fallback", {
  timeout: 120_000,
  skip: !fs.existsSync(BINARY) && "native release binary is unavailable",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-timeout-before-promotion-"));
  write(root, "package.json", JSON.stringify({ name: "timeout-before-promotion" }));
  write(root, "src/index.ts", "export function beforePromotion() { return 1; }\n");
  const session = protocol(null, 2_000, "before-promotion", 5_000);
  const rawNativeCore = createNativeCoreClient({ native: session, sourceAuthority: "rust" });
  let nativeFailure = null;
  let authorityReadFailure = null;
  const nativeCore = {
    ...rawNativeCore,
    getLastCompleteGraph: async (...args) => {
      try { return await rawNativeCore.getLastCompleteGraph(...args); }
      catch (error) { authorityReadFailure = error; throw error; }
    },
    scan: async (...args) => {
      try { return await rawNativeCore.scan(...args); }
      catch (error) { nativeFailure = error; throw error; }
    },
  };
  let javascriptScans = 0;
  const javascript = {
    ...createJsCoreClient(),
    scan: async (...args) => {
      javascriptScans += 1;
      return createJsCoreClient().scan(...args);
    },
  };
  const fallback = createNativeFallbackCoreClient(nativeCore, javascript);
  const recoveryReader = native();
  try {
    const graph = await fallback.scan(root);
    assert.equal(authorityReadFailure, null, authorityReadFailure?.stack);
    assert.equal(nativeFailure?.code, "request-timeout", nativeFailure?.stack);
    assert.equal(nativeFailure?.nativeAuthorityMutation, true);
    assert.equal(javascriptScans, 1);
    assert.equal(fallback.authorityState, "javascript");
    assert.deepEqual(fallback.fallback, { active: true, reason: "native-mutation-failed-before-promotion" });
    assert.equal(await recoveryReader.getLastCompleteGraph(root), null);
    assert.equal(createCoreCompatibilityDigest(graph), createCoreCompatibilityDigest(createJsCoreClient().scan(root)));
    assert.ok(session.child && !session.closed, "authority recovery must restart the terminated native session");
  } finally {
    await fallback.close();
    await close(recoveryReader);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timeout after SQLite commit recovers the late native graph and never runs JavaScript", {
  timeout: 120_000,
  skip: !fs.existsSync(BINARY) && "native release binary is unavailable",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-timeout-after-promotion-"));
  write(root, "package.json", JSON.stringify({ name: "timeout-after-promotion" }));
  write(root, "src/index.ts", "export function afterPromotion() { return 1; }\n");
  const session = protocol(null, 2_000, "after-promotion-before-response", 5_000);
  const rawNativeCore = createNativeCoreClient({ native: session, sourceAuthority: "rust" });
  let nativeFailure = null;
  let authorityReadFailure = null;
  const nativeCore = {
    ...rawNativeCore,
    getLastCompleteGraph: async (...args) => {
      try { return await rawNativeCore.getLastCompleteGraph(...args); }
      catch (error) { authorityReadFailure = error; throw error; }
    },
    scan: async (...args) => {
      try { return await rawNativeCore.scan(...args); }
      catch (error) { nativeFailure = error; throw error; }
    },
  };
  let javascriptScans = 0;
  const javascript = {
    ...createJsCoreClient(),
    scan: async (...args) => {
      javascriptScans += 1;
      return createJsCoreClient().scan(...args);
    },
  };
  const fallback = createNativeFallbackCoreClient(nativeCore, javascript);
  try {
    const recovered = await fallback.scan(root);
    assert.equal(authorityReadFailure, null, authorityReadFailure?.stack);
    assert.equal(nativeFailure?.code, "request-timeout", nativeFailure?.stack);
    assert.equal(nativeFailure?.nativeAuthorityMutation, true);
    assert.equal(javascriptScans, 0);
    assert.equal(fallback.authorityState, "native-authoritative");
    assert.deepEqual(fallback.fallback, { active: false, reason: null });
    assert.equal(recovered.state.status, "native-last-complete");
    assert.equal(createCoreCompatibilityDigest(recovered), createCoreCompatibilityDigest(createJsCoreClient().scan(root)));
    assert.ok(session.child && !session.closed, "late-commit recovery must continue on a fresh native session");
  } finally {
    await fallback.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function close(client) {
  try {
    await client.close();
  } catch {
    // A crash-injected child has already exited. Its rejected scan is the
    // assertion; cleanup must not hide it or require a live process.
  }
}

async function abort(client) {
  try {
    await SESSIONS.get(client)?.abort("failure-recovery test cleanup");
  } catch {
    // The child may have completed or exited between the check and abort.
  }
}

test("process termination at every durable promotion boundary preserves last-complete authority", {
  timeout: 180_000,
  skip: !fs.existsSync(BINARY) && "native release binary is unavailable",
}, async (context) => {
  for (const crashPoint of CRASH_POINTS) {
    await context.test(crashPoint, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `flopeek-native-crash-${crashPoint}-`));
      write(root, "package.json", JSON.stringify({ name: `crash-${crashPoint}` }));
      write(root, "src/index.ts", "export function stable() { return 1; }\n");
      const initialWriter = native();
      const crashingWriter = native(crashPoint);
      const recoveryReader = native();
      try {
        const first = await initialWriter.scan(root);
        const firstDigest = createCoreCompatibilityDigest(first);
        await initialWriter.close();
        write(root, "src/index.ts", "export function changedAfterCrash() { return 2; }\n");
        await assert.rejects(
          crashingWriter.scan(root, { changedPaths: ["src/index.ts"] }),
          (error) => ["process-exit", "write-failed"].includes(error?.code),
        );
        const recovered = await recoveryReader.getLastCompleteGraph(root);
        assert.ok(recovered, "a crash must not remove the last complete graph");
        assert.equal(createCoreCompatibilityDigest(recovered), firstDigest);
        assert.equal(recovered.state.status, "native-last-complete");
        const refreshed = await recoveryReader.scan(root, { changedPaths: ["src/index.ts"] });
        const oracle = createJsCoreClient().scan(root);
        assert.equal(createCoreCompatibilityDigest(refreshed), createCoreCompatibilityDigest(oracle));
        assert.ok(refreshed.state.graphVersion > first.state.graphVersion);
      } finally {
        await close(initialWriter);
        await close(crashingWriter);
        await close(recoveryReader);
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("two native processes share one project identity and serialize writers without corrupting the current pointer", {
  timeout: 120_000,
  skip: !fs.existsSync(BINARY) && "native release binary is unavailable",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-concurrent-"));
  write(root, "package.json", JSON.stringify({ name: "native-concurrent" }));
  write(root, "src/index.ts", "export function first() { return 1; }\n");
  const first = native(null, 10_000);
  const second = native(null, 10_000);
  const reader = native();
  try {
    const baseline = await first.scan(root);
    const visible = await reader.getLastCompleteGraph(root);
    assert.equal(visible.project.projectId, baseline.project.projectId);
    write(root, "src/index.ts", "export function secondVersion() { return 2; }\n");
    const writers = await Promise.allSettled([
      first.scan(root, { changedPaths: ["src/index.ts"] }),
      second.scan(root, { changedPaths: ["src/index.ts"] }),
    ]);
    const completed = writers.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const conflicts = writers.filter((result) => result.status === "rejected");
    assert.ok(completed.length >= 1, "at least one bounded writer must complete");
    assert.ok(conflicts.every((result) => [
      "native-error",
      "request-timeout",
      "process-exit",
    ].includes(result.reason?.code)), "a losing writer must fail through the bounded native protocol");
    assert.ok(completed.every((graph) => graph.project.projectId === baseline.project.projectId));
    await abort(first);
    await abort(second);
    const current = await reader.getLastCompleteGraph(root);
    const oracle = createJsCoreClient().scan(root);
    assert.equal(current.project.projectId, baseline.project.projectId);
    assert.equal(createCoreCompatibilityDigest(current), createCoreCompatibilityDigest(oracle));
    assert.ok(current.state.graphVersion >= Math.max(...completed.map((graph) => graph.state.graphVersion)));

    const status = JSON.parse(childProcess.execFileSync(BINARY, ["--native-status", root], {
      cwd: ROOT,
      encoding: "utf8",
    }));
    assert.equal(status.store.journalMode.toLowerCase(), "wal");
    assert.equal(status.store.busyTimeoutMs, 5000);
    assert.equal(status.store.quickCheck.toLowerCase(), "ok");
  } finally {
    await abort(first);
    await abort(second);
    await close(reader);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crash-point contract is exact and cannot be activated by a near-miss value", {
  timeout: 60_000,
  skip: !fs.existsSync(BINARY) && "native release binary is unavailable",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-crash-near-miss-"));
  write(root, "package.json", JSON.stringify({ name: "native-crash-near-miss" }));
  write(root, "src/index.ts", "export const survives = true;\n");
  const client = native("after-begin-build-typo");
  try {
    const graph = await client.scan(root);
    assert.equal(client.sourceAuthority, "rust");
    assert.ok(Number.isSafeInteger(graph.state.graphVersion));
  } finally {
    await close(client);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

module.exports = { CRASH_POINTS };
