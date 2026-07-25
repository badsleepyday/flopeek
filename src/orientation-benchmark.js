"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageInfo = require("../package.json");
const { createContextRef } = require("./context-card");
const { findNodes, getRelatedTests, getRequestFlows, resolveContextRef } = require("./graph-service");
const { getFlowProjection: buildFlowProjection } = require("./flow-lens");
const { createRepositoryScanner, scanRepository, writeGraphCache } = require("./scanner");

const ORIENTATION_CASES_SCHEMA = "flopeek-orientation-cases/v1";
const ORIENTATION_REPORT_SCHEMA = "flopeek-orientation-benchmark/v2";
const ORIENTATION_COMPARISON_SCHEMA = "flopeek-orientation-comparison/v2";
const TOKEN_ESTIMATOR = "flopeek-char4-estimator/v1";
const CONDITIONS = new Set(["direct-repository", "flopeek"]);
const IGNORED_DIRECTORIES = new Set([".flopeek", ".flowpeek", ".git", ".next", ".nuxt", ".turbo", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"]);
const MAX_REPOSITORIES = 20;
const MAX_CASES_PER_REPOSITORY = 50;
const MAX_TEXT_FILES = 10_000;
const MAX_TEXT_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_CANDIDATE_LIMIT = 12;

class OrientationBenchmarkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OrientationBenchmarkError";
    this.code = code;
  }
}

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function portableId(value, field) {
  if (typeof value !== "string" || !value.length || value.length > 100) throw new OrientationBenchmarkError("invalid-id", `${field} must be a non-empty portable identifier.`);
  const valid = [...value].every((character, index) => {
    const lower = character.toLowerCase();
    const alphaNumeric = lower >= "a" && lower <= "z" || character >= "0" && character <= "9";
    return alphaNumeric || index > 0 && [".", "_", "-"].includes(character);
  });
  if (!valid) throw new OrientationBenchmarkError("invalid-id", `${field} must contain only letters, digits, dots, underscores, or hyphens and must start with a letter or digit.`);
  return value;
}

