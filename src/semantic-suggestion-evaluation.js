"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createSemanticFlowSuggestion } = require("./semantic-flow-suggestion");

function evaluationInput(item) {
  const flowId = `flow:${item.id}`;
  const entryId = `endpoint:${item.id}`;
  const steps = item.stepRoles.map((role, index) => ({
    id: index ? `node:${item.id}:${index}` : entryId,
    node: { id: index ? `node:${item.id}:${index}` : entryId, label: index ? `${role} node` : item.flowTitle, kind: index ? "symbol" : item.entryKind, type: index ? "service" : "endpoint" },
    role,
    confidence: "exact",
    contextRef: `fp://local/project%3Atest/node/${index ? `node%3A${item.id}%3A${index}` : `endpoint%3A${item.id}`}@1`,
    transition: index ? { id: `edge:${entryId}|calls|node:${item.id}:${index}`, sourceId: entryId, targetId: `node:${item.id}:${index}`, type: "calls" } : null,
  }));
  return {
    graph: { state: { graphVersion: 1 } },
    lens: {
      flow: { id: flowId, title: item.flowTitle, entryId, contextRef: `fp://local/project%3Atest/flow/${encodeURIComponent(flowId)}@1` },
      steps,
      staticBoundaries: item.boundary ? [{ category: item.boundary, node: steps.at(-1).node, contextRef: steps.at(-1).contextRef }] : [],
    },
  };
}

function evaluateSemanticSuggestionCorpus(corpus) {
  if (corpus?.schemaVersion !== "flowpeek-semantic-flow-suggestion-evaluation/v1" || !Array.isArray(corpus.cases)) throw new Error("Invalid semantic suggestion evaluation corpus.");
  const cases = corpus.cases.map((item) => {
    const { graph, lens } = evaluationInput(item);
    const actual = createSemanticFlowSuggestion(graph, lens);
    const mismatches = [];
    if (actual.status !== item.expected.status) mismatches.push(`status: expected ${item.expected.status}, received ${actual.status}`);
    if (item.expected.status === "suggested" && actual.status === "suggested") {
      if (actual.candidate.title !== item.expected.title) mismatches.push(`title: expected ${item.expected.title}, received ${actual.candidate.title}`);
      if (actual.candidate.role !== item.expected.role) mismatches.push(`role: expected ${item.expected.role}, received ${actual.candidate.role}`);
      if (actual.candidate.grouping.key !== item.expected.grouping) mismatches.push(`grouping: expected ${item.expected.grouping}, received ${actual.candidate.grouping.key}`);
    }
    if (item.expected.status === "abstained" && actual.status === "abstained" && actual.abstention.code !== item.expected.code) mismatches.push(`abstention code: expected ${item.expected.code}, received ${actual.abstention.code}`);
    return { id: item.id, expectedStatus: item.expected.status, actualStatus: actual.status, passed: mismatches.length === 0, mismatches, suggestion: actual };
  });
  const correctSuggestions = cases.filter((item) => item.passed && item.expectedStatus === "suggested").length;
  const incorrectSuggestions = cases.filter((item) => !item.passed && item.actualStatus === "suggested").length;
  const correctAbstentions = cases.filter((item) => item.passed && item.expectedStatus === "abstained").length;
  const unexpectedAbstentions = cases.filter((item) => !item.passed && item.actualStatus === "abstained").length;
  const correct = cases.filter((item) => item.passed).length;
  const suggested = cases.filter((item) => item.actualStatus === "suggested").length;
  return {
    schemaVersion: corpus.schemaVersion,
    total: cases.length,
    correct,
    incorrect: cases.length - correct,
    correctSuggestions,
    incorrectSuggestions,
    correctAbstentions,
    unexpectedAbstentions,
    coverage: suggested / Math.max(cases.length, 1),
    accuracy: correct / Math.max(cases.length, 1),
    cases,
    interpretation: corpus.interpretation,
  };
}

function main() {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "benchmarks", "semantic-flow-suggestions.json"), "utf8"));
  const result = evaluateSemanticSuggestionCorpus(corpus);
  console.log(`${result.correct}/${result.total} semantic suggestion contract cases matched`);
  console.log(`Correct suggestions ${result.correctSuggestions}; incorrect suggestions ${result.incorrectSuggestions}; correct abstentions ${result.correctAbstentions}; unexpected abstentions ${result.unexpectedAbstentions}`);
  console.log(`Coverage ${(result.coverage * 100).toFixed(1)}%; contract accuracy ${(result.accuracy * 100).toFixed(1)}%`);
  if (result.incorrect) {
    for (const item of result.cases.filter((candidate) => !candidate.passed)) console.error(`${item.id}: ${item.mismatches.join("; ")}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { evaluateSemanticSuggestionCorpus, evaluationInput };
