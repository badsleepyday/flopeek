const fs = require("node:fs");
const path = require("node:path");
const packageInfo = require("../package.json");
const { invalidateArtifactCache } = require("./artifact-cache");
const { findNodes, getAgentBootstrap, getAgentEvidenceTraces, getAgentSemanticProposal, getChangeImpact, getChangedContexts, getContextCard, getFlowComparison, getFlowContextCard, getFlowProjection, getFlowVerification, getGraphDelta, getHandoffContext, getNodeDetails, getProductProof, getRelatedTests, getRequestFlows, getSemanticSuggestionFeedback, getTestRuns, getTrustAnalytics, getVerifiedSemanticMemory, projectView, recordAgentEvidenceTrace, recordAgentSemanticProposal, recordSemanticSuggestionFeedback, recordTestRunEvent, resolveContextRef } = require("./graph-service");
const { createRepositoryScanner, writeGraphCache } = require("./scanner");
const { summarizeCacheResult } = require("./graph-cache");
const { readGraphDelta, readLatestGraphDelta } = require("./graph-state");
const { compareGitSnapshots, createGitSnapshot } = require("./history");
const { DEFAULT_FLOW_LENS_MAX_STEPS, MAX_FLOW_LENS_STEPS, MIN_FLOW_LENS_STEPS } = require("./flow-lens-options");

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return { content: [{ type: "text", text: `Flowpeek error: ${error.message}` }], isError: true };
}

