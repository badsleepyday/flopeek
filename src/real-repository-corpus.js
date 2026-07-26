const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { scanRepository } = require("./scanner");

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function scoreFocus(graph, focus) {
  const expected = new Set(focus.expectedTargets);
  const actual = new Set(graph.edges
    .filter((edge) => edge.source === focus.source && edge.type === focus.type)
    .map((edge) => edge.target));
  const falsePositives = setDifference(actual, expected);
  const falseNegatives = setDifference(expected, actual);
  const truePositives = expected.size - falseNegatives.length;
  return {
    label: focus.label,
    source: focus.source,
    type: focus.type,
    expected: expected.size,
    actual: actual.size,
    truePositives,
    falsePositives,
    falseNegatives,
  };
}

function revisionAt(root) {
  try {
    return execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function revisionMatches(actualRevision, expectedRevision) {
  return typeof actualRevision === "string" && typeof expectedRevision === "string" && actualRevision.toLowerCase().startsWith(expectedRevision.toLowerCase());
}

function checkoutArguments(root, revision) {
  return ["-c", `safe.directory=${root}`, "-C", root, "checkout", "--detach", revision];
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renameWithRetry(source, destination, { attempts = 6, delayMs = 250, rename = fs.renameSync, wait = pause } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const retryable = error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
      if (!retryable || attempt === attempts) throw error;
      wait(delayMs);
    }
  }
  throw lastError;
}

function cloneRepositoryAtRevision(repository, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.flopeek-clone-${process.pid}-${Date.now()}`;
  try {
    execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", repository.url, temporary], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    execFileSync("git", checkoutArguments(temporary, repository.revision), { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    // Windows file scanners can transiently keep a fresh checkout open. Retry
    // only those lock-like errors so a completed clone is not discarded.
    renameWithRetry(temporary, destination);
    return destination;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error(`Unable to clone '${repository.id}' at ${repository.revision}: ${error.message}`);
  }
}

function resolveCorpusRepositories(manifest, suppliedRepositories, cloneDirectory = null, cloneRepository = cloneRepositoryAtRevision) {
  const repositories = { ...suppliedRepositories };
  for (const repository of manifest.repositories) {
    if (repositories[repository.id]) continue;
    if (!cloneDirectory) continue;
    const destination = path.join(cloneDirectory, repository.id);
    if (!fs.existsSync(destination)) cloneRepository(repository, destination);
    repositories[repository.id] = destination;
  }
  return repositories;
}

function corpusResult(manifest, results, complete, failure = null) {
  const focuses = results.flatMap((result) => result.focuses);
  const truePositives = focuses.reduce((total, focus) => total + focus.truePositives, 0);
  const falsePositives = focuses.reduce((total, focus) => total + focus.falsePositives.length, 0);
  const falseNegatives = focuses.reduce((total, focus) => total + focus.falseNegatives.length, 0);
  return {
    corpus: manifest.name,
    complete,
    repositories: results,
    completedRepositories: results.length,
    totalRepositories: manifest.repositories.length,
    auditedRelationships: truePositives + falseNegatives,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: truePositives / Math.max(truePositives + falsePositives, 1),
    recall: truePositives / Math.max(truePositives + falseNegatives, 1),
    failure,
    interpretation: "Precision and recall apply only to completed manually audited, exact outgoing relationships in this pinned external-repository corpus. A partial result is not a corpus pass and does not measure every repository relationship or runtime behavior.",
  };
}

function scanRepositoryWithTimeout(root, repository, timeoutMs) {
  const worker = path.join(__dirname, "corpus-scan-worker.js");
  const focusInput = Buffer.from(JSON.stringify(repository.focuses), "utf8").toString("base64url");
  const result = spawnSync(process.execPath, [worker, root, focusInput], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") throw Object.assign(new Error(`Static scan exceeded the ${timeoutMs} ms per-repository timeout.`), { code: "corpus-scan-timeout" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || `Corpus scan worker exited with status ${result.status}.`).trim());
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Corpus scan worker returned invalid JSON: ${error.message}`);
  }
}

