const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createSemanticFlowSuggestion, validateSemanticFlowSuggestion } = require("../../src/semantic-flow-suggestion");
const { evaluateSemanticSuggestionCorpus, evaluationInput } = require("../../src/semantic-suggestion-evaluation");

function inputFor(item) {
  return evaluationInput(item);
}

test("deterministic semantic suggestion corpus matches candidate and abstention contracts", (t) => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "semantic-flow-suggestions.json"), "utf8"));
  let passed = 0;
  for (const item of corpus.cases) {
    const { graph, lens } = inputFor(item);
    const suggestion = createSemanticFlowSuggestion(graph, lens);
    assert.equal(validateSemanticFlowSuggestion(suggestion), true);
    assert.equal(suggestion.status, item.expected.status, item.id);
    if (item.expected.status === "suggested") {
      assert.equal(suggestion.candidate.title, item.expected.title, item.id);
      assert.equal(suggestion.candidate.role, item.expected.role, item.id);
      assert.equal(suggestion.candidate.grouping.key, item.expected.grouping, item.id);
      assert.ok(suggestion.evidenceRefs.length > 0, item.id);
      assert.equal(suggestion.abstention, null, item.id);
    } else {
      assert.equal(suggestion.abstention.code, item.expected.code, item.id);
      assert.equal(suggestion.candidate, null, item.id);
    }
    passed += 1;
  }
  t.diagnostic(`${passed}/${corpus.cases.length} deterministic semantic suggestion cases matched`);
});

test("semantic evaluation reports correct, incorrect, abstention, coverage, and accuracy metrics", () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "semantic-flow-suggestions.json"), "utf8"));
  const result = evaluateSemanticSuggestionCorpus(corpus);
  assert.deepEqual({
    total: result.total,
    correct: result.correct,
    incorrect: result.incorrect,
    correctSuggestions: result.correctSuggestions,
    incorrectSuggestions: result.incorrectSuggestions,
    correctAbstentions: result.correctAbstentions,
    unexpectedAbstentions: result.unexpectedAbstentions,
    coverage: result.coverage,
    accuracy: result.accuracy,
  }, { total: 4, correct: 4, incorrect: 0, correctSuggestions: 2, incorrectSuggestions: 0, correctAbstentions: 2, unexpectedAbstentions: 0, coverage: 0.5, accuracy: 1 });
});

test("semantic suggestions cannot masquerade as human verification", () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "benchmarks", "semantic-flow-suggestions.json"), "utf8"));
  const { graph, lens } = inputFor(corpus.cases[0]);
  const suggestion = createSemanticFlowSuggestion(graph, lens);
  assert.equal(suggestion.knowledgeClass, "derived-suggestion");
  assert.equal(Object.hasOwn(suggestion, "verification"), false);
  assert.match(suggestion.limitations.join(" "), /never creates or modifies human verification/);
});
