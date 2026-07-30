"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PERFORMANCE_CORPUS_SCHEMA,
  parseArguments,
  validatePerformanceCorpus,
} = require("../../scripts/run-native-candidate-evidence");

const adapters = {
  repositories: [
    { id: "one", adapters: ["typescript"] },
    { id: "two", adapters: ["python"] },
    { id: "three", adapters: ["rust"] },
    { id: "four", adapters: ["java"] },
    { id: "five", adapters: ["csharp"] },
  ],
};

test("performance corpus requires five distinct repositories, all size classes, and three families", () => {
  const corpus = {
    schemaVersion: PERFORMANCE_CORPUS_SCHEMA,
    repositories: [
      { repositoryId: "one", sizeClass: "small" },
      { repositoryId: "two", sizeClass: "medium" },
      { repositoryId: "three", sizeClass: "medium" },
      { repositoryId: "four", sizeClass: "large" },
      { repositoryId: "five", sizeClass: "monorepo" },
    ],
  };
  const validated = validatePerformanceCorpus(corpus, adapters);
  assert.equal(validated.repositories.length, 5);
  assert.deepEqual(validated.adapters, ["csharp", "java", "python", "rust", "typescript"]);
  assert.throws(() => validatePerformanceCorpus({
    ...corpus,
    repositories: corpus.repositories.slice(0, 4),
  }, adapters), /exactly five/);
  assert.throws(() => validatePerformanceCorpus({
    ...corpus,
    repositories: corpus.repositories.map((entry) => ({ ...entry, sizeClass: "small" })),
  }, adapters), /cover small, medium, large, and monorepo/);
  assert.throws(() => validatePerformanceCorpus({
    ...corpus,
    repositories: corpus.repositories.map((entry, index) => ({
      ...entry,
      repositoryId: index ? "one" : entry.repositoryId,
    })),
  }, adapters), /missing or duplicated/);
});

test("candidate runner rejects incomplete identity arguments", () => {
  assert.throws(() => parseArguments([]), /Usage/);
  assert.throws(() => parseArguments([
    "--binary", "binary",
    "--assets", "assets",
    "--work-directory", "work",
    "--output", "output",
    "--source-sha", "main",
  ]), /Usage/);
});
