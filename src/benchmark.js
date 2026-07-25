const { createRepositoryScanner, scanRepository } = require("./scanner");
const { execFileSync } = require("node:child_process");

function benchmarkGitMetadata(root, fallback) {
  const command = (args) => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  return {
    branch: command(["branch", "--show-current"]) || fallback.branch,
    revision: command(["rev-parse", "--short", "HEAD"]) || fallback.revision,
    shallow: command(["rev-parse", "--is-shallow-repository"]) === "true",
  };
}

function elapsedMilliseconds(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function measure(action) {
  const startedAt = process.hrtime.bigint();
  const value = action();
  return { value, milliseconds: elapsedMilliseconds(startedAt) };
}

function benchmarkRepository(inputRoot, { iterations = 3 } = {}) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error("Benchmark iterations must be an integer from 1 to 20.");
  const scanner = createRepositoryScanner(inputRoot, { persistIdentity: false });
  const initial = measure(() => scanner.scan());
  const files = initial.value.nodes.filter((node) => node.kind === "file");
  const candidate = files.find((node) => node.analysis?.status?.startsWith("parsed")) || files[0];
  if (!candidate) throw new Error("No supported source files were found to benchmark.");

  const incrementalRuns = [];
  const fullRuns = [];
  let refresh = null;
  for (let index = 0; index < iterations; index += 1) {
    const incremental = measure(() => scanner.scan([candidate.path]));
    incrementalRuns.push(incremental.milliseconds);
    refresh = incremental.value.analysis.refresh;
    fullRuns.push(measure(() => scanRepository(inputRoot, { persistIdentity: false })).milliseconds);
  }
  const incrementalMedianMs = median(incrementalRuns);
  const fullMedianMs = median(fullRuns);
  return {
    benchmark: "flowpeek-incremental-scan/v1",
    project: { ...initial.value.project, git: benchmarkGitMetadata(scanner.root, initial.value.project.git) },
    iterations,
    selectedPath: candidate.path,
    sourceFiles: initial.value.stats.scannedFiles,
    parsedFiles: initial.value.stats.parsedFiles,
    parserCoverage: initial.value.analysis.coverage,
    initialScanMs: rounded(initial.milliseconds),
    fullRescanMs: { median: rounded(fullMedianMs), samples: fullRuns.map(rounded) },
    incrementalRescanMs: { median: rounded(incrementalMedianMs), samples: incrementalRuns.map(rounded) },
    speedupVsFull: rounded(fullMedianMs / Math.max(incrementalMedianMs, Number.EPSILON)),
    refresh,
    interpretation: "This is a local CPU-time comparison on one unchanged supported source file. It measures parser-fact reuse, not graph precision, runtime behavior, or a universal performance guarantee.",
  };
}

function printBenchmark(result) {
  console.log(`${result.project.name} (${result.project.git.branch}${result.project.git.revision ? ` @ ${result.project.git.revision}` : ""})`);
  console.log(`${result.sourceFiles} source files / ${result.parsedFiles} AST-parsed / ${result.iterations} samples`);
  console.log(`Selected source: ${result.selectedPath}`);
  console.log(`Full reparse median: ${result.fullRescanMs.median} ms`);
  console.log(`Incremental median: ${result.incrementalRescanMs.median} ms (${result.speedupVsFull}x versus full)`);
}

module.exports = { benchmarkRepository, printBenchmark };
