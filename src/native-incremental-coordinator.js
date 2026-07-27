"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRepositoryScanner } = require("./scanner");

const NATIVE_MANIFEST_SCHEMA = "flopeek-native-incremental-manifest/v1";
const NATIVE_RECORD_CACHE_SCHEMA = "flopeek-native-js-record-cache/v1";

function defaultNativeBinary() {
  const name = process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
  const configured = process.env.FLOPEEK_NATIVE_CORE;
  if (configured) return { command: configured, args: [] };
  const debug = path.join(__dirname, "..", "native", "flopeek-core", "target", "debug", name);
  const release = path.join(__dirname, "..", "native", "flopeek-core", "target", "release", name);
  const candidates = [release, debug]
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (candidates.length) return { command: candidates[0], args: [] };
  throw new Error("Native Flopeek binary is unavailable. Build native/flopeek-core first or set FLOPEEK_NATIVE_CORE.");
}

function nativeInvocation(native, command, root, input = null) {
  const resolved = native || defaultNativeBinary();
  const started = process.hrtime.bigint();
  const output = execFileSync(resolved.command, [...(resolved.args || []), command, root], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    input: input === null ? undefined : JSON.stringify(input),
    maxBuffer: 128 * 1024 * 1024,
  });
  try {
    return { payload: JSON.parse(output), milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000 };
  } catch (error) {
    throw new Error(`Native command ${command} returned invalid JSON: ${error.message}`);
  }
}

function assertManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== NATIVE_MANIFEST_SCHEMA || !Array.isArray(manifest.candidatePaths)
    || !Array.isArray(manifest.reusedPaths) || !Array.isArray(manifest.changedPaths) || typeof manifest.projectId !== "string") {
    throw new Error("Native incremental manifest does not satisfy flopeek-native-incremental-manifest/v1.");
  }
}

function loadCachedRecords(root, native, manifest) {
  const response = nativeInvocation(native, "--native-js-record-cache", root, {
    schemaVersion: NATIVE_RECORD_CACHE_SCHEMA,
    operation: "load",
    projectId: manifest.projectId,
    paths: manifest.reusedPaths,
  });
  if (response.payload.schemaVersion !== NATIVE_RECORD_CACHE_SCHEMA || response.payload.operation !== "load" || !Array.isArray(response.payload.records)) {
    throw new Error("Native JS record cache returned an invalid load response.");
  }
  return { records: response.payload.records.map((entry) => entry.record), milliseconds: response.milliseconds };
}

function storeRecords(root, native, manifest, records) {
  const response = nativeInvocation(native, "--native-js-record-cache", root, {
    schemaVersion: NATIVE_RECORD_CACHE_SCHEMA,
    operation: "store",
    projectId: manifest.projectId,
    records: records.map((record) => ({ path: record.relativePath, record })),
  });
  if (response.payload.schemaVersion !== NATIVE_RECORD_CACHE_SCHEMA || response.payload.operation !== "store" || !Number.isInteger(response.payload.storedRecords)) {
    throw new Error("Native JS record cache returned an invalid store response.");
  }
  return { storedRecords: response.payload.storedRecords, milliseconds: response.milliseconds };
}

function scanWithNativeIncremental(inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const native = options.native || defaultNativeBinary();
  const manifestResult = nativeInvocation(native, "--native-incremental-manifest", root);
  const manifest = manifestResult.payload;
  assertManifest(manifest);
  const cached = loadCachedRecords(root, native, manifest);
  const cachedRecords = cached.records;
  const scanner = createRepositoryScanner(root, {
    initialFilePlan: manifest.candidatePaths,
    initialRecords: cachedRecords,
    persistIdentity: options.persistIdentity,
    onProfile: options.onProfile,
  });
  const graph = scanner.scan();
  const stored = storeRecords(root, native, manifest, scanner.snapshotRecords());
  return {
    graph,
    native: {
      manifest: {
        candidateFiles: manifest.candidateFiles,
        changedFiles: manifest.changedPaths.length,
        reusedFiles: manifest.reusedPaths.length,
        removedFiles: manifest.removedPaths.length,
        sourceFingerprint: manifest.sourceFingerprint,
      },
      loadedRecords: cachedRecords.length,
      storedRecords: stored.storedRecords,
      profile: {
        nativeManifestMs: Number(manifestResult.milliseconds.toFixed(3)),
        nativeRecordLoadMs: Number(cached.milliseconds.toFixed(3)),
        nativeRecordStoreMs: Number(stored.milliseconds.toFixed(3)),
      },
    },
  };
}

module.exports = {
  NATIVE_MANIFEST_SCHEMA,
  NATIVE_RECORD_CACHE_SCHEMA,
  defaultNativeBinary,
  scanWithNativeIncremental,
};