function stringList(value, field, options = {}) {
  const limit = options.limit || 100;
  if (!Array.isArray(value) || (options.allowEmpty !== true && value.length === 0) || value.length > limit || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new OrientationBenchmarkError("invalid-string-list", `${field} must be ${options.allowEmpty ? "an" : "a non-empty"} array of at most ${limit} non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function resolveInside(root, relative, field) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative)) throw new OrientationBenchmarkError("invalid-relative-path", `${field} must be a repository-relative path.`);
  const target = path.resolve(root, ...relative.split("/").filter(Boolean));
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new OrientationBenchmarkError("path-outside-suite", `${field} resolves outside the selected suite root.`);
  return target;
}

function normalizeDefinition(input, suiteRoot) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== ORIENTATION_CASES_SCHEMA) throw new OrientationBenchmarkError("invalid-cases-schema", `Cases must use ${ORIENTATION_CASES_SCHEMA}.`);
  if (!Array.isArray(input.repositories) || !input.repositories.length || input.repositories.length > MAX_REPOSITORIES) throw new OrientationBenchmarkError("invalid-repositories", `repositories must contain 1 to ${MAX_REPOSITORIES} entries.`);
  const repositoryIds = new Set();
  const caseIds = new Set();
  const repositories = input.repositories.map((item, repositoryIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new OrientationBenchmarkError("invalid-repository", `repositories[${repositoryIndex}] must be an object.`);
    const id = portableId(item.id, `repositories[${repositoryIndex}].id`);
    if (repositoryIds.has(id)) throw new OrientationBenchmarkError("duplicate-repository", `Duplicate repository id: ${id}`);
    repositoryIds.add(id);
    const repositoryRoot = resolveInside(suiteRoot, item.path, `${id}.path`);
    if (!fs.existsSync(repositoryRoot) || !fs.statSync(repositoryRoot).isDirectory()) throw new OrientationBenchmarkError("missing-repository", `Repository fixture does not exist: ${item.path}`);
    if (!item.sourcePin || item.sourcePin.kind !== "tree-sha256" || typeof item.sourcePin.value !== "string" || item.sourcePin.value.length !== 64) throw new OrientationBenchmarkError("invalid-source-pin", `${id}.sourcePin must declare a 64-character tree-sha256 value.`);
    if (!Array.isArray(item.cases) || !item.cases.length || item.cases.length > MAX_CASES_PER_REPOSITORY) throw new OrientationBenchmarkError("invalid-cases", `${id}.cases must contain 1 to ${MAX_CASES_PER_REPOSITORY} entries.`);
    const cases = item.cases.map((benchmarkCase, caseIndex) => {
      if (!benchmarkCase || typeof benchmarkCase !== "object" || Array.isArray(benchmarkCase)) throw new OrientationBenchmarkError("invalid-case", `${id}.cases[${caseIndex}] must be an object.`);
      const caseId = portableId(benchmarkCase.id, `${id}.cases[${caseIndex}].id`);
      if (caseIds.has(caseId)) throw new OrientationBenchmarkError("duplicate-case", `Case ids must be unique across the suite: ${caseId}`);
      caseIds.add(caseId);
      if (typeof benchmarkCase.task !== "string" || !benchmarkCase.task.trim() || benchmarkCase.task.length > 2000) throw new OrientationBenchmarkError("invalid-task", `${caseId}.task must be a non-empty string of at most 2000 characters.`);
      const request = benchmarkCase.request || {};
      const expected = benchmarkCase.expected || {};
      const staleContext = benchmarkCase.staleContext || null;
      if (staleContext && (typeof staleContext.nodeId !== "string" || typeof staleContext.changedPath !== "string")) throw new OrientationBenchmarkError("invalid-stale-context", `${caseId}.staleContext requires nodeId and changedPath.`);
      return {
        id: caseId,
        task: benchmarkCase.task.trim(),
        request: {
          searchTerms: stringList(request.searchTerms, `${caseId}.request.searchTerms`, { limit: 20 }),
          flowQuery: typeof request.flowQuery === "string" && request.flowQuery.trim() ? request.flowQuery.trim() : null,
          candidateLimit: Number.isSafeInteger(request.candidateLimit) && request.candidateLimit >= 1 && request.candidateLimit <= 50 ? request.candidateLimit : DEFAULT_CANDIDATE_LIMIT,
        },
        expected: {
          targetPaths: stringList(expected.targetPaths, `${caseId}.expected.targetPaths`, { limit: 50 }),
          flowStepIds: stringList(expected.flowStepIds, `${caseId}.expected.flowStepIds`, { limit: 100 }),
          relatedTestPaths: stringList(expected.relatedTestPaths || [], `${caseId}.expected.relatedTestPaths`, { limit: 50, allowEmpty: true }),
        },
        staleContext: staleContext ? { nodeId: staleContext.nodeId, changedPath: portablePath(staleContext.changedPath) } : null,
      };
    });
    const retrievalExclusions = stringList(item.retrievalExclusions || [], `${id}.retrievalExclusions`, { limit: 100, allowEmpty: true }).map((itemPath) => portablePath(itemPath));
    return { id, declaredPath: portablePath(item.path), root: repositoryRoot, sourcePin: item.sourcePin, retrievalExclusions, cases };
  });
  return { schemaVersion: ORIENTATION_CASES_SCHEMA, suiteId: portableId(input.suiteId, "suiteId"), repositories };
}

function repositoryFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative: portablePath(path.relative(root, absolute)) });
      if (files.length > MAX_TEXT_FILES) throw new OrientationBenchmarkError("repository-too-large", `The deterministic orientation harness supports at most ${MAX_TEXT_FILES} text files per repository.`);
    }
  };
  visit(root);
  return files;
}

function treeSha256(root) {
  const hash = crypto.createHash("sha256");
  for (const file of repositoryFiles(root)) {
    hash.update(file.relative);
    hash.update("\0");
    const content = fs.readFileSync(file.absolute);
    hash.update(content.includes(0) ? content : Buffer.from(content.toString("utf8").split("\r\n").join("\n"), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readTextInventory(root, excludedPaths = []) {
  const excluded = new Set(excludedPaths.map(portablePath));
  const items = [];
  let totalBytes = 0;
  for (const file of repositoryFiles(root)) {
    if (excluded.has(file.relative)) continue;
    const buffer = fs.readFileSync(file.absolute);
    if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) continue;
    totalBytes += buffer.length;
    if (totalBytes > MAX_TEXT_BYTES) throw new OrientationBenchmarkError("repository-too-large", `The deterministic orientation harness supports at most ${MAX_TEXT_BYTES} readable bytes per repository.`);
    items.push({ ...file, bytes: buffer.length, text: buffer.toString("utf8") });
  }
  return { items, totalBytes };
}

function occurrences(text, term) {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(term, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(term.length, 1);
  }
  return count;
}

function isTestPath(relative) {
  const lower = relative.toLowerCase();
  return lower.includes("/test/") || lower.startsWith("test/") || lower.includes("/tests/") || lower.includes(".test.") || lower.includes(".spec.") || lower.endsWith("_test.py") || lower.endsWith("_test.go");
}

function directCandidates(inventory, benchmarkCase) {
  const terms = benchmarkCase.request.searchTerms.map((term) => term.toLowerCase());
  return inventory.items.map((file) => {
    const lowerPath = file.relative.toLowerCase();
    const lowerText = file.text.toLowerCase();
    const pathMatches = terms.reduce((sum, term) => sum + (lowerPath.includes(term) ? 1 : 0), 0);
    const contentMatches = terms.reduce((sum, term) => sum + Math.min(occurrences(lowerText, term), 10), 0);
    return { path: file.relative, score: pathMatches * 20 + contentMatches, bytes: file.bytes, text: file.text };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, benchmarkCase.request.candidateLimit);
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean).map(portablePath))].sort();
}

function estimateTokens(characters) {
  return Math.ceil(characters / 4);
}

function intersection(expected, actual) {
  const found = new Set(actual);
  return expected.filter((item) => found.has(item));
}

function longestOrderedMatch(expected, actual) {
  const rows = Array.from({ length: expected.length + 1 }, () => Array(actual.length + 1).fill(0));
  for (let left = 1; left <= expected.length; left += 1) {
    for (let right = 1; right <= actual.length; right += 1) rows[left][right] = expected[left - 1] === actual[right - 1] ? rows[left - 1][right - 1] + 1 : Math.max(rows[left - 1][right], rows[left][right - 1]);
  }
  return rows[expected.length][actual.length];
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : null;
}

function scoreCase(benchmarkCase, observation) {
  const targetMatches = intersection(benchmarkCase.expected.targetPaths, observation.targetPaths);
  const testMatches = intersection(benchmarkCase.expected.relatedTestPaths, observation.relatedTestPaths);
  const flowAvailable = Array.isArray(observation.flowStepIds);
  const orderedFlowMatches = flowAvailable ? longestOrderedMatch(benchmarkCase.expected.flowStepIds, observation.flowStepIds) : 0;
  const returnedExpectedFlowSteps = flowAvailable ? intersection(observation.flowStepIds, benchmarkCase.expected.flowStepIds).length : 0;
  return {
    correctTargetRetrieval: { matched: targetMatches.length, expected: benchmarkCase.expected.targetPaths.length, recall: ratio(targetMatches.length, benchmarkCase.expected.targetPaths.length), missing: benchmarkCase.expected.targetPaths.filter((item) => !targetMatches.includes(item)) },
    flowSteps: flowAvailable ? {
      status: "measured",
      matchedInExpectedOrder: orderedFlowMatches,
      expected: benchmarkCase.expected.flowStepIds.length,
      returned: observation.flowStepIds.length,
      recall: ratio(orderedFlowMatches, benchmarkCase.expected.flowStepIds.length),
      precision: ratio(returnedExpectedFlowSteps, observation.flowStepIds.length),
      exactOrderMatch: orderedFlowMatches === benchmarkCase.expected.flowStepIds.length && observation.flowStepIds.length === benchmarkCase.expected.flowStepIds.length,
    } : { status: "unavailable", matchedInExpectedOrder: null, expected: benchmarkCase.expected.flowStepIds.length, returned: null, recall: null, precision: null, exactOrderMatch: null, reason: "Direct lexical retrieval does not produce relationship order; scoring it as a flow would invent evidence." },
    relatedTests: { matched: testMatches.length, expected: benchmarkCase.expected.relatedTestPaths.length, recall: ratio(testMatches.length, benchmarkCase.expected.relatedTestPaths.length), missing: benchmarkCase.expected.relatedTestPaths.filter((item) => !testMatches.includes(item)) },
    staleContextDetection: observation.staleContextDetection,
    context: { filesInspected: observation.contextFiles.length, paths: observation.contextFiles, estimatedCharacters: observation.estimatedCharacters, estimatedTokens: estimateTokens(observation.estimatedCharacters), tokenizerId: TOKEN_ESTIMATOR },
    timing: observation.timing,
    unsupportedClaims: { status: "no-claims-emitted", evaluated: 0, unsupported: 0, rate: null, reason: "The deterministic harness emits retrieval evidence rather than natural-language runtime or business claims." },
  };
}

function directObservation(inventory, benchmarkCase, preparationMilliseconds) {
  const started = process.hrtime.bigint();
  const candidates = directCandidates(inventory, benchmarkCase);
  const retrievalMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  const contextFiles = candidates.map((item) => item.path);
  return {
    targetPaths: contextFiles,
    flowStepIds: null,
    relatedTestPaths: contextFiles.filter(isTestPath),
    contextFiles,
    estimatedCharacters: candidates.reduce((sum, item) => sum + item.text.length, 0),
    repositoryFilesProcessed: inventory.items.length,
    staleContextDetection: benchmarkCase.staleContext ? { status: "unsupported", requested: 1, detected: null, rate: null, reason: "The direct lexical condition has no versioned Context Ref contract." } : { status: "not-requested", requested: 0, detected: null, rate: null },
    timing: {
      preparationMilliseconds: Number(preparationMilliseconds.toFixed(3)),
      sharedRepositoryPreparationMilliseconds: Number(preparationMilliseconds.toFixed(3)),
      retrievalMilliseconds: Number(retrievalMilliseconds.toFixed(3)),
      coldTimeToUsefulContextMilliseconds: Number((preparationMilliseconds + retrievalMilliseconds).toFixed(3)),
      warmTimeToUsefulContextMilliseconds: Number(retrievalMilliseconds.toFixed(3)),
      gating: false,
    },
  };
}

function flopeekObservation(graph, benchmarkCase, preparationMilliseconds) {
  const started = process.hrtime.bigint();
  const nodeResults = benchmarkCase.request.searchTerms.flatMap((term) => findNodes(graph, { query: term, scope: "application" }).results || []);
  const boundedNodeResults = [];
  const seenNodeIds = new Set();
  for (const result of nodeResults) {
    if (seenNodeIds.has(result.id)) continue;
    seenNodeIds.add(result.id);
    boundedNodeResults.push(result);
    if (boundedNodeResults.length === benchmarkCase.request.candidateLimit) break;
  }
  const flowMatches = getRequestFlows(graph, benchmarkCase.request.flowQuery || "", "application").flows;
  const selectedFlow = flowMatches[0] || null;
  const lens = selectedFlow ? buildFlowProjection(graph, selectedFlow.id, "application", { maxSteps: 24 }) : null;
  const relatedTests = [];
  const filesByPath = new Map(graph.nodes.filter((node) => node.kind === "file" && node.path).map((node) => [node.path, node]));
  for (const step of lens?.steps || []) {
    const testSubjects = [step.node.id];
    if (step.node.path) {
      const containingFile = filesByPath.get(step.node.path);
      if (containingFile) testSubjects.push(containingFile.id);
    }
    for (const subjectId of new Set(testSubjects)) {
      const result = getRelatedTests(graph, subjectId);
      for (const relation of result?.relatedTests || []) relatedTests.push(relation.test.path);
    }
  }
  const targetPaths = uniquePaths([...boundedNodeResults.map((item) => item.path), ...(lens?.steps || []).map((step) => step.node.path)]);
  const relatedTestPaths = uniquePaths(relatedTests);
  const contextFiles = uniquePaths([...targetPaths, ...relatedTestPaths]);
  const flowStepIds = lens ? lens.steps.map((step) => step.node.id) : [];
  const contextPayload = {
    nodes: nodeResults.slice(0, benchmarkCase.request.candidateLimit).map((node) => ({ id: node.id, label: node.label, path: node.path, type: node.type })),
    flow: lens ? { id: lens.flow.id, title: lens.flow.title, steps: lens.steps.map((step) => ({ id: step.node.id, path: step.node.path, role: step.role, evidence: step.transitionEvidence || null })) } : null,
    relatedTestPaths,
  };
  const retrievalMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    targetPaths,
    flowStepIds,
    relatedTestPaths,
    contextFiles,
    estimatedCharacters: JSON.stringify(contextPayload).length,
    repositoryFilesProcessed: graph.stats?.scannedFiles || 0,
    staleContextDetection: { status: benchmarkCase.staleContext ? "pending-probe" : "not-requested", requested: benchmarkCase.staleContext ? 1 : 0, detected: null, rate: null },
    timing: {
      preparationMilliseconds: Number(preparationMilliseconds.toFixed(3)),
      sharedRepositoryPreparationMilliseconds: Number(preparationMilliseconds.toFixed(3)),
      retrievalMilliseconds: Number(retrievalMilliseconds.toFixed(3)),
      coldTimeToUsefulContextMilliseconds: Number((preparationMilliseconds + retrievalMilliseconds).toFixed(3)),
      warmTimeToUsefulContextMilliseconds: Number(retrievalMilliseconds.toFixed(3)),
      gating: false,
    },
  };
}

function copyRepository(source, destination) {
  fs.cpSync(source, destination, { recursive: true, filter: (entry) => !IGNORED_DIRECTORIES.has(path.basename(entry)) });
}

function staleProbe(repositoryRoot, benchmarkCase) {
  if (!benchmarkCase.staleContext) return { status: "not-requested", requested: 0, detected: null, rate: null };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-orientation-stale-"));
  try {
    copyRepository(repositoryRoot, temporaryRoot);
    const scanner = createRepositoryScanner(temporaryRoot);
    const before = scanner.scan();
    writeGraphCache(temporaryRoot, before, { reason: "orientation-stale-baseline" });
    if (!before.nodes.some((node) => node.id === benchmarkCase.staleContext.nodeId)) throw new OrientationBenchmarkError("missing-stale-node", `${benchmarkCase.id} staleContext.nodeId was not found.`);
    const contextRef = createContextRef(before.project.projectId, "node", benchmarkCase.staleContext.nodeId, before.state.graphVersion);
    const changedFile = resolveInside(temporaryRoot, benchmarkCase.staleContext.changedPath, `${benchmarkCase.id}.staleContext.changedPath`);
    if (!fs.existsSync(changedFile)) throw new OrientationBenchmarkError("missing-stale-path", `${benchmarkCase.id} staleContext.changedPath was not found.`);
    fs.appendFileSync(changedFile, "\n");
    const current = scanner.scan([benchmarkCase.staleContext.changedPath]);
    writeGraphCache(temporaryRoot, current, { reason: "orientation-stale-change", changedPaths: [benchmarkCase.staleContext.changedPath] });
    const resolution = resolveContextRef(current, contextRef);
    const detected = ["stale", "historical", "successor-candidate"].includes(resolution.status) ? 1 : 0;
    return { status: "measured", requested: 1, detected, rate: detected, resolutionStatus: resolution.status, contextRefKind: "node", sourceContentsReturned: false };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function aggregateCases(cases, repositories) {
  const sum = (selector) => cases.reduce((total, item) => total + selector(item), 0);
  const targetExpected = sum((item) => item.metrics.correctTargetRetrieval.expected);
  const targetMatched = sum((item) => item.metrics.correctTargetRetrieval.matched);
  const testExpected = sum((item) => item.metrics.relatedTests.expected);
  const testMatched = sum((item) => item.metrics.relatedTests.matched);
  const measuredFlows = cases.filter((item) => item.metrics.flowSteps.status === "measured");
  const flowExpected = measuredFlows.reduce((total, item) => total + item.metrics.flowSteps.expected, 0);
  const flowMatched = measuredFlows.reduce((total, item) => total + item.metrics.flowSteps.matchedInExpectedOrder, 0);
  const staleMeasured = cases.filter((item) => item.metrics.staleContextDetection.status === "measured");
  return {
    caseCount: cases.length,
    correctTargetRetrieval: { matched: targetMatched, expected: targetExpected, recall: ratio(targetMatched, targetExpected) },
    flowSteps: measuredFlows.length ? { status: "measured", casesMeasured: measuredFlows.length, matchedInExpectedOrder: flowMatched, expected: flowExpected, recall: ratio(flowMatched, flowExpected), exactCaseMatches: measuredFlows.filter((item) => item.metrics.flowSteps.exactOrderMatch).length } : { status: "unavailable", casesMeasured: 0, recall: null, reason: "This condition does not generate relationship order." },
    relatedTests: { matched: testMatched, expected: testExpected, recall: ratio(testMatched, testExpected) },
    context: { filesInspected: sum((item) => item.metrics.context.filesInspected), estimatedCharacters: sum((item) => item.metrics.context.estimatedCharacters), estimatedTokens: sum((item) => item.metrics.context.estimatedTokens), tokenizerId: TOKEN_ESTIMATOR },
    staleContextDetection: staleMeasured.length ? { status: "measured", requested: staleMeasured.length, detected: staleMeasured.reduce((total, item) => total + item.metrics.staleContextDetection.detected, 0), rate: ratio(staleMeasured.reduce((total, item) => total + item.metrics.staleContextDetection.detected, 0), staleMeasured.length) } : { status: "unavailable", requested: cases.filter((item) => item.metrics.staleContextDetection.requested).length, detected: null, rate: null },
    timing: (() => {
      const preparationMilliseconds = repositories.reduce((total, repository) => total + repository.timing.preparationMilliseconds, 0);
      const retrievalMilliseconds = sum((item) => item.metrics.timing.retrievalMilliseconds);
      const validationMilliseconds = sum((item) => item.metrics.timing.separateValidationMilliseconds || 0);
      const phases = new Map();
      for (const repository of repositories) {
        for (const phase of repository.timing.preparationPhases) phases.set(phase.phase, (phases.get(phase.phase) || 0) + phase.milliseconds);
      }
      return {
      processStartupAndModuleLoad: { status: "unavailable", milliseconds: null, reason: "The in-process evaluator starts timing after its modules are loaded; CLI process startup is not folded into scan or retrieval timing." },
      repositoryPreparationMilliseconds: Number(preparationMilliseconds.toFixed(3)),
      preparationPhases: [...phases].map(([phase, milliseconds]) => ({ phase, milliseconds: Number(milliseconds.toFixed(3)) })),
      caseRetrievalMilliseconds: Number(retrievalMilliseconds.toFixed(3)),
      totalTimeToUsefulContextMilliseconds: Number((preparationMilliseconds + retrievalMilliseconds).toFixed(3)),
      separateValidationMilliseconds: Number(validationMilliseconds.toFixed(3)),
      coldTimeToUsefulContextMilliseconds: Number((preparationMilliseconds + retrievalMilliseconds).toFixed(3)),
      warmTimeToUsefulContextMilliseconds: Number(retrievalMilliseconds.toFixed(3)),
      gating: false,
      accounting: "Repository preparation is counted once per repository; case retrieval is counted once per case; stale-ref validation is reported separately and excluded from time to useful context.",
    }; })(),
    unsupportedClaims: { evaluated: 0, unsupported: 0, rate: null, status: "no-claims-emitted" },
  };
}

function evaluateCondition(suiteRoot, definition, condition) {
  if (!CONDITIONS.has(condition)) throw new OrientationBenchmarkError("invalid-condition", `condition must be one of: ${[...CONDITIONS].join(", ")}.`);
  const normalized = normalizeDefinition(definition, suiteRoot);
  const repositories = normalized.repositories.map((repository) => {
    const actualPin = treeSha256(repository.root);
    if (actualPin !== repository.sourcePin.value) throw new OrientationBenchmarkError("source-pin-mismatch", `${repository.id} tree-sha256 mismatch: expected ${repository.sourcePin.value}, received ${actualPin}.`);
    let prepared;
    let preparationMilliseconds;
    let preparationPhases;
    if (condition === "direct-repository") {
      const started = process.hrtime.bigint();
      prepared = readTextInventory(repository.root, repository.retrievalExclusions);
      preparationMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
      preparationPhases = [{ phase: "text-inventory", milliseconds: Number(preparationMilliseconds.toFixed(3)) }];
    } else {
      const profile = [];
      const started = process.hrtime.bigint();
      prepared = scanRepository(repository.root, { persistIdentity: false, onProfile: (entry) => profile.push(entry) });
      preparationMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
      preparationPhases = profile;
    }
    const cases = repository.cases.map((benchmarkCase) => {
      const observation = condition === "direct-repository"
        ? directObservation(prepared, benchmarkCase, preparationMilliseconds)
        : flopeekObservation(prepared, benchmarkCase, preparationMilliseconds);
      if (condition === "flopeek" && benchmarkCase.staleContext) {
        const validationStarted = process.hrtime.bigint();
        observation.staleContextDetection = staleProbe(repository.root, benchmarkCase);
        observation.timing.separateValidationMilliseconds = Number((Number(process.hrtime.bigint() - validationStarted) / 1_000_000).toFixed(3));
      } else observation.timing.separateValidationMilliseconds = 0;
      return {
        id: benchmarkCase.id,
        repositoryId: repository.id,
        task: benchmarkCase.task,
        expected: benchmarkCase.expected,
        observed: {
          targetPaths: observation.targetPaths,
          flowStepIds: observation.flowStepIds,
          relatedTestPaths: observation.relatedTestPaths,
          repositoryFilesProcessed: observation.repositoryFilesProcessed,
        },
        metrics: scoreCase(benchmarkCase, observation),
      };
    });
    return {
      id: repository.id,
      declaredPath: repository.declaredPath,
      sourcePin: { ...repository.sourcePin, verified: true },
      retrievalExclusions: repository.retrievalExclusions,
      timing: { preparationMilliseconds: Number(preparationMilliseconds.toFixed(3)), preparationPhases },
      cases,
    };
  });
  const cases = repositories.flatMap((repository) => repository.cases);
  return {
    schemaVersion: ORIENTATION_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    runEnvironment: {
      flopeekVersion: packageInfo.version,
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      logicalCpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || "unknown",
      timingClock: "process.hrtime.bigint",
      timingPolicy: "host-specific-non-gating",
    },
    suite: { id: normalized.suiteId, casesSchemaVersion: normalized.schemaVersion, repositoryCount: repositories.length, caseCount: cases.length },
    condition,
    evidenceClass: "deterministic-retrieval",
    repositories,
    summary: aggregateCases(cases, repositories),
    studyEvidence: {
      deterministicRetrieval: { status: "measured", evidenceClass: "deterministic-retrieval" },
      humanStudy: { status: "not-run", evidenceClass: "human-observation", reason: "No consented human observation artifact was supplied or inferred." },
      agentStudy: { status: "not-run", evidenceClass: "agent-declared-or-independently-reviewed", reason: "No provider execution was invoked, supplied, or inferred." },
    },
    limitations: [
      "This is a deterministic retrieval benchmark, not a human productivity study or an AI-agent task-outcome study.",
      "Direct-repository uses plain case-insensitive substring retrieval and does not produce or score relationship order.",
      "Repository-declared benchmark oracle files are excluded from direct retrieval and disclosed per repository.",
      "Flopeek results are static parser and graph projections; they do not prove runtime order, business intent, successful behavior, or complete coverage.",
      "Timing is host-specific and non-gating. Repository preparation, bounded case retrieval, separate stale-ref validation, and unavailable process startup/module load are disclosed independently.",
      "Repository preparation is counted once per repository even when that repository contains multiple cases.",
      "Files inspected means unique paths exposed in the bounded result. Repository files processed is reported separately per case.",
      "Estimated tokens use the disclosed four-characters-per-token fallback and are not provider tokenizer measurements.",
    ],
  };
}

function compareReports(baseline, flopeek) {
  if (baseline.suite.id !== flopeek.suite.id || baseline.suite.caseCount !== flopeek.suite.caseCount) throw new OrientationBenchmarkError("incompatible-reports", "Orientation reports must use the same suite and case count.");
  const safeReduction = (left, right) => left > 0 ? Number(((left - right) / left).toFixed(6)) : null;
  return {
    schemaVersion: ORIENTATION_COMPARISON_SCHEMA,
    suite: baseline.suite,
    baseline,
    flopeek,
    comparison: {
      correctTargetRecallDelta: baseline.summary.correctTargetRetrieval.recall !== null && flopeek.summary.correctTargetRetrieval.recall !== null ? Number((flopeek.summary.correctTargetRetrieval.recall - baseline.summary.correctTargetRetrieval.recall).toFixed(6)) : null,
      relatedTestRecallDelta: baseline.summary.relatedTests.recall !== null && flopeek.summary.relatedTests.recall !== null ? Number((flopeek.summary.relatedTests.recall - baseline.summary.relatedTests.recall).toFixed(6)) : null,
      contextFilesReduction: safeReduction(baseline.summary.context.filesInspected, flopeek.summary.context.filesInspected),
      estimatedTokenReduction: safeReduction(baseline.summary.context.estimatedTokens, flopeek.summary.context.estimatedTokens),
      flowStepComparison: { status: "not-comparable", baseline: baseline.summary.flowSteps.status, flopeek: flopeek.summary.flowSteps.status, reason: "The lexical baseline does not create relationship order, so Flopeek flow recall is reported independently rather than as a fabricated delta." },
      timing: { status: "reported-not-gating", baseline: baseline.summary.timing, flopeek: flopeek.summary.timing },
    },
    conclusionBoundary: "The comparison measures deterministic retrieval on pinned fixtures only. It does not prove that developers or AI agents are faster, more accurate, or more successful with Flopeek.",
  };
}

function loadOrientationCases(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new OrientationBenchmarkError("invalid-cases-file", `Unable to read orientation cases ${file}: ${error.message}`); }
}

function evaluateOrientation(suiteRoot, definition, options = {}) {
  const condition = options.condition || "both";
  if (condition === "direct-repository" || condition === "baseline") return evaluateCondition(suiteRoot, definition, "direct-repository");
  if (condition === "flopeek") return evaluateCondition(suiteRoot, definition, "flopeek");
  if (condition !== "both") throw new OrientationBenchmarkError("invalid-condition", "condition must be baseline, direct-repository, flopeek, or both.");
  return compareReports(evaluateCondition(suiteRoot, definition, "direct-repository"), evaluateCondition(suiteRoot, definition, "flopeek"));
}

function orientationSummary(report) {
  if (report.schemaVersion === ORIENTATION_COMPARISON_SCHEMA) {
    return [
      `Orientation benchmark: ${report.suite.caseCount} deterministic cases`,
      `Target recall: baseline ${report.baseline.summary.correctTargetRetrieval.recall ?? "unavailable"}, Flopeek ${report.flopeek.summary.correctTargetRetrieval.recall ?? "unavailable"}`,
      `Related-test recall: baseline ${report.baseline.summary.relatedTests.recall ?? "unavailable"}, Flopeek ${report.flopeek.summary.relatedTests.recall ?? "unavailable"}`,
      `Context files: baseline ${report.baseline.summary.context.filesInspected}, Flopeek ${report.flopeek.summary.context.filesInspected}`,
      `Estimated tokens: baseline ${report.baseline.summary.context.estimatedTokens}, Flopeek ${report.flopeek.summary.context.estimatedTokens}`,
      `Flow steps: baseline ${report.baseline.summary.flowSteps.status}, Flopeek ${report.flopeek.summary.flowSteps.recall ?? report.flopeek.summary.flowSteps.status}`,
      `Preparation + retrieval: baseline ${report.baseline.summary.timing.totalTimeToUsefulContextMilliseconds} ms, Flopeek ${report.flopeek.summary.timing.totalTimeToUsefulContextMilliseconds} ms`,
      `Separate stale-ref validation: baseline ${report.baseline.summary.timing.separateValidationMilliseconds} ms, Flopeek ${report.flopeek.summary.timing.separateValidationMilliseconds} ms`,
      "Human study: not run. AI-agent study: not run. Timing is host-specific and non-gating.",
    ].join("\n");
  }
  return [
    `${report.condition}: ${report.summary.caseCount} deterministic cases`,
    `Target recall: ${report.summary.correctTargetRetrieval.recall ?? "unavailable"}`,
    `Flow-step recall: ${report.summary.flowSteps.recall ?? report.summary.flowSteps.status}`,
    `Related-test recall: ${report.summary.relatedTests.recall ?? "unavailable"}`,
    `Context: ${report.summary.context.filesInspected} files / ${report.summary.context.estimatedTokens} estimated tokens`,
    `Preparation + retrieval: ${report.summary.timing.totalTimeToUsefulContextMilliseconds} ms; separate validation: ${report.summary.timing.separateValidationMilliseconds} ms`,
    "Human study: not run. AI-agent study: not run.",
  ].join("\n");
}

module.exports = {
  ORIENTATION_CASES_SCHEMA,
  ORIENTATION_COMPARISON_SCHEMA,
  ORIENTATION_REPORT_SCHEMA,
  OrientationBenchmarkError,
  compareReports,
  evaluateCondition,
  evaluateOrientation,
  loadOrientationCases,
  normalizeDefinition,
  orientationSummary,
  treeSha256,
};
