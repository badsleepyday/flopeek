"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeCSharpFact, analyzeGoFact, analyzeInventory } = require("../../src/structural-fact-adapter");

test("structural fact adapter preserves Go parser evidence and bounded methods", () => {
  const result = analyzeGoFact({
    status: "parsed",
    diagnostics: 0,
    imports: [{ specifier: "ledger/internal/payments", standard: false, range: { start: 1, end: 2 } }],
    calls: [{ name: "Approve", source: "payments", imported: "ledger/internal/payments", range: { start: 4, end: 5 } }],
    methods: ["Approve", "Approve"],
    symbols: [{ type: "function", name: "Approve", range: { start: 3, end: 6 } }],
  }, "internal/api/handler.go");
  assert.equal(result.analysis.confidence, "exact");
  assert.deepEqual(result.methods, ["Approve"]);
  assert.deepEqual(result.calls[0].evidence, { parser: "go-parser", file: "internal/api/handler.go", range: { start: 4, end: 5 } });
});

test("structural fact adapter preserves C# facts and makes missing adapter state explicit", () => {
  const csharp = analyzeCSharpFact({ status: "parsed-with-diagnostics", diagnostics: 1, imports: [{ specifier: "Ledger.Core", range: { start: 1, end: 2 } }], methods: ["Approve"] }, "Api.cs");
  assert.equal(csharp.analysis.confidence, "exact");
  assert.deepEqual(csharp.imports[0].evidence, { parser: "csharp-roslyn", file: "Api.cs", range: { start: 1, end: 2 } });
  assert.deepEqual(analyzeInventory("README.md", ".md").analysis, {
    parser: "inventory",
    status: "inventory-only",
    confidence: "not-analyzed",
    reason: "No structural adapter registered for .md.",
  });
});
