const AGENT_BOOTSTRAP_SCHEMA = "flowpeek-agent-bootstrap/v1";

function coverageSummary(graph) {
  const coverage = graph.analysis?.coverage || {};
  return {
    summary: coverage.summary || null,
    files: coverage.files || null,
    languages: coverage.languages || coverage.byLanguage || [],
    diagnostics: coverage.diagnostics || [],
    interpretation: "Coverage describes deterministic parser handling for this repository. It is not runtime coverage, behavioral coverage, or a recall guarantee.",
  };
}

function createAgentBootstrap(graph) {
  const flows = graph.flows || [];
  const cacheState = graph.analysis?.cacheState || null;
  const coverage = graph.analysis?.coverage || {};
  const incompleteCoverage = Number(coverage.summary?.inventoryOnlyFiles || 0) > 0 || Number(coverage.summary?.parseFailedFiles || 0) > 0;
  return {
    schemaVersion: AGENT_BOOTSTRAP_SCHEMA,
    project: {
      projectId: graph.project.projectId,
      name: graph.project.name,
      branch: graph.project.git?.branch || null,
      revision: graph.project.git?.revision || graph.state?.sourceRevision || null,
    },
    graph: {
      schemaVersion: graph.schemaVersion,
      graphVersion: graph.state?.graphVersion ?? null,
      status: graph.state?.status || "unknown",
      updatedAt: graph.state?.updatedAt || graph.generatedAt,
      inventory: {
        nodes: graph.nodes?.length || 0,
        edges: graph.edges?.length || 0,
        applicationFlows: flows.length,
        endpoints: graph.stats?.endpoints || 0,
        services: graph.stats?.services || 0,
        tests: graph.stats?.tests || 0,
      },
      cache: cacheState ? { status: cacheState.status, diagnostics: cacheState.diagnostics || [] } : { status: "unknown", diagnostics: [] },
    },
    readiness: {
      graphAvailable: Boolean(graph.nodes && graph.edges),
      applicationFlowsAvailable: flows.length > 0,
      sourceFallbackRequired: flows.length === 0 || incompleteCoverage,
    },
    coverage: coverageSummary(graph),
    workflow: [
      { step: 1, action: "Orient", tools: ["get_agent_context", "get_project_overview"], purpose: "Read graph identity, parser coverage, and interpretation limits before making claims." },
      { step: 2, action: "Focus", tools: ["get_handoff_context", "find_nodes", "get_request_flows"], purpose: "Retrieve a bounded task-relevant context instead of reading the entire repository." },
      { step: 3, action: "Inspect evidence", tools: ["get_node", "get_flow_projection", "get_flow_context_card", "get_related_tests"], purpose: "Resolve parser facts and Context Refs before planning a source change." },
      { step: 4, action: "Edit outside Flowpeek", tools: [], purpose: "Use the host agent's normal workspace tools. Flowpeek exposes no repository-source write or arbitrary shell tool." },
      { step: 5, action: "Refresh", tools: ["refresh_graph", "get_changed_contexts", "get_flow_comparison", "get_change_impact"], purpose: "Advance the graph and inspect bounded before/current static evidence after source edits." },
      { step: 6, action: "Verify outside Flowpeek", tools: ["get_related_tests", "record_agent_evidence_trace"], purpose: "Run repository-owned verification with approved host tools, then record only bounded declared evidence metadata." },
    ],
    policy: {
      strategy: "graph-first-with-source-fallback",
      parserFactsAuthority: "flowpeek-deterministic-scanner",
      agentRole: "consumer-and-proposer",
      sourceWrites: "not-exposed",
      targetExecution: "not-exposed",
      staticIsRuntimeTruth: false,
      staticIsBusinessTruth: false,
      missingEvidenceMeansMissingBehavior: false,
      agentProposalCreatesParserFact: false,
      agentProposalCreatesHumanVerification: false,
    },
    limitations: [
      "Static relationships do not prove runtime order, dynamic dispatch, successful side effects, or business intent.",
      "Inventory-only and unsupported constructs require direct source inspection and, where relevant, runtime or test evidence.",
      "Context Refs must be resolved again after a graph refresh; stale evidence must not be silently reused.",
      "Do not store source bodies, secrets, prompts, private reasoning, or raw command logs in Flowpeek metadata.",
    ],
  };
}

module.exports = { AGENT_BOOTSTRAP_SCHEMA, createAgentBootstrap };
