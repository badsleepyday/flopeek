"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { copyRepository } = require("./benchmark-native-incremental");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { scanWithNativeIncremental } = require("../src/native-incremental-coordinator");
const { createRepositoryScanner } = require("../src/scanner");

function profileScanner(root) {
  const profile = [];
  const scanner = createRepositoryScanner(root, { onProfile: (entry) => profile.push(entry) });
  const graph = scanner.scan();
  return { graph, profile };
}

function main() {
  const source = path.resolve(process.argv[2] || "");
  if (!source || !fs.existsSync(source)) throw new Error("Supply an existing repository path.");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-incremental-profile-"));
  try {
    const jsRoot = path.join(sandbox, "js");
    const nativeRoot = path.join(sandbox, "native");
    copyRepository(source, jsRoot);
    copyRepository(source, nativeRoot);
    profileScanner(jsRoot);
    scanWithNativeIncremental(nativeRoot);
    const js = profileScanner(jsRoot);
    const nativeProfile = [];
    const native = scanWithNativeIncremental(nativeRoot, { onProfile: (entry) => nativeProfile.push(entry) });
    assert.equal(createCoreCompatibilityDigest(native.graph), createCoreCompatibilityDigest(js.graph), "Profiled native result diverged from the JS compatibility oracle.");
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "flopeek-native-incremental-profile/v1",
      mode: "unchanged-cross-process-cache",
      repository: path.basename(source),
      compatibilityDigest: createCoreCompatibilityDigest(js.graph),
      javascript: { phases: js.profile },
      native: { phases: nativeProfile, bridge: native.native.profile, manifest: native.native.manifest },
      limitation: "This is one-host phase telemetry on isolated copies. It identifies measured scan phases, not universal bottlenecks or runtime behavior.",
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) main();
