const fs = require("node:fs");
const path = require("node:path");
const { createContextRef, parseContextRef } = require("./context-card");

const RELATED_IMPLEMENTATIONS_SCHEMA = "flopeek-related-implementations/v1";
const MAX_CANDIDATE_FILES = 250;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOKENS_PER_FILE = 80;
const MAX_RESULTS = 12;
const GENERIC_TOKENS = new Set([
  "active", "btn", "button", "container", "disabled", "error", "form", "form-control", "hidden", "input", "label", "modal", "row", "selected", "show", "table", "text", "title", "value", "wrapper",
]);

function inProject(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function tokenValue(value) {
  const normalized = String(value || "").trim();
  if (normalized.length < 3 || normalized.length > 120 || GENERIC_TOKENS.has(normalized.toLowerCase())) return null;
  return normalized;
}

function addToken(tokens, kind, value) {
  const normalized = tokenValue(value);
  if (normalized) tokens.add(`${kind}:${normalized}`);
}

function staticConventionTokens(source) {
  const tokens = new Set();
  const attributes = /\b(class|id|data-[\w-]+)\s*=\s*(["'])(.*?)\2/gi;
  for (const match of source.matchAll(attributes)) {
    const kind = match[1].toLowerCase() === "class" ? "class" : match[1].toLowerCase() === "id" ? "id" : "data";
    for (const value of match[3].split(/\s+/)) addToken(tokens, kind, value);
  }
  const phpHelperAttributes = /["']?(class|id|data-[\w-]+)["']?\s*=>\s*(["'])(.*?)\2/gi;
  for (const match of source.matchAll(phpHelperAttributes)) {
    const kind = match[1].toLowerCase() === "class" ? "class" : match[1].toLowerCase() === "id" ? "id" : "data";
    for (const value of match[3].split(/\s+/)) addToken(tokens, kind, value);
  }
  const handlers = /\bon(?:change|click|input|submit|blur|focus|keydown|keyup)\s*=\s*(["'])\s*([A-Za-z_$][\w$]*)\s*\(/gi;
  for (const match of source.matchAll(handlers)) addToken(tokens, "handler", match[2]);
  return [...tokens].sort().slice(0, MAX_TOKENS_PER_FILE);
}

function sourceTokens(root, relativePath) {
  const filePath = path.resolve(root, relativePath);
  if (!inProject(root, filePath)) return { status: "outside-project", tokens: [] };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { status: "not-a-file", tokens: [] };
    if (stat.size > MAX_FILE_BYTES) return { status: "too-large", tokens: [] };
    return { status: "read", tokens: staticConventionTokens(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "unreadable", tokens: [] };
  }
}

function sharedDirectoryDepth(leftPath, rightPath) {
  const left = path.dirname(leftPath).split(/[\\/]+/);
  const right = path.dirname(rightPath).split(/[\\/]+/);
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1;
  return depth;
}

function getRelatedImplementations(graph, contextRef, options = {}) {
  const parsed = parseContextRef(contextRef);
  if (parsed.projectId !== graph.project.projectId) throw new Error("Context Ref belongs to a different Flopeek project.");
  if (parsed.kind !== "node") throw new Error("Related implementations require a node Context Ref.");
  const node = graph.nodes.find((candidate) => candidate.id === parsed.contextId);
  if (!node) throw new Error("Context Ref node is not available in the current graph.");
  if (node.kind !== "file" || !node.path) throw new Error("Related implementations are available only for source-file Context Refs.");

  const root = path.resolve(graph.project.root);
  const subject = sourceTokens(root, node.path);
  const currentContextRef = createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion);
  const base = {
    schemaVersion: RELATED_IMPLEMENTATIONS_SCHEMA,
    status: subject.status === "read" ? "available" : "unavailable",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    subject: { path: node.path, nodeId: node.id, contextRef: currentContextRef, requestedContextRef: contextRef, contextStatus: parsed.graphVersion === graph.state.graphVersion ? "current" : "stale" },
    evidence: { method: "exact-static-token-cooccurrence", tokenKinds: ["class", "id", "data", "handler"], subjectTokenCount: subject.tokens.length, sourceReadStatus: subject.status },
    candidates: [],
    truncation: { maxCandidateFiles: Number(options.maxCandidateFiles) || MAX_CANDIDATE_FILES, candidateFilesConsidered: 0, candidateFilesOmitted: 0, resultsLimited: false },
    limitation: "Candidates are files with at least two exact shared static markup or inline-handler tokens. This does not expose source bodies and does not prove UI behavior, runtime wiring, semantic equivalence, ownership, or a relationship beyond the reported token co-occurrence.",
  };
  if (subject.status !== "read") return base;

  const extension = path.extname(node.path).toLowerCase();
  const cap = Math.max(1, Math.min(Number(options.maxCandidateFiles) || MAX_CANDIDATE_FILES, MAX_CANDIDATE_FILES));
  const fileNodes = [...new Map(graph.nodes.filter((candidate) => candidate.kind === "file" && candidate.path && candidate.id !== node.id && path.extname(candidate.path).toLowerCase() === extension).map((candidate) => [candidate.path, candidate])).values()]
    .sort((left, right) => sharedDirectoryDepth(node.path, right.path) - sharedDirectoryDepth(node.path, left.path) || left.path.localeCompare(right.path));
  const selected = fileNodes.slice(0, cap);
  base.truncation.candidateFilesConsidered = selected.length;
  base.truncation.candidateFilesOmitted = Math.max(0, fileNodes.length - selected.length);
  const subjectTokens = new Set(subject.tokens);
  const candidates = [];
  for (const candidate of selected) {
    const content = sourceTokens(root, candidate.path);
    if (content.status !== "read") continue;
    const matchedTokens = content.tokens.filter((token) => subjectTokens.has(token));
    if (matchedTokens.length < 2) continue;
    candidates.push({
      path: candidate.path,
      nodeId: candidate.id,
      contextRef: createContextRef(graph.project.projectId, "node", candidate.id, graph.state.graphVersion),
      matchedTokens,
      matchedTokenCount: matchedTokens.length,
      evidence: "exact-static-token-cooccurrence",
    });
  }
  candidates.sort((left, right) => right.matchedTokenCount - left.matchedTokenCount || left.path.localeCompare(right.path));
  base.candidates = candidates.slice(0, MAX_RESULTS);
  base.truncation.resultsLimited = candidates.length > MAX_RESULTS;
  return base;
}

module.exports = { RELATED_IMPLEMENTATIONS_SCHEMA, MAX_CANDIDATE_FILES, MAX_FILE_BYTES, staticConventionTokens, getRelatedImplementations };
