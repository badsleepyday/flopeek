"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { NativeProtocolClient } = require("./native-protocol-client");
const { createRepositoryScanner } = require("./scanner");

const NATIVE_MANIFEST_SCHEMA = "flopeek-native-incremental-manifest/v1";
const NATIVE_RECORD_CACHE_SCHEMA = "flopeek-native-js-record-cache/v1";

function selectNativeBinary({ configured, release, debug }, exists = fs.existsSync) {
  if (configured) return { command: configured, args: [] };
  // A workspace often rebuilds tests in debug after an optimized binary was
  // produced. Timestamp ordering would silently downgrade normal CoreClient
  // usage to debug; prefer the artifact intended for packaging and retain
  // debug only as an explicit development fallback.
  if (exists(release)) return { command: release, args: [] };
  if (exists(debug)) return { command: debug, args: [] };
  return null;
}

function defaultNativeBinary() {
  const name = process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
  const selected = selectNativeBinary({
    configured: process.env.FLOPEEK_NATIVE_CORE,
    release: path.join(__dirname, "..", "native", "flopeek-core", "target", "release", name),
    debug: path.join(__dirname, "..", "native", "flopeek-core", "target", "debug", name),
  });
  if (selected) return selected;
  throw new Error("Native Flopeek binary is unavailable. Build native/flopeek-core first or set FLOPEEK_NATIVE_CORE.");
}

function createNativeIncrementalSession(native, options = {}) {
  const resolved = native || defaultNativeBinary();
  return new NativeProtocolClient({
    command: resolved.command,
    args: resolved.args || [],
    cwd: options.cwd || path.join(__dirname, ".."),
    requestTimeoutMs: options.requestTimeoutMs,
  });
}

async function nativeRequest(session, method, params) {
  const started = process.hrtime.bigint();
  const payload = await session.request(method, params);
  return { payload, milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000 };
}

function assertManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== NATIVE_MANIFEST_SCHEMA || !Array.isArray(manifest.candidatePaths)
    || !Array.isArray(manifest.reusedPaths) || !Array.isArray(manifest.changedPaths) || typeof manifest.projectId !== "string") {
    throw new Error("Native incremental manifest does not satisfy flopeek-native-incremental-manifest/v1.");
  }
  if (manifest.sourceBatch !== null && manifest.sourceBatch !== undefined
    && (manifest.sourceBatch.schemaVersion !== "flopeek-native-ephemeral-source-batch/v1"
      || !Array.isArray(manifest.sourceBatch.records)
      || !Number.isInteger(manifest.sourceBatch.omittedFiles)
      || manifest.sourceBatch.persistence !== "ephemeral-jsonl-only")) {
    throw new Error("Native incremental source batch does not satisfy its ephemeral protocol contract.");
  }
}

async function loadCachedRecords(session, root, manifest) {
  const response = await nativeRequest(session, "nativeJsRecordCache", {
    projectRoot: root,
    cacheRequest: {
      schemaVersion: NATIVE_RECORD_CACHE_SCHEMA,
      operation: "load",
      projectId: manifest.projectId,
      paths: manifest.reusedPaths,
    },
  });
  if (response.payload.schemaVersion !== NATIVE_RECORD_CACHE_SCHEMA || response.payload.operation !== "load" || !Array.isArray(response.payload.records)) {
    throw new Error("Native JS record cache returned an invalid load response.");
  }
  return { records: response.payload.records.map((entry) => entry.record), milliseconds: response.milliseconds };
}

async function storeRecords(session, root, manifest, records) {
  const response = await nativeRequest(session, "nativeJsRecordCache", {
    projectRoot: root,
    cacheRequest: {
      schemaVersion: NATIVE_RECORD_CACHE_SCHEMA,
      operation: "store",
      projectId: manifest.projectId,
      records: records.map((record) => ({ path: record.relativePath, record })),
    },
  });
  if (response.payload.schemaVersion !== NATIVE_RECORD_CACHE_SCHEMA || response.payload.operation !== "store" || !Number.isInteger(response.payload.storedRecords)) {
    throw new Error("Native JS record cache returned an invalid store response.");
  }
  return { storedRecords: response.payload.storedRecords, milliseconds: response.milliseconds };
}

async function scanWithNativeIncremental(inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const ownsSession = !options.session;
  const session = options.session || createNativeIncrementalSession(options.native, options);
  const sessionWasRunning = Boolean(session.child && !session.closed);
  const sessionStart = process.hrtime.bigint();
  await session.start();
  const nativeSessionStartMs = Number(process.hrtime.bigint() - sessionStart) / 1_000_000;
  let result;
  try {
    const manifestResult = await nativeRequest(session, "nativeIncrementalManifest", { projectRoot: root, includeSourceBatch: true });
    const manifest = manifestResult.payload;
    assertManifest(manifest);
    const cached = await loadCachedRecords(session, root, manifest);
    const scanner = createRepositoryScanner(root, {
      initialFilePlan: manifest.candidatePaths,
      initialRecords: cached.records,
      initialSourceContents: manifest.sourceBatch?.records || [],
      persistIdentity: options.persistIdentity,
      onProfile: options.onProfile,
    });
    const graph = scanner.scan();
    const sourceBatch = scanner.sourceBatchStatus();
    const changedPaths = new Set(manifest.changedPaths);
    const recordsToStore = scanner.snapshotRecords()
      .filter((record) => changedPaths.has(record.relativePath));
    const stored = recordsToStore.length
      ? await storeRecords(session, root, manifest, recordsToStore)
      : { storedRecords: 0, milliseconds: 0 };
    result = {
      graph,
      native: {
        manifest: {
          candidateFiles: manifest.candidateFiles,
          changedFiles: manifest.changedPaths.length,
          reusedFiles: manifest.reusedPaths.length,
          removedFiles: manifest.removedPaths.length,
          sourceFingerprint: manifest.sourceFingerprint,
          ephemeralSourceRecords: manifest.sourceBatch?.records.length || 0,
          ephemeralSourceOmittedFiles: manifest.sourceBatch?.omittedFiles || 0,
          ephemeralSourceUsedRecords: sourceBatch.used,
          ephemeralSourceDiscardedRecords: sourceBatch.discarded,
        },
        loadedRecords: cached.records.length,
        storedRecords: stored.storedRecords,
        profile: {
          transport: "persistent-jsonl",
          sessionScope: ownsSession ? "scan" : "caller",
          sessionReused: sessionWasRunning,
          protocolRequests: 2 + Number(recordsToStore.length > 0),
          nativeSessionStartMs: Number(nativeSessionStartMs.toFixed(3)),
          nativeSessionCloseMs: null,
          nativeManifestMs: Number(manifestResult.milliseconds.toFixed(3)),
          nativeRecordLoadMs: Number(cached.milliseconds.toFixed(3)),
          nativeRecordStoreMs: Number(stored.milliseconds.toFixed(3)),
        },
      },
    };
  } finally {
    if (ownsSession) {
      const sessionClose = process.hrtime.bigint();
      await session.close();
      if (result) result.native.profile.nativeSessionCloseMs = Number((Number(process.hrtime.bigint() - sessionClose) / 1_000_000).toFixed(3));
    }
  }
  return result;
}

module.exports = {
  NATIVE_MANIFEST_SCHEMA,
  NATIVE_RECORD_CACHE_SCHEMA,
  createNativeIncrementalSession,
  defaultNativeBinary,
  selectNativeBinary,
  scanWithNativeIncremental,
};