function validateRealRepositoryCorpus(manifest, repositories, options = {}) {
  const scan = options.scanRepository || scanRepository;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const results = [];
  for (let repositoryIndex = 0; repositoryIndex < manifest.repositories.length; repositoryIndex += 1) {
    const repository = manifest.repositories[repositoryIndex];
    const root = repositories[repository.id];
    try {
      if (!root) throw new Error(`Missing local checkout for corpus repository '${repository.id}'.`);
      const resolvedRoot = fs.realpathSync(root);
      const revision = revisionAt(resolvedRoot);
      if (!revisionMatches(revision, repository.revision)) throw new Error(`Corpus repository '${repository.id}' is at ${revision || "an unknown revision"}; expected ${repository.revision}.`);
      onProgress({ phase: "scan-start", repository: repository.id, repositoryIndex, totalRepositories: manifest.repositories.length });
      const startedAt = Date.now();
      const graph = scan(resolvedRoot, repository);
      onProgress({ phase: "scan-complete", repository: repository.id, repositoryIndex, totalRepositories: manifest.repositories.length, durationMs: Date.now() - startedAt, stats: graph.stats || null });
      const focuses = repository.focuses.map((focus, focusIndex) => {
        const score = scoreFocus(graph, focus);
        onProgress({ phase: "scope-complete", repository: repository.id, repositoryIndex, totalRepositories: manifest.repositories.length, focusIndex, totalFocuses: repository.focuses.length, label: focus.label, passed: score.falsePositives.length === 0 && score.falseNegatives.length === 0 });
        return score;
      });
      results.push({ id: repository.id, project: graph.project.name, revision: repository.revision, durationMs: Date.now() - startedAt, focuses });
    } catch (error) {
      const result = corpusResult(manifest, results, false, { repository: repository.id, code: error.code || "corpus-repository-failed", message: error.message });
      throw Object.assign(new Error(`Corpus repository '${repository.id}' failed: ${error.message}`), { code: error.code || "corpus-repository-failed", result });
    }
  }
  const result = corpusResult(manifest, results, true);
  if (result.falsePositives || result.falseNegatives) throw Object.assign(new Error("Real-repository corpus quality gate failed."), { result });
  return result;
}

function parseArguments(argv) {
  const repositories = {};
  let format = "summary";
  let cloneDirectory = null;
  let timeoutMs = 300_000;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repository") {
      const [id, root] = String(argv[++index] || "").split(/=(.*)/s);
      if (!id || !root) throw new Error("--repository must use id=path.");
      repositories[id] = path.resolve(root);
    } else if (value === "--format") {
      format = argv[++index] || format;
    } else if (value === "--clone-directory") {
      const directory = argv[++index];
      if (!directory) throw new Error("--clone-directory requires a path.");
      cloneDirectory = path.resolve(directory);
    } else if (value === "--timeout-ms") {
      timeoutMs = Number(argv[++index]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) throw new Error("--timeout-ms must be an integer between 1000 and 900000.");
    } else {
      throw new Error(`Unknown corpus option: ${value}`);
    }
  }
  return { repositories, format, cloneDirectory, timeoutMs };
}

function printSummary(result) {
  console.log(`${result.corpus}: ${result.complete ? "complete" : "partial"} (${result.completedRepositories}/${result.totalRepositories} repositories)`);
  console.log(`${result.truePositives}/${result.auditedRelationships} audited relationships matched`);
  console.log(`Precision ${(result.precision * 100).toFixed(1)}% / recall ${(result.recall * 100).toFixed(1)}% within the pinned audited slice`);
  for (const repository of result.repositories) console.log(`${repository.id} @ ${repository.revision}: ${repository.focuses.length} audited source scopes`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestPath = path.join(__dirname, "..", "benchmarks", "real-repository-corpus.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const repositories = resolveCorpusRepositories(manifest, options.repositories, options.cloneDirectory);
  const onProgress = options.format === "summary" ? (event) => {
    if (event.phase === "scan-start") process.stderr.write(`[${event.repositoryIndex + 1}/${event.totalRepositories}] scanning ${event.repository}...\n`);
    if (event.phase === "scan-complete") process.stderr.write(`[${event.repositoryIndex + 1}/${event.totalRepositories}] scanned ${event.repository} in ${(event.durationMs / 1000).toFixed(2)}s\n`);
    if (event.phase === "scope-complete") process.stderr.write(`  [${event.focusIndex + 1}/${event.totalFocuses}] ${event.passed ? "pass" : "fail"}: ${event.label}\n`);
  } : null;
  const result = validateRealRepositoryCorpus(manifest, repositories, {
    scanRepository: (root, repository) => scanRepositoryWithTimeout(root, repository, options.timeoutMs),
    onProgress,
  });
  if (options.format === "json") console.log(JSON.stringify(result, null, 2));
  else if (options.format === "summary") printSummary(result);
  else throw new Error("Corpus output supports summary or json formats.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error.result) console.error(JSON.stringify(error.result, null, 2));
    console.error(`Unable to validate real-repository corpus: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkoutArguments, cloneRepositoryAtRevision, corpusResult, parseArguments, renameWithRetry, resolveCorpusRepositories, revisionMatches, scanRepositoryWithTimeout, scoreFocus, validateRealRepositoryCorpus };
