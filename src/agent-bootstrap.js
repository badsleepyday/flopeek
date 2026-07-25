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
  const scanOutcome = graph.analysis?.scanOutcome || null;
  const packageSelection = graph.analysis?.packageSelection || scanOutcome?.discovery?.selection || null;
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
        commandEntries: graph.stats?.commandEntries || 0,
        scheduledEntries: graph.stats?.scheduledEntries || 0,
        services: graph.stats?.services || 0,
        tests: graph.stats?.tests || 0,
      },
      cache: cacheState ? { status: cacheState.status, diagnostics: cacheState.diagnostics || [] } : { status: "unknown", diagnostics: [] },
      packageSelection,
    },
    readiness: {
      graphAvailable: Boolean(graph.nodes && graph.edges),
      applicationFlowsAvailable: flows.length > 0,
      sourceFallbackRequired: flows.length === 0 || incompleteCoverage,
      currentSourceVerified: scanOutcome
        ? scanOutcome.status === "complete" && scanOutcome.activeGraph?.freshness === "current"
        : null,
      attachedHeadVerified: scanOutcome
        ? scanOutcome.activeGraph?.attachedHeadFreshness?.status === "matched"
        : null,
    },
    scan: scanOutcome || {
      status: "unavailable",
      reason: "This graph was not produced through a surface that exposes the shared scan-outcome contract.",
    },
    coverage: coverageSummary(graph),
    workflow: [
      { step: 1, action: "Orient", tools: ["get_scan_status", "get_agent_context", "get_project_overview"], purpose: "Read scan freshness, graph identity, parser coverage, and interpretation limits before making claims." },
      { step: 2, action: "Focus", tools: ["get_handoff_context", "find_nodes", "get_entry_flows"], purpose: "Retrieve a bounded task-relevant context instead of reading the entire repository." },
      { step: 3, action: "Inspect evidence", tools: ["get_node", "get_flow_projection", "get_flow_context_card", "get_related_tests"], purpose: "Resolve parser facts and Context Refs before planning a source change." },
      { step: 4, action: "Continue safely when a checkpoint exists", tools: ["get_continuation_context", "get_work_dependency_status"], purpose: "Resolve exact checkpoint context and declared dependency readiness before built-in implementation entry. Ready is local delivery metadata, not source or runtime proof." },
      { step: 5, action: "Inspect bounded Git evidence only when needed", tools: ["get_active_branch_git_evidence", "get_git_context_continuity"], purpose: "Read local path-touch commits or compare one Context Ref across two static Git snapshots. Neither result proves original rationale, runtime behavior, review, test success, release state, rename, or implementation equivalence." },
      { step: 6, action: "Edit outside Flowpeek", tools: [], purpose: "Use the host agent's normal workspace tools. Flowpeek exposes no repository-source write or arbitrary shell tool." },
      { step: 7, action: "Refresh", tools: ["refresh_graph", "get_scan_status", "get_changed_contexts", "get_flow_comparison", "get_change_impact"], purpose: "Advance the graph, confirm source freshness, and inspect bounded before/current static evidence after source edits." },
      { step: 8, action: "Verify outside Flowpeek", tools: ["get_related_tests", "record_agent_evidence_trace"], purpose: "Run repository-owned verification with approved host tools, then record only bounded declared evidence metadata." },
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
      packageSelection?.status === "selected"
        ? "This graph covers only the selected static package subtree. It does not prove workspace topology, dependency ownership, build activation, or runtime behavior outside that subtree."
        : "This graph covers the configured repository-wide static scope; it does not prove runtime topology or behavior.",
      "Do not store source bodies, secrets, prompts, private reasoning, or raw command logs in Flowpeek metadata.",
    ],
  };
}

module.exports = { AGENT_BOOTSTRAP_SCHEMA, createAgentBootstrap };
