"use strict";

function endpointIdentity(entry) {
  const match = String(entry?.label || "").match(/^([A-Z]+)\s+(.+)$/);
  return match ? { method: match[1], route: match[2] } : { method: null, route: null };
}

function relatedTests(graph, lens) {
  const stepIds = new Set((lens.steps || []).map((step) => step.id));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const tests = [];
  for (const edge of graph.edges) {
    const otherId = stepIds.has(edge.source) ? edge.target : stepIds.has(edge.target) ? edge.source : null;
    const node = otherId ? byId.get(otherId) : null;
    if (!node || node.type !== "test") continue;
    tests.push({ id: node.id, label: node.label, path: node.path, relationship: edge.type, evidenceClass: "parser-fact" });
  }
  return [...new Map(tests.map((item) => [item.id, item])).values()].sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
}

function createFlowInterface(graph, lens) {
  const entry = graph.nodes.find((node) => node.id === lens.flow.entryId) || null;
  const endpoint = endpointIdentity(entry);
  const exactHandler = lens.handlerEvidence?.binding === "exact-handler" && lens.handlerEvidence.handlerId
    ? { status: "available", id: lens.handlerEvidence.handlerId, evidenceClass: "parser-fact" }
    : { status: "unavailable", id: null, reason: "No exact endpoint-to-handler symbol edge is available." };
  const parserContract = exactHandler.status === "available" && entry?.handlerId === exactHandler.id && entry?.contract?.schemaVersion === "flowpeek-next-route-contract/v1"
    ? entry.contract
    : null;
  const request = parserContract
    ? { ...parserContract.request, evidenceClass: "parser-fact", adapter: parserContract.adapter }
    : {
      status: "unavailable",
      fields: [],
      reason: "Current parser adapters do not retain request-schema declarations with enough cross-framework consistency to claim a payload contract.",
    };
  const responses = parserContract
    ? { ...parserContract.responses, evidenceClass: "parser-fact", adapter: parserContract.adapter }
    : {
      status: "unavailable",
      variants: [],
      reason: "Current parser adapters do not retain response schemas or status branches as deterministic contract evidence.",
    };
  return {
    schemaVersion: "flowpeek-flow-interface/v1",
    flow: { id: lens.flow.id, contextRef: lens.flow.contextRef, graphVersion: graph.state.graphVersion },
    boundary: {
      kind: entry?.kind === "endpoint" ? "http-endpoint" : "detected-flow-entry",
      method: endpoint.method,
      route: endpoint.route,
      handler: exactHandler,
      evidenceClass: "parser-fact",
    },
    request,
    responses,
    relatedTests: relatedTests(graph, lens),
    execution: {
      status: "observation-only",
      adapterProtocol: "flowpeek-test-run-event/v1",
      limitation: "Flowpeek can track explicit runner events and the failing static step, but MCP does not execute arbitrary repository commands or infer runtime order from the static graph.",
    },
    nextSafeEvidence: [
      parserContract ? "This contract is limited to one exact Next.js handler and literal AST forms; dynamic schemas remain unavailable." : "Add adapter-specific schema extraction before showing payload fields as parser facts.",
      "Keep human examples, agent proposals, runtime observations, and test expectations in separate evidence classes.",
      "Use repository-owned tests as executable truth; Flowpeek records bounded progress/result evidence rather than becoming a second test framework.",
    ],
  };
}

module.exports = { createFlowInterface };
