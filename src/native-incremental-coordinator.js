"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { NATIVE_PROTOCOL_VERSION, NativeProtocolClient } = require("./native-protocol-client");
const { createRepositoryScanner } = require("./scanner");
const { nativePlatformPackageName, nativePlatformTarget } = require("./native-platform-targets");
const { canonicalRealpath } = require("./canonical-path");

const NATIVE_MANIFEST_SCHEMA = "flopeek-native-incremental-manifest/v1";
const NATIVE_RECORD_CACHE_SCHEMA = "flopeek-native-js-record-cache/v1";

function resolvePlatformNativeBinary(resolve = require.resolve, platform = process.platform, arch = process.arch) {
  const packageName = nativePlatformPackageName(platform, arch);
  if (!packageName) return null;
  try {
    const name = platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
    return resolve(`${packageName}/bin/${name}`);
  } catch {
    return null;
  }
}

function readPlatformNativePackageMetadata(
  resolve = require.resolve,
  readFile = fs.readFileSync,
  platform = process.platform,
  arch = process.arch,
) {
  const packageName = nativePlatformPackageName(platform, arch);
  const platformTarget = nativePlatformTarget(platform, arch);
  if (!packageName) return null;
  try {
    const manifest = JSON.parse(readFile(resolve(`${packageName}/package.json`), "utf8"));
    const metadata = manifest.flopeekNative;
    if (manifest.name !== packageName
      || !Array.isArray(manifest.os) || !manifest.os.includes(platform)
      || !Array.isArray(manifest.cpu) || !manifest.cpu.includes(arch)
      || !metadata || metadata.protocolVersion !== NATIVE_PROTOCOL_VERSION
      || typeof metadata.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.binarySha256)
      || typeof metadata.repositoryRevision !== "string" || !/^[a-f0-9]{40,64}$/.test(metadata.repositoryRevision)
      || typeof metadata.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sourceDigest)
      || metadata.target !== platformTarget?.rustTarget
      || typeof metadata.compiler?.version !== "string" || !metadata.compiler.version) {
      return null;
    }
    return Object.freeze({
      packageName,
      version: manifest.version,
      binarySha256: metadata.binarySha256,
      repositoryRevision: metadata.repositoryRevision,
      sourceDigest: metadata.sourceDigest,
      compiler: Object.freeze({ ...metadata.compiler }),
      target: metadata.target,
    });
  } catch {
    return null;
  }
}

function verifyPlatformNativeBinary(binary, metadata, readFile = fs.readFileSync) {
  if (!binary || !metadata?.binarySha256) return false;
  try {
    const actual = createHash("sha256").update(readFile(binary)).digest("hex");
    return actual === metadata.binarySha256;
  } catch {
    return false;
  }
}

function selectNativeBinary({ configured, platform, release, debug }, exists = fs.existsSync) {
  if (configured) return { command: configured, args: [] };
  if (platform && exists(platform)) return { command: platform, args: [] };
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
  const platform = resolvePlatformNativeBinary();
  const platformMetadata = platform ? readPlatformNativePackageMetadata() : null;
  const selected = selectNativeBinary({
    configured: process.env.FLOPEEK_NATIVE_CORE,
    platform: platformMetadata && verifyPlatformNativeBinary(platform, platformMetadata) ? platform : null,
    release: path.join(__dirname, "..", "native", "flopeek-core", "target", "release", name),
    debug: path.join(__dirname, "..", "native", "flopeek-core", "target", "debug", name),
  });
  if (selected) return selected;
  throw new Error("Native Flopeek binary is unavailable. Install the matching @flopeek/native platform package, build native/flopeek-core, or set FLOPEEK_NATIVE_CORE.");
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
  const root = canonicalRealpath(inputRoot);
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
  nativePlatformPackageName,
  readPlatformNativePackageMetadata,
  verifyPlatformNativeBinary,
  resolvePlatformNativeBinary,
  selectNativeBinary,
  scanWithNativeIncremental,
};
