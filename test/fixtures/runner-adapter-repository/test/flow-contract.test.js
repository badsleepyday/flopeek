"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function adapterConfiguration() {
  const endpoint = process.env.FLOWPEEK_EVENT_ENDPOINT;
  const flowId = process.env.FLOWPEEK_FLOW_ID;
  const contextRef = process.env.FLOWPEEK_FLOW_CONTEXT_REF;
  const stepId = process.env.FLOWPEEK_FLOW_STEP_ID;
  const runId = process.env.FLOWPEEK_RUN_ID;
  if (![endpoint, flowId, contextRef, stepId, runId].every(Boolean)) return null;
  const url = new URL(endpoint);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) throw new Error("The fixture runner adapter only reports to an explicit loopback Flowpeek endpoint.");
  return { endpoint: url.toString(), flowId, contextRef, stepId, runId };
}

async function report(configuration, sequence, eventType, summary, stepId = null) {
  if (!configuration) return;
  const response = await fetch(configuration.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: `${configuration.runId}:${sequence}`,
      flowId: configuration.flowId,
      expectedFlowContextRef: configuration.contextRef,
      runId: configuration.runId,
      sequence,
      eventType,
      stepId,
      summary,
      runner: "repository-owned-node-test",
      actor: "fixture CI",
      observedAt: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new Error(`Flowpeek rejected runner event ${sequence} (${response.status}).`);
}

test("repository-owned contract test reports its bounded failing step when explicitly configured", async () => {
  const configuration = adapterConfiguration();
  await report(configuration, 0, "run-started", "Repository-owned test command started.");
  await report(configuration, 1, "step-started", "Repository-owned test reached the selected static step.", configuration?.stepId);
  try {
    assert.equal("reported", "expected", "Intentional fixture assertion failure.");
  } catch (error) {
    await report(configuration, 2, "step-failed", "Repository-owned assertion failed at the selected static step.", configuration?.stepId);
    throw error;
  }
});