async function createMcpServer(options) {
  const [{ McpServer }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("zod"),
  ]);
  const root = fs.realpathSync(options.root);
  if (!fs.statSync(root).isDirectory()) throw new Error("MCP repository target must be a directory.");
  const scanner = createRepositoryScanner(root);
  let graph;
  let previousGraph = null;
  const refresh = (changedPaths = null, reason = "agent-refresh") => {
    previousGraph = graph;
    graph = scanner.scan(changedPaths);
    graph.analysis.cacheState = options.cache === false
      ? { status: "disabled", path: path.join(root, ".flowpeek", "graph.json"), diagnostics: [], contract: null, migrated: false }
      : summarizeCacheResult(writeGraphCache(root, graph, { reason, changedPaths }));
    graph.analysis.derivedCacheInvalidation = options.cache === false
      ? { status: "disabled", events: [], diagnostics: [] }
      : invalidateArtifactCache(root, graph, changedPaths || [], { topologyChanged: Boolean(graph.analysis.latestDelta?.topologyChanged) });
    return { graph, delta: getGraphDelta(previousGraph, graph) };
  };
  const currentGraph = () => graph || refresh().graph;
  refresh();

  const server = new McpServer({ name: "flowpeek", version: packageInfo.version });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const metadataWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const registerWithAnnotations = (name, config, annotations, handler) => {
    server.registerTool(name, { ...config, annotations }, async (input) => {
      try {
        return jsonResult(await handler(input));
      } catch (error) {
        return errorResult(error);
      }
    });
  };
  const register = (name, config, handler) => registerWithAnnotations(name, config, readOnly, handler);
  const registerMetadataWrite = (name, config, handler) => registerWithAnnotations(name, config, metadataWrite, handler);

  register("get_agent_bootstrap", {
    title: "Get the Flowpeek agent bootstrap",
    description: "Start here. Return the current graph identity, parser coverage, readiness, recommended evidence workflow, and non-overclaiming policy shared by every supported agent host.",
    inputSchema: {},
  }, () => getAgentBootstrap(currentGraph()));

  register("get_project_overview", {
    title: "Get project overview",
    description: "Return an aggregate technical map. Summary nodes and derived edges are not source files, service boundaries, or runtime traces. Use get_node before planning a code change.",
    inputSchema: {
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
    },
  }, ({ scope = "application" }) => projectView(currentGraph(), { mode: "overview", scope }));

  register("find_nodes", {
    title: "Find code graph nodes",
    description: "Find exact graph candidates by plain-text label, path, feature, domain, or type. This is a deterministic graph lookup; it does not search source text or infer intent.",
    inputSchema: {
      query: z.string().min(1).max(240),
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
    },
  }, ({ query, scope = "application" }) => findNodes(currentGraph(), { query, scope }));

  register("get_node", {
    title: "Get raw node evidence",
    description: "Return one original node with direct incoming and outgoing parser facts, source evidence, and manually verified description. Call this before interpreting a summary node as implementation detail.",
    inputSchema: { id: z.string().min(1).max(2048) },
  }, ({ id }) => {
    const detail = getNodeDetails(currentGraph(), id);
    if (!detail) throw new Error(`Node not found: ${id}`);
    return detail;
  });

  register("get_direct_dependencies", {
    title: "Get direct dependencies",
    description: "Return the selected original node and only its direct graph neighbors. Relationships contain parser evidence and confidence. This does not prove full runtime execution order.",
    inputSchema: {
      id: z.string().min(1).max(2048),
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
    },
  }, ({ id, scope = "application" }) => projectView(currentGraph(), { mode: "dependencies", scope, focus: id }));

  register("get_request_flows", {
    title: "Get detected request flows",
    description: "Return static traversals from detected HTTP endpoints or other entry points. These are technical graph paths only; they do not claim business flow or runtime order.",
    inputSchema: {
      endpoint: z.string().max(240).optional(),
      scope: z.enum(["application", "all"]).optional(),
    },
  }, ({ endpoint = "", scope = "application" }) => getRequestFlows(currentGraph(), endpoint, scope));

  register("get_flow_projection", {
    title: "Get an evidence-rich Flow Lens",
    description: "Return one bounded static HTTP/request flow with derived step roles, direct parser-edge evidence, static boundaries, ambiguity, and truncation. It is not a runtime trace or business-process claim. Inspect a step Context Card before proposing a change.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
      maxSteps: z.number().int().min(MIN_FLOW_LENS_STEPS).max(MAX_FLOW_LENS_STEPS).optional(),
    },
  }, ({ flowId, scope = "application", maxSteps = DEFAULT_FLOW_LENS_MAX_STEPS }) => {
    const lens = getFlowProjection(currentGraph(), flowId, scope, { maxSteps });
    if (!lens) throw new Error(`Detected flow not found: ${flowId}`);
    return lens;
  });

  register("get_change_impact", {
    title: "Get static change impact",
    description: "Return source nodes, HTTP endpoints, and directly connected tests that statically depend on changed repository-relative paths. After refresh_graph, a deleted path can use the immediately preceding in-process graph as historical evidence. This is not runtime tracing.",
    inputSchema: {
      paths: z.array(z.string().min(1).max(2048)).min(1).max(100),
      maxDepth: z.number().int().min(0).max(12).optional(),
    },
  }, ({ paths, maxDepth = 6 }) => getChangeImpact(currentGraph(), paths, { maxDepth, previousGraph }));

  register("get_related_tests", {
    title: "Get directly related tests",
    description: "Return test files that have direct parser relationships with a node. Missing results do not prove that behavioral coverage does not exist.",
    inputSchema: { id: z.string().min(1).max(2048) },
  }, ({ id }) => {
    const tests = getRelatedTests(currentGraph(), id);
    if (!tests) throw new Error(`Node not found: ${id}`);
    return tests;
  });

  register("get_agent_context", {
    title: "Get evidence and interpretation limits",
    description: "Return Flowpeek's machine-readable interpretation rules, parser coverage, uncertainty policy, and the selected projection's meaning. Use this at the start of work and after refresh_graph.",
    inputSchema: {
      mode: z.enum(["overview", "requests", "dependencies"]).optional(),
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
      focusId: z.string().max(2048).optional(),
    },
  }, ({ mode = "overview", scope = "application", focusId }) => projectView(currentGraph(), { mode, scope, focus: focusId }).aiContext);

  register("get_trust_analytics", {
    title: "Get trust analytics",
    description: "Return evidence availability, provenance, and freshness for the current static graph and local evidence stores. This tool deliberately returns no composite truth score and does not claim runtime correctness, business intent correctness, complete coverage, or live-repository precision/recall.",
    inputSchema: {},
  }, () => getTrustAnalytics(currentGraph()));

  register("get_product_proof", {
    title: "Get product proof",
    description: "Return bounded public benchmark evidence, current-repository facts, feature proof surfaces, reproduction commands, and explicit claim boundaries. Published precision/recall applies only to the pinned manually audited scopes; published speedups are host-specific samples, not universal promises.",
    inputSchema: {},
  }, () => getProductProof(currentGraph()));

  register("get_handoff_context", {
    title: "Get bounded project handoff context",
    description: "Return one deterministic, relevance-ranked Context Packet for an AI task. The packet is constrained by an explicit approximate token budget, reports all omissions and truncation reasons, links to versioned evidence refs, and never returns source-file bodies, credentials, shell access, or runtime claims.",
    inputSchema: {
      taskIntent: z.string().min(1).max(4000),
      changedPaths: z.array(z.string().min(1).max(2048)).max(100).optional(),
      targetFeature: z.string().min(1).max(2048).optional(),
      targetFlow: z.string().min(1).max(4096).optional(),
      tokenBudget: z.number().int().min(1024).max(65536).optional(),
      desiredEvidenceDepth: z.enum(["summary", "standard", "evidence"]).optional(),
      tokenizerId: z.literal("flowpeek-char4-estimator/v1").optional(),
    },
  }, (input) => getHandoffContext(currentGraph(), input));

  register("get_graph_delta", {
    title: "Get persistent graph delta",
    description: "Return a persisted adjacent static graph delta. Use graph versions from get_agent_context or refresh_graph. An absent delta is explicit; it is never reconstructed as runtime behavior.",
    inputSchema: {
      fromVersion: z.number().int().min(0).optional(),
      toVersion: z.number().int().min(1).optional(),
    },
  }, ({ fromVersion, toVersion }) => {
    const current = currentGraph();
    const delta = fromVersion !== undefined && toVersion !== undefined
      ? readGraphDelta(root, fromVersion, toVersion)
      : readLatestGraphDelta(root, current.state.graphVersion);
    if (!delta) throw new Error("No matching persisted graph delta was found.");
    return delta;
  });

  register("get_changed_contexts", {
    title: "Get changed Context Cards and Flow Lenses",
    description: "Return bounded current or historical technical contexts affected by one retained adjacent graph delta. Results include Context Refs and Flow Lens IDs, but do not prove runtime behavior or reconstruct a full historical card.",
    inputSchema: {
      fromVersion: z.number().int().min(0).optional(),
      toVersion: z.number().int().min(1).optional(),
    },
  }, ({ fromVersion, toVersion }) => getChangedContexts(currentGraph(), { fromVersion, toVersion }));

  register("get_flow_comparison", {
    title: "Compare adjacent Flow Lens snapshots",
    description: "Return bounded before/current static Flow Lens snapshots for an affected flow captured in one retained adjacent graph delta. This is not runtime history, control-flow proof, or a reconstructed historical Context Card.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      fromVersion: z.number().int().min(0).optional(),
      toVersion: z.number().int().min(1).optional(),
    },
  }, ({ flowId, fromVersion, toVersion }) => getFlowComparison(currentGraph(), flowId, { fromVersion, toVersion }));

  register("get_flow_context_card", {
    title: "Get a portable Flow Context Card",
    description: "Return a bounded versioned Context Packet for one detected static HTTP/request flow. JSON is the default; Markdown is a portable human/agent handoff. It contains no source-file body, credentials, runtime history, or business rationale.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      format: z.enum(["json", "markdown"]).optional(),
      scope: z.enum(["application", "all"]).optional(),
      maxSteps: z.number().int().min(MIN_FLOW_LENS_STEPS).max(MAX_FLOW_LENS_STEPS).optional(),
    },
  }, ({ flowId, format = "json", scope = "application", maxSteps = DEFAULT_FLOW_LENS_MAX_STEPS }) => {
    const card = getFlowContextCard(currentGraph(), flowId, format, scope, { maxSteps });
    if (!card) throw new Error(`Flow not found: ${flowId}`);
    return card;
  });

  register("get_flow_verification", {
    title: "Get local flow verification",
    description: "Return local human verification metadata and its current, compatible, stale, detached, or indeterminate status for one bounded static flow. The returned history marks superseded records. This is read-only local metadata; it does not prove runtime behavior, business purpose, or test success.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
    },
  }, ({ flowId, scope = "application" }) => {
    const verification = getFlowVerification(currentGraph(), flowId, scope);
    if (!verification) throw new Error(`Flow not found: ${flowId}`);
    return verification;
  });

  register("get_verified_semantic_memory", {
    title: "Get reusable verified semantic memory",
    description: "Return a bounded project-local index backed by human flow-verification metadata in .flowpeek. Only current or compatible records are reusable by default. This is not an embedded model, training dataset claim, or authority to auto-verify another flow.",
    inputSchema: {
      query: z.string().max(240).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeStale: z.boolean().optional(),
    },
  }, (input) => getVerifiedSemanticMemory(currentGraph(), input));

  register("get_test_runs", {
    title: "Get bounded test-run progress evidence",
    description: "Return explicit runner-adapter events grouped into runs, including current static step or failing stop step. Flowpeek does not execute commands, capture raw logs, or infer runtime order from the static graph.",
    inputSchema: {
      flowId: z.string().min(1).max(4096).optional(),
      status: z.enum(["running", "passed", "failed", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, (input) => getTestRuns(currentGraph(), input));

  registerMetadataWrite("record_test_run_event", {
    title: "Record a test-run adapter event",
    description: "Append an idempotent sanitized progress event for a current Flow Lens. The caller is an explicit runner adapter; this tool does not execute commands or accept source bodies, raw logs, credentials, or inferred runtime steps.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
      operationId: z.string().min(1).max(240),
      expectedFlowContextRef: z.string().min(1).max(8192),
      runId: z.string().min(1).max(240),
      sequence: z.number().int().min(0),
      eventType: z.enum(["run-started", "step-started", "step-passed", "step-failed", "run-passed", "run-failed", "run-cancelled"]),
      stepId: z.string().min(1).max(4096).optional(),
      summary: z.string().min(1).max(1200),
      runner: z.string().min(1).max(240),
      actor: z.string().min(1).max(240),
      observedAt: z.string().min(1).max(80),
      durationMs: z.number().int().min(0).max(86400000).optional(),
    },
  }, ({ flowId, scope = "application", ...input }) => {
    const result = recordTestRunEvent(currentGraph(), flowId, input, scope);
    if (!result) throw new Error(`Flow not found: ${flowId}`);
    return result;
  });

  register("get_context_card", {
    title: "Get a portable node Context Card",
    description: "Return bounded static evidence for one raw node at the current graph version. JSON is the default Context Packet; Markdown is a portable human handoff. It contains no source-file body, credentials, or runtime claims.",
    inputSchema: {
      id: z.string().min(1).max(2048),
      format: z.enum(["json", "markdown"]).optional(),
    },
  }, ({ id, format = "json" }) => {
    const card = getContextCard(currentGraph(), id, format);
    if (!card) throw new Error(`Node not found: ${id}`);
    return card;
  });

  register("resolve_context_ref", {
    title: "Resolve a Flowpeek Context Ref",
    description: "Resolve a node or flow fp://local Context Ref against the current project. The result explicitly reports current, stale, historical, unresolved, or successor-candidate state and never silently redirects to unrelated evidence.",
    inputSchema: { contextRef: z.string().min(1).max(8192) },
  }, ({ contextRef }) => resolveContextRef(currentGraph(), contextRef));

  register("get_agent_evidence_traces", {
    title: "Get agent evidence traces",
    description: "Return bounded append-only agent-declared audit records linked to Flowpeek Context Refs. Records contain concise outcome summaries, repository-relative changed paths, and declared verification outcomes; callers must not put private reasoning or sensitive/source content in these fields.",
    inputSchema: {
      contextRef: z.string().min(1).max(8192).optional(),
      contextId: z.string().min(1).max(4096).optional(),
      operationId: z.string().min(1).max(240).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, (input) => getAgentEvidenceTraces(currentGraph(), input));

  register("get_semantic_suggestion_feedback", {
    title: "Get semantic suggestion feedback",
    description: "Return the current or stale local human feedback history for one deterministic semantic suggestion. Feedback labels are not human verification, runtime evidence, test proof, or model-quality calibration.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
    },
  }, ({ flowId, scope = "application" }) => {
    const feedback = getSemanticSuggestionFeedback(currentGraph(), flowId, scope);
    if (!feedback) throw new Error(`Flow not found: ${flowId}`);
    return feedback;
  });

  register("get_agent_semantic_proposal", {
    title: "Get agent semantic proposal",
    description: "Return the current or stale provider/agent proposal overlay for one flow. It is unverified metadata and never overrides parser facts, deterministic suggestion, human feedback, or human verification.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
    },
  }, ({ flowId, scope = "application" }) => {
    const proposal = getAgentSemanticProposal(currentGraph(), flowId, scope);
    if (!proposal) throw new Error(`Flow not found: ${flowId}`);
    return proposal;
  });

  registerMetadataWrite("record_agent_semantic_proposal", {
    title: "Propose flow semantics for human review",
    description: "Append an idempotent provider/agent proposal for a current Flow Context Ref. The proposal may prefill a human draft but cannot verify a flow, replace parser facts, or modify source. Never include source bodies, prompts, private reasoning, credentials, or raw logs.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
      operationId: z.string().min(1).max(240),
      expectedFlowContextRef: z.string().min(1).max(8192),
      candidate: z.object({
        title: z.string().min(1).max(240),
        technicalPurpose: z.string().min(1).max(4000),
        role: z.string().min(1).max(120),
        grouping: z.object({ key: z.string().min(1).max(120), label: z.string().min(1).max(240) }),
        owner: z.string().min(1).max(240).optional(),
        risk: z.enum(["low", "medium", "high", "critical", "unknown"]).optional(),
        questions: z.array(z.string().min(1).max(800)).max(20).optional(),
      }),
      proposedBy: z.string().min(1).max(240),
      provider: z.string().min(1).max(240),
      rationale: z.string().min(1).max(2000),
    },
  }, ({ flowId, scope = "application", ...input }) => {
    const result = recordAgentSemanticProposal(currentGraph(), flowId, input, scope);
    if (!result) throw new Error(`Flow not found: ${flowId}`);
    return result;
  });

  registerMetadataWrite("record_semantic_suggestion_feedback", {
    title: "Record semantic suggestion feedback",
    description: "Append idempotent local human feedback for the server-calculated current semantic suggestion of one flow. It can accept, edit, reject, or confirm abstention, but never creates human verification or writes repository source. Supply concise outcomes only; never submit source content, prompts, private reasoning, credentials, or raw logs.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
      operationId: z.string().min(1).max(240),
      decision: z.enum(["accepted", "edited", "rejected", "abstained"]),
      reason: z.string().min(1).max(2000).optional(),
      editedCandidate: z.object({
        title: z.string().min(1).max(240),
        technicalPurpose: z.string().min(1).max(4000),
        role: z.string().min(1).max(120),
        grouping: z.object({ key: z.string().min(1).max(120), label: z.string().min(1).max(240) }),
      }).optional(),
      reviewedBy: z.string().min(1).max(240),
      traceOperationId: z.string().min(1).max(240).optional(),
    },
  }, ({ flowId, scope = "application", ...input }) => {
    const result = recordSemanticSuggestionFeedback(currentGraph(), flowId, input, scope);
    if (!result) throw new Error(`Flow not found: ${flowId}`);
    return result;
  });

  registerMetadataWrite("record_agent_evidence_trace", {
    title: "Record agent evidence trace",
    description: "Append idempotent local audit metadata for an agent action. This writes only .flowpeek/agent-evidence-traces.json and cannot write repository source or create human verification. Supply concise outcomes only; never submit prompts, private reasoning, source content, credentials, or raw logs. Reusing operationId with identical input returns the existing immutable record.",
    inputSchema: {
      operationId: z.string().min(1).max(240),
      contextRef: z.string().min(1).max(8192),
      actionType: z.enum(["inspect", "plan", "edit", "refactor", "test", "verify", "document", "other"]),
      actionSummary: z.string().min(1).max(2000),
      changedPaths: z.array(z.string().min(1).max(2048)).max(100).optional(),
      verificationStatus: z.enum(["not-run", "passed", "failed", "partial", "unknown"]),
      verificationSummary: z.string().min(1).max(2000),
      actor: z.string().min(1).max(240),
    },
  }, (input) => recordAgentEvidenceTrace(currentGraph(), input));

  register("create_git_snapshot", {
    title: "Create persistent Git graph snapshot",
    description: "Scan a Git commit through a temporary archive, then store its static graph locally in .flowpeek/history. The working tree is not checked out or modified.",
    inputSchema: {
      ref: z.string().min(1).max(240).optional(),
      force: z.boolean().optional(),
    },
  }, ({ ref = "HEAD", force = false }) => {
    const result = createGitSnapshot(root, { ref, force });
    return {
      created: result.created,
      path: result.path,
      commit: result.snapshot.commit,
      stats: result.snapshot.graph.stats,
      limitation: "The snapshot is static commit content, excludes uncommitted changes, and does not execute code or configuration.",
    };
  });

  register("compare_git_snapshots", {
    title: "Compare persistent Git graph snapshots",
    description: "Create or reuse local snapshots for two Git commits and compare static node, edge, and flow topology. This is not a runtime trace or source-level semantic diff.",
    inputSchema: {
      from: z.string().min(1).max(240).optional(),
      to: z.string().min(1).max(240).optional(),
    },
  }, ({ from = "HEAD~1", to = "HEAD" }) => compareGitSnapshots(root, { from, to }));

  register("refresh_graph", {
    title: "Refresh the local Flowpeek graph",
    description: "Reconcile the configured repository after code changes, reusing parser facts whose file fingerprint is unchanged, persist a versioned static graph state and bounded adjacent delta, and return its identity. Supply changed repository-relative paths when known so topology-neutral source edits remain attributable. The source code is read-only to Flowpeek.",
    inputSchema: {
      paths: z.array(z.string().min(1).max(2048)).max(100).optional(),
    },
  }, ({ paths }) => {
    const { graph: refreshed, delta } = refresh(paths, "agent-refresh");
    return {
      refreshedAt: refreshed.generatedAt,
      project: refreshed.project,
      graphState: refreshed.state,
      stats: refreshed.stats,
      refresh: refreshed.analysis.refresh,
      cache: options.cache === false ? "disabled" : path.join(root, ".flowpeek", "graph.json"),
      cacheState: refreshed.analysis.cacheState,
      derivedCacheInvalidation: refreshed.analysis.derivedCacheInvalidation,
      delta,
      persistedDelta: refreshed.analysis.latestDelta || null,
      changedContexts: getChangedContexts(refreshed, { fromVersion: refreshed.analysis.latestDelta?.fromGraphVersion, toVersion: refreshed.analysis.latestDelta?.toGraphVersion }),
      agentContext: projectView(refreshed, { mode: "overview", scope: "application" }).aiContext,
    };
  });

  return { server, root, refresh };
}

async function runMcpServer(options) {
  const [{ StdioServerTransport }, instance] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    createMcpServer(options),
  ]);
  const transport = new StdioServerTransport();
  await instance.server.connect(transport);
  process.stderr.write(`Flowpeek MCP connected for ${instance.root}\n`);
  return instance;
}

module.exports = { createMcpServer, runMcpServer };
