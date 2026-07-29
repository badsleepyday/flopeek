"use strict";

// Phase telemetry for the same ScanCoordinator authority lifecycle measured by
// benchmark-native-core-client. It intentionally uses disposable copies so a
// profiling run never creates Flopeek metadata or modifies a source corpus.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCoreCompatibilityDigest } = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createScanCoordinator } = require("../src/scan-coordinator");
const { copyRepository, sourceFiles } = require("./benchmark-native-incremental");
const { releaseNativeOptions, stateRequest } = require("./benchmark-native-core-client");

function elapsed(operation) {
  const started = process.hrtime.bigint();
  return Promise.resolve(operation()).then((result) => ({
    result,
    milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
  }));
}

async function profileState(coordinator, request, phases) {
  const phaseStart = phases.length;
  const scan = await elapsed(() => coordinator.refresh(request.changedPaths, request.reason));
  assert.equal(scan.result.outcome.status, "complete", scan.result.outcome.failure?.message || "Profile coordinator scan failed.");
  return { milliseconds: Number(scan.milliseconds.toFixed(3)), phases: phases.slice(phaseStart), graph: scan.result.graph };
}

async function main() {
  const source = path.resolve(process.argv[2] || "");
  if (!source || !fs.statSync(source).isDirectory()) throw new Error("Supply an existing repository path.");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-native-core-profile-"));
  const jsRoot = path.join(sandbox, "javascript");
  const nativeRoot = path.join(sandbox, "native");
  copyRepository(source, jsRoot);
  copyRepository(source, nativeRoot);
  const javascript = createJsCoreClient();
  const native = createNativeCoreClient({ nativeOptions: releaseNativeOptions() });
  const javascriptPhases = [];
  const nativePhases = [];
  const javascriptCoordinator = createScanCoordinator(jsRoot, { cache: true, coreClient: javascript, onCoreProfile: (entry) => javascriptPhases.push(entry) });
  const nativeCoordinator = createScanCoordinator(nativeRoot, { cache: true, coreClient: native, onCoreProfile: (entry) => nativePhases.push(entry) });
  try {
    const states = {};
    for (const [state, mutate] of [
      ["cold", null],
      ["unchanged", null],
      ["oneFileChange", (root) => {
        const file = sourceFiles(root)[0];
        fs.appendFileSync(file, "\n");
        return path.relative(root, file).replaceAll("\\", "/");
      }],
    ]) {
      const jsChangedPath = mutate?.(jsRoot) || null;
      const nativeChangedPath = mutate?.(nativeRoot) || null;
      assert.equal(nativeChangedPath, jsChangedPath, "Disposable profile copies must mutate the same relative path.");
      const request = stateRequest(state, jsChangedPath);
      const js = await profileState(javascriptCoordinator, request, javascriptPhases);
      const nativeResult = await profileState(nativeCoordinator, request, nativePhases);
      assert.equal(
        createCoreCompatibilityDigest(nativeResult.graph),
        createCoreCompatibilityDigest(js.graph),
        `Native CoreClient diverged from JavaScript during ${state}.`,
      );
      assert.deepEqual(nativeResult.graph.stats, js.graph.stats, `Native CoreClient statistics diverged during ${state}.`);
      states[state] = {
        javascriptMs: js.milliseconds,
        nativeMs: nativeResult.milliseconds,
        javascriptPhases: js.phases,
        nativePhases: nativeResult.phases,
      };
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "flopeek-native-core-profile/v1",
      repository: path.basename(source),
      states,
      parity: "Every profiled state has exact flopeek-core-compatibility/v1 digest and graph-statistics parity.",
      limitation: "One isolated profile run identifies local phase cost; it is not a performance median or cutover proof.",
    }, null, 2)}\n`);
  } finally {
    await native.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = { profileState };
