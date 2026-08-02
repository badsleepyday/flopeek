"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { executionOrder, summarize } = require("../../scripts/benchmark-native-incremental");
const { stateRequest } = require("../../scripts/benchmark-native-core-client");

test("native incremental benchmark alternates command order rather than always warming native second", () => {
  assert.deepEqual(executionOrder(1, 0), ["native", "js"]);
  assert.deepEqual(executionOrder(2, 0), ["js", "native"]);
  assert.deepEqual(executionOrder(1, 1), ["js", "native"]);
});

test("native incremental benchmark retains per-sample execution order with medians", () => {
  const result = summarize("fixture", [
    {
      cold: { jsMs: 10, nativeMs: 8, executionOrder: ["js", "native"] },
      unchanged: { jsMs: 4, nativeMs: 2, executionOrder: ["native", "js"] },
      oneFileChange: { jsMs: 6, nativeMs: 3, executionOrder: ["js", "native"] },
    },
  ]);
  assert.deepEqual(result.states.cold.executionOrders, [["js", "native"]]);
  assert.equal(result.states.unchanged.speedupNativeVsJavaScript, 2);
});

test("native CoreClient benchmark measures the explicit scan-refresh lifecycle", () => {
  assert.deepEqual(stateRequest("cold"), { changedPaths: null, reason: "benchmark-cold" });
  assert.deepEqual(stateRequest("unchanged"), { changedPaths: [], reason: "benchmark-unchanged" });
  assert.deepEqual(stateRequest("oneFileChange", "src/example.ts"), { changedPaths: ["src/example.ts"], reason: "benchmark-one-file-change" });
  assert.throws(() => stateRequest("oneFileChange"), /missing changed path/);
});
