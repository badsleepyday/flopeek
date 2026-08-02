"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateGraph } = require("./graph-schema");
const { compareCollation } = require("./collation");

const CORE_COMPATIBILITY_SCHEMA = "flopeek-core-compatibility/v1";
const JS_CORE_BASELINE_SCHEMA = "flopeek-js-core-baseline/v1";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function compareStable(left, right) {
  return compareCollation(stableJson(left), stableJson(right));
}

function normalizedNode(node) {
  const { manualDescription: _manualDescription, ...fact } = node;
  const normalized = stableValue(fact);
  if (Array.isArray(normalized.methods)) normalized.methods.sort();
  return normalized;
}

function normalizedCoverage(coverage) {
  if (!coverage) return null;
  const normalized = stableValue(coverage);
  if (Array.isArray(normalized.languages)) {
    normalized.languages.sort((left, right) => compareCollation(left.language, right.language));
    for (const language of normalized.languages) {
      if (Array.isArray(language.parsers)) language.parsers.sort();
    }
  }
  if (Array.isArray(normalized.files)) normalized.files.sort(compareStable);
  if (Array.isArray(normalized.diagnostics)) normalized.diagnostics.sort(compareStable);
  return normalized;
}

function createCoreCompatibilityProjection(graph) {
  validateGraph(graph);
  const nodes = graph.nodes.map(normalizedNode).sort((left, right) => compareCollation(left.id, right.id));
  const edges = graph.edges.map(stableValue).sort(compareStable);
  const flows = graph.flows.map(stableValue).sort((left, right) => compareCollation(left.id, right.id));
  const diagnosticFlows = graph.diagnosticFlows.map(stableValue).sort((left, right) => compareCollation(left.id, right.id));
  return stableValue({
    schemaVersion: CORE_COMPATIBILITY_SCHEMA,
    graphSchemaVersion: graph.schemaVersion,
    analysis: {
      codeInterpretation: graph.analysis.codeInterpretation,
      unparsedPolicy: graph.analysis.unparsedPolicy,
      coverage: normalizedCoverage(graph.analysis.coverage),
      resolution: graph.analysis.resolution,
      calls: graph.analysis.calls,
      entryPoints: graph.analysis.entryPoints,
      adapterCapabilities: graph.analysis.adapterCapabilities,
      capabilities: graph.analysis.capabilities,
    },
    stats: graph.stats,
    nodes,
    edges,
    flows,
    diagnosticFlows,
  });
}

function createCoreCompatibilityDigest(graph) {
  const projection = createCoreCompatibilityProjection(graph);
  return `sha256:${crypto.createHash("sha256").update(stableJson(projection)).digest("hex")}`;
}

function sourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".flopeek" || entry.name === "expectations.json") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort();
}

function createSourceDigest(root) {
  const hash = crypto.createHash("sha256");
  for (const relativePath of sourceFiles(root)) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(Buffer.from(fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n")));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function createCoreBaselineCase(id, fixture, graph) {
  const projection = createCoreCompatibilityProjection(graph);
  return {
    id,
    fixture,
    sourceDigest: createSourceDigest(graph.project.root),
    compatibilityDigest: `sha256:${crypto.createHash("sha256").update(stableJson(projection)).digest("hex")}`,
    graphSchemaVersion: projection.graphSchemaVersion,
    nodes: projection.nodes.length,
    edges: projection.edges.length,
    flows: projection.flows.length,
    diagnosticFlows: projection.diagnosticFlows.length,
  };
}

module.exports = {
  CORE_COMPATIBILITY_SCHEMA,
  JS_CORE_BASELINE_SCHEMA,
  createCoreBaselineCase,
  createCoreCompatibilityDigest,
  createCoreCompatibilityProjection,
  createSourceDigest,
  stableJson,
};
