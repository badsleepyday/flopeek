"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runHelperProcessMatrix } = require("../../src/helper-process-matrix");

test("fixture-only Go and .NET helper matrix leaves no observed helper process after completion, timeout, abort, or concurrent scans", { timeout: 90_000 }, async () => {
  const report = await runHelperProcessMatrix();
  assert.equal(report.schemaVersion, "flopeek-helper-process-matrix/v1");
  for (const kind of ["go", "csharp"]) {
    const result = report.results[kind];
    if (result.status === "unavailable") continue;
    assert.ok(result.completionAndTimeout.normal.factCount >= 1);
    assert.equal(result.completionAndTimeout.normal.stopped, true);
    assert.equal(result.completionAndTimeout.timeout.factCount, 0);
    assert.equal(result.completionAndTimeout.timeout.stopped, true);
    assert.equal(result.abort.status, "cancelled");
    assert.equal(result.abort.cachePromotionAllowed, false);
    assert.equal(result.abort.stopped, true);
    assert.equal(result.concurrent.length, 2);
    assert.ok(result.concurrent.every((item) => item.factCount >= 1 && item.stopped));
  }
});
