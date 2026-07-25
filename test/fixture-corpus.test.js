const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { scanRepository } = require("../src/scanner");

const FIXTURES_ROOT = path.join(__dirname, "fixtures");

function nodeReference(node) {
  if (node.kind === "endpoint") return `endpoint:${node.label}`;
  if (node.kind === "command" && node.entryKind === "django-management-command") return `command:${node.path}:${node.commandName}`;
  if (node.kind === "command" && node.entryKind === "framework-command") return `command:${node.path}:${node.adapter}:${node.commandName}`;
  if (node.kind === "command") return `command:${node.manifest}:${node.scriptName}`;
  if (node.kind === "schedule") return `schedule:${node.path}:${node.taskName}`;
  if (node.kind === "external") return `external:${node.label}`;
  if (node.kind === "symbol") return `symbol:${node.path}:${node.type}:${node.label}`;
  return `file:${node.path}`;
}

function relationshipKey(relationship) {
  return `${relationship.type}|${relationship.source}|${relationship.target}`;
}

function graphRelationshipKeys(graph, allowedTypes, allowedSources) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return new Set(graph.edges
    .filter((edge) => allowedTypes.has(edge.type))
    .map((edge) => ({ type: edge.type, source: nodes.get(edge.source), target: nodes.get(edge.target) }))
    .filter((edge) => edge.source && edge.target)
    .map((edge) => ({ type: edge.type, source: nodeReference(edge.source), target: nodeReference(edge.target) }))
    .filter((edge) => allowedSources.has(edge.source))
    .map(relationshipKey));
}

function scoreRelationships(expected, actual) {
  const truePositives = [...actual].filter((relationship) => expected.has(relationship)).length;
  return {
    expected: expected.size,
    detected: actual.size,
    truePositives,
    falsePositives: actual.size - truePositives,
    falseNegatives: expected.size - truePositives,
    precision: actual.size ? truePositives / actual.size : 0,
    recall: expected.size ? truePositives / expected.size : 1,
  };
}

test("fixture corpus meets the relationship precision and recall quality gate", (t) => {
  const fixtureNames = fs.readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(FIXTURES_ROOT, entry.name, "expectations.json")))
    .map((entry) => entry.name)
    .sort();
  const total = { expected: 0, detected: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0 };

  for (const fixtureName of fixtureNames) {
    const root = path.join(FIXTURES_ROOT, fixtureName);
    const expectation = JSON.parse(fs.readFileSync(path.join(root, "expectations.json"), "utf8"));
    const graph = scanRepository(root, { persistIdentity: false });
    const expected = new Set(expectation.relationships.map(relationshipKey));
    const actual = graphRelationshipKeys(
      graph,
      new Set(expectation.relationships.map((relationship) => relationship.type)),
      new Set(expectation.relationships.map((relationship) => relationship.source)),
    );
    const metrics = scoreRelationships(expected, actual);
    total.expected += metrics.expected;
    total.detected += metrics.detected;
    total.truePositives += metrics.truePositives;
    total.falsePositives += metrics.falsePositives;
    total.falseNegatives += metrics.falseNegatives;

    const endpoints = new Map(graph.nodes.filter((node) => node.kind === "endpoint").map((node) => [node.label, node]));
    for (const endpoint of expectation.endpoints || []) {
      assert.equal(endpoints.get(endpoint.label)?.analysis.confidence, endpoint.confidence, `${fixtureName}: missing or mismatched endpoint ${endpoint.label}`);
    }
    assert.ok(metrics.precision >= expectation.minimumPrecision, `${fixtureName}: precision ${(metrics.precision * 100).toFixed(1)}% is below ${(expectation.minimumPrecision * 100).toFixed(1)}%`);
    assert.ok(metrics.recall >= expectation.minimumRecall, `${fixtureName}: recall ${(metrics.recall * 100).toFixed(1)}% is below ${(expectation.minimumRecall * 100).toFixed(1)}%`);
    t.diagnostic(`${fixtureName}: precision ${(metrics.precision * 100).toFixed(1)}%, recall ${(metrics.recall * 100).toFixed(1)}% (${metrics.truePositives}/${metrics.expected} expected relationships)`);
  }

  const precision = total.detected ? total.truePositives / total.detected : 0;
  const recall = total.expected ? total.truePositives / total.expected : 1;
  assert.ok(precision >= 0.9, `corpus precision ${(precision * 100).toFixed(1)}% is below 90.0%`);
  assert.ok(recall >= 0.9, `corpus recall ${(recall * 100).toFixed(1)}% is below 90.0%`);
  t.diagnostic(`corpus: precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}% (${total.truePositives}/${total.expected} expected relationships)`);
});
