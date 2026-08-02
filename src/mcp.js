const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const packageInfo = require("../package.json");
const { assignWorkflow, availableGraphDelta, createContinuationCheckpoint, createPlannedOverlay, createWorkRecord, findNodes, getActiveBranchGitEvidence, getAgentBootstrap, getAgentEvidenceTraces, getAgentSemanticProposal, getCacheHygiene, getChangeImpact, getChangedContexts, getCheckpointDivergence, getContextCard, getContinuationCheckpoint, getContinuationComparison, getContinuationContext, getEntryFlows, getFlowComparison, getFlowProjection, getFlowVerification, getGitContextContinuity, getGraphDelta, getHandoffContext, getNodeDetails, getPlanReconciliation, getPlannedOverlay, getProductProof, getRelatedImplementations, getRelatedTests, getRequestFlows, getSemanticSuggestionFeedback, getTestRuns, getTrustAnalytics, getVerifiedSemanticMemory, getWorkDependencyStatus, getWorkRecordWorkflow, getWorkTimeline, latestAvailableGraphDelta, listContinuationCheckpoints, listPlanReconciliations, listPlannedOverlays, listWorkRecords, listWorkflows, projectView, recordAgentEvidenceTrace, recordAgentSemanticProposal, recordPlanReconciliation, recordSemanticSuggestionFeedback, recordTestRunEvent, recordWorkEvent, resolveContextRef, resolvePlanRef, saveWorkflow, transitionWorkRecord, updateWorkPlan } = require("./graph-service");
const { createScanCoordinator } = require("./scan-coordinator");
const { compareGitSnapshots, createGitSnapshot } = require("./history");
const { DEFAULT_FLOW_LENS_MAX_STEPS, MAX_FLOW_LENS_STEPS, MIN_FLOW_LENS_STEPS } = require("./flow-lens-options");
const { createSurfaceCoreRuntime } = require("./core-runtime");
const { MATERIALIZED, mcpSurfaceCategory } = require("./native-surface-contract");
const { canonicalRealpath } = require("./canonical-path");

function graphDeltaCompatibilityProjection(delta, previousGraph, graph) {
  if (!delta || delta.available === true) return delta;
  if (delta.schemaVersion !== "flopeek-delta/v1") return delta;
  return {
    available: true,
    compared: {
      projectId: delta.projectId,
      previousGraphVersion: delta.fromGraphVersion,
      graphVersion: delta.toGraphVersion,
      previousGeneratedAt: previousGraph?.generatedAt || null,
      generatedAt: graph?.generatedAt || delta.generatedAt || null,
    },
    summary: delta.summary,
    addedNodes: delta.nodes?.added || [],
    removedNodes: delta.nodes?.removed || [],
    addedEdges: delta.edges?.added || [],
    removedEdges: delta.edges?.removed || [],
    truncated: delta.truncated === true,
    limitation: "This projects the authoritative adjacent static delta as topology changes. It is not a source diff, Git diff, or runtime behavior diff.",
  };
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return { content: [{ type: "text", text: `Flopeek error: ${error.message}` }], isError: true };
}

async function createMcpServer(options) {
  const [{ McpServer }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("zod"),
  ]);
  const root = canonicalRealpath(options.root);
  if (!fs.statSync(root).isDirectory()) throw new Error("MCP repository target must be a directory.");
  const ownsCoreClient = options.ownsCoreClient === true || !options.coreClient;
  const runtime = options.coreClient ? null : createSurfaceCoreRuntime(options);
  const core = options.coreClient || runtime.core;
  let closeCorePromise = null;
  const closeOwnedCore = () => {
    if (!ownsCoreClient) return Promise.resolve();
    if (!closeCorePromise) closeCorePromise = Promise.resolve(core.close?.());
    return closeCorePromise;
  };
  const coordinator = createScanCoordinator(root, {
    coreClient: core,
    coreRuntime: runtime?.selection || options.coreRuntime,
    cache: options.cache,
    timeBudgetMs: options.timeBudgetMs,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    packagePath: options.packagePath,
    analysisDelayMs: options.analysisDelayMs,
    nativeGraphHandle: true,
  });
  let graph;
  let previousGraph = null;
  let initialScanPromise = null;
  const materializedGraphs = new WeakMap();
  const graphContext = new AsyncLocalStorage();
  const refresh = async (changedPaths = null, reason = "agent-refresh") => {
    const result = await coordinator.refresh(changedPaths, reason);
    previousGraph = result.previousGraph;
    graph = result.graph;
    if (!graph) throw new Error(`Flopeek scan ${result.outcome.status}: ${result.outcome.failure?.message || result.outcome.reason || "no complete graph is available"}.`);
    const delta = await core.getGraphDelta(graph, {
      previousGraph,
      fromVersion: previousGraph?.state?.graphVersion,
      toVersion: graph.state?.graphVersion,
    });
    return { graph, delta, scanOutcome: result.outcome };
  };
  const currentGraph = () => {
    const scoped = graphContext.getStore();
    if (scoped) return scoped;
    if (graph) return graph;
    const outcome = coordinator.currentOutcome();
    const error = new Error(`No complete Flopeek graph is available while the scan status is ${outcome.status}. Call get_scan_status and wait for a complete/current graph, or inspect source directly.`);
    error.code = "FLOPEEK_GRAPH_NOT_READY";
    throw error;
  };
  const currentMaterializedGraph = async () => {
    const current = graph;
    if (!current) return currentGraph();
    if (Array.isArray(current.nodes)) return current;
    let pending = materializedGraphs.get(current);
    if (!pending) {
      pending = Promise.resolve(core.materializeGraph(current)).then((materialized) => {
        if (!materialized || !Array.isArray(materialized.nodes)
          || materialized.project?.projectId !== current.project?.projectId
          || materialized.state?.graphVersion !== current.state?.graphVersion) {
          throw new Error("CoreClient materialization did not match the current graph handle.");
        }
        return materialized;
      });
      materializedGraphs.set(current, pending);
    }
    return pending;
  };
  const startInitialScan = () => {
    if (!initialScanPromise) initialScanPromise = refresh(null, "mcp-initial");
    return initialScanPromise;
  };
  if (!options.deferInitialScan) await startInitialScan();

  const server = new McpServer({ name: "flopeek", version: packageInfo.version });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const metadataWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const scanControl = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const registerWithAnnotations = (name, config, annotations, handler) => {
    server.registerTool(name, { ...config, annotations }, async (input) => {
      try {
        const execute = () => handler(input);
        const value = mcpSurfaceCategory(name) === MATERIALIZED
          ? await graphContext.run(await currentMaterializedGraph(), execute)
          : await execute();
        return jsonResult(value);
      } catch (error) {
        return errorResult(error);
      }
    });
  };
  const register = (name, config, handler) => registerWithAnnotations(name, config, readOnly, handler);
  const registerMetadataWrite = (name, config, handler) => registerWithAnnotations(name, config, metadataWrite, handler);

  register("get_agent_bootstrap", {
    title: "Get the Flopeek agent bootstrap",
    description: "Start here. Return the current graph identity, parser coverage, readiness, recommended evidence workflow, and non-overclaiming policy shared by every supported agent host.",
    inputSchema: {},
  }, () => core.getScanStatus(graph, {
    scanOutcome: coordinator.currentOutcome(),
    project: {
      name: path.basename(root),
      branch: null,
      revision: null,
    },
  }));

  register("get_scan_status", {
    title: "Get the current Flopeek scan status",
    description: "Return the shared terminal scan outcome, declared bounds, active complete-graph source, separate scoped-source and attached-Git-HEAD freshness, and cache-promotion state. A stale-unverified fallback is never a partial graph.",
    inputSchema: {},
  }, () => coordinator.currentOutcome());

  register("get_cache_hygiene", {
    title: "Inspect local Flopeek cache hygiene",
    description: "Return local Flopeek cache size, registered derived-artifact retention, stale-record counts, and the explicit manual-prune boundary. This is metadata only; it never deletes files or claims cross-version cache reuse.",
    inputSchema: {},
  }, () => getCacheHygiene(currentGraph()));

  registerWithAnnotations("cancel_scan", {
    title: "Cancel the active bounded Flopeek scan",
    description: "Request cancellation of the active bounded scan. This does not modify repository source or promote an incomplete graph. Unbounded scans are explicitly not interruptible.",
    inputSchema: {},
  }, scanControl, () => coordinator.cancel());

  register("get_project_overview", {
    title: "Get project overview",
    description: "Return an aggregate technical map. Summary nodes and derived edges are not source files, service boundaries, or runtime traces. Use get_node before planning a code change.",
    inputSchema: {
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
    },
  }, ({ scope = "application" }) => core.getProjectOverview(currentGraph(), { mode: "overview", scope }));

  register("get_view_projection", {
    title: "Get a bounded technical view projection",
    description: "Return a version-bound, bounded static view for a requested map mode, scope, and optional focused node. The response reports displayed and omitted nodes/edges; it is not an unbounded repository graph or runtime trace.",
    inputSchema: {
      mode: z.enum(["overview", "requests", "dependencies"]).optional(),
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
      level: z.enum(["domain", "feature", "component", "symbol"]).optional(),
      focus: z.string().min(1).max(2048).optional(),
      maxNodes: z.number().int().min(1).max(100).optional(),
      maxEdges: z.number().int().min(1).max(200).optional(),
    },
  }, ({ mode = "overview", scope = "application", level = "feature", focus = null, maxNodes, maxEdges }) => core.getProjectOverview(currentGraph(), { mode, scope, level, focus, maxNodes, maxEdges }));

  register("find_nodes", {
    title: "Find code graph nodes",
    description: "Find exact graph candidates by plain-text label, path, feature, domain, or type. This is a deterministic graph lookup; it does not search source text or infer intent.",
    inputSchema: {
      query: z.string().min(1).max(240),
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
    },
  }, ({ query, scope = "application" }) => core.findNodes(currentGraph(), { query, scope }));

  register("get_node", {
    title: "Get raw node evidence",
    description: "Return one original node with direct incoming and outgoing parser facts, source evidence, and manually verified description. Call this before interpreting a summary node as implementation detail.",
    inputSchema: { id: z.string().min(1).max(2048) },
  }, async ({ id }) => {
    const detail = await core.getNode(currentGraph(), id);
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
  }, ({ id, scope = "application" }) => core.getProjectOverview(currentGraph(), { mode: "dependencies", scope, focus: id }));

  register("get_request_flows", {
    title: "Get detected entry flows (legacy request alias)",
    description: "Return supported static HTTP/request, command, and scheduler-entry traversals. This legacy alias remains available for compatibility; use get_entry_flows for new integrations. These are technical graph paths only; they do not claim command invocation, scheduling, business flow, or runtime order.",
    inputSchema: {
      endpoint: z.string().max(240).optional(),
      scope: z.enum(["application", "all"]).optional(),
    },
  }, ({ endpoint = "", scope = "application" }) => core.getRequestFlows(currentGraph(), endpoint, scope));

  register("get_entry_flows", {
    title: "Get detected entry flows",
    description: "Return static traversals from supported detected entry facts: HTTP/request entries, literal package scripts that directly target one scanned source file, a narrow Python framework-command declaration subset, and literal node-cron schedules targeting one local top-level function. These are technical graph paths only; they do not claim command invocation, framework registration or initialization, scheduler initialization, task execution, business flow, or runtime order.",
    inputSchema: {
      query: z.string().max(240).optional(),
      scope: z.enum(["application", "all"]).optional(),
    },
  }, ({ query = "", scope = "application" }) => core.getEntryFlows(currentGraph(), query, scope));

  register("get_flow_projection", {
    title: "Get an evidence-rich Flow Lens",
    description: "Return one bounded static flow from a supported entry family with derived step roles, direct parser-edge evidence, static boundaries, ambiguity, and truncation. It is not a runtime trace or business-process claim. Inspect a step Context Card before proposing a change.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      scope: z.enum(["application", "all"]).optional(),
      maxSteps: z.number().int().min(MIN_FLOW_LENS_STEPS).max(MAX_FLOW_LENS_STEPS).optional(),
    },
  }, async ({ flowId, scope = "application", maxSteps = DEFAULT_FLOW_LENS_MAX_STEPS }) => {
    const lens = await core.getFlowProjection(currentGraph(), flowId, scope, { maxSteps });
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
  }, ({ paths, maxDepth = 6 }) => core.getChangeImpact(currentGraph(), paths, {
    maxDepth,
    previousGraph,
    previousGraphVersion: previousGraph?.state?.graphVersion,
  }));

  register("get_related_tests", {
    title: "Get directly related tests",
    description: "Return test files that have direct parser relationships with a node. Missing results do not prove that behavioral coverage does not exist.",
    inputSchema: { id: z.string().min(1).max(2048) },
  }, async ({ id }) => {
    const tests = await core.getRelatedTests(currentGraph(), id);
    if (!tests) throw new Error(`Node not found: ${id}`);
    return tests;
  });

  register("get_agent_context", {
    title: "Get evidence and interpretation limits",
    description: "Return Flopeek's machine-readable interpretation rules, parser coverage, uncertainty policy, and the selected projection's meaning. Use this at the start of work and after refresh_graph.",
    inputSchema: {
      mode: z.enum(["overview", "requests", "dependencies"]).optional(),
      scope: z.enum(["application", "runtime", "framework", "devtool", "all"]).optional(),
      focusId: z.string().max(2048).optional(),
    },
  }, async ({ mode = "overview", scope = "application", focusId }) => (await core.getProjectOverview(currentGraph(), { mode, scope, focus: focusId })).aiContext);

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
      tokenizerId: z.literal("flopeek-char4-estimator/v1").optional(),
    },
  }, (input) => getHandoffContext(currentGraph(), input));

  register("get_graph_delta", {
    title: "Get available graph delta",
    description: "Return the available adjacent static graph delta for this graph session. Cache-disabled sessions expose only their current in-memory adjacent delta and never read a persisted delta from another session. An absent delta is explicit; it is never reconstructed as runtime behavior.",
    inputSchema: {
      fromVersion: z.number().int().min(0).optional(),
      toVersion: z.number().int().min(1).optional(),
    },
  }, async ({ fromVersion, toVersion }) => {
    const delta = await core.getGraphDelta(currentGraph(), { fromVersion, toVersion });
    if (!delta) throw new Error("No matching graph delta was found.");
    return delta;
  });

  register("get_changed_contexts", {
    title: "Get changed Context Cards and Flow Lenses",
    description: "Return bounded current or historical technical contexts affected by one retained adjacent graph delta. Results include Context Refs and Flow Lens IDs, but do not prove runtime behavior or reconstruct a full historical card.",
    inputSchema: {
      fromVersion: z.number().int().min(0).optional(),
      toVersion: z.number().int().min(1).optional(),
    },
  }, ({ fromVersion, toVersion }) => core.getChangedContexts(currentGraph(), { fromVersion, toVersion }));

  register("get_related_implementations", {
    title: "Find repeated static implementation conventions",
    description: "Return bounded same-extension source-file candidates sharing at least two exact class, id, data-attribute, or inline-handler tokens with a file Context Ref. It returns no source bodies and never proves UI behavior, runtime wiring, semantic equivalence, or ownership.",
    inputSchema: { contextRef: z.string().min(1).max(8192) },
  }, ({ contextRef }) => getRelatedImplementations(currentGraph(), contextRef));

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
    description: "Return a bounded versioned Context Packet for one detected static flow. JSON is the default; Markdown is a portable human/agent handoff. It contains no source-file body, credentials, runtime history, or business rationale.",
    inputSchema: {
      flowId: z.string().min(1).max(4096),
      format: z.enum(["json", "markdown"]).optional(),
      scope: z.enum(["application", "all"]).optional(),
      maxSteps: z.number().int().min(MIN_FLOW_LENS_STEPS).max(MAX_FLOW_LENS_STEPS).optional(),
    },
  }, async ({ flowId, format = "json", scope = "application", maxSteps = DEFAULT_FLOW_LENS_MAX_STEPS }) => {
    const card = await core.getFlowContextCard(currentGraph(), flowId, format, scope, { maxSteps });
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
    description: "Return a bounded project-local index backed by human flow-verification metadata in .flopeek. Only current or compatible records are reusable by default. This is not an embedded model, training dataset claim, or authority to auto-verify another flow.",
    inputSchema: {
      query: z.string().max(240).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeStale: z.boolean().optional(),
    },
  }, (input) => getVerifiedSemanticMemory(currentGraph(), input));

  register("get_test_runs", {
    title: "Get bounded test-run progress evidence",
    description: "Return explicit runner-adapter events grouped into runs, including current static step or failing stop step. Flopeek does not execute commands, capture raw logs, or infer runtime order from the static graph.",
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

  register("list_workflows", {
    title: "List local delivery workflows",
    description: "Return built-in and validated local custom workflow definitions. Templates describe allowed metadata transitions; they do not execute work or prove completion.",
    inputSchema: {},
  }, () => listWorkflows(currentGraph()));

  register("list_work_records", {
    title: "List local delivery work records",
    description: "Return bounded planned work records plus append-only local delivery events. Work status and evidence references remain separate from parser facts and runtime proof.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, (input) => listWorkRecords(currentGraph(), input));

  register("get_work_timeline", {
    title: "Get planned and actual delivery timeline",
    description: "Return editable planned windows and append-only actual local events for one work record or the bounded local ledger. It is not a runtime trace.",
    inputSchema: { recordId: z.string().min(1).max(120).optional() },
  }, ({ recordId } = {}) => getWorkTimeline(currentGraph(), recordId || null));

  register("get_work_record_workflow", {
    title: "Get a work record workflow state",
    description: "Derive one record's workflow state from append-only local delivery events. This does not change or prove static repository evidence.",
    inputSchema: { recordId: z.string().min(1).max(120) },
  }, ({ recordId }) => getWorkRecordWorkflow(currentGraph(), recordId));

  register("get_work_dependency_status", {
    title: "Get declared work dependency readiness",
    description: "Return one work record's declared local dependency readiness before built-in implementation entry. It uses only work-record and workflow metadata; ready never proves source implementation, tests, approval, release, runtime behavior, or external state.",
    inputSchema: { recordId: z.string().min(1).max(120) },
  }, ({ recordId }) => getWorkDependencyStatus(currentGraph(), recordId));

  register("list_continuation_checkpoints", {
    title: "List local continuation checkpoints",
    description: "Return immutable local delivery-plan checkpoints with their recorded Git/source and graph baseline plus current freshness. Listing does not create a checkpoint or turn plan metadata into technical facts.",
    inputSchema: {},
  }, () => listContinuationCheckpoints(currentGraph()));

  register("get_continuation_checkpoint", {
    title: "Get one local continuation checkpoint",
    description: "Return one immutable local continuation checkpoint and its current freshness. It is a delivery-plan artifact, not source evidence, implementation proof, test proof, approval authority, or runtime observation.",
    inputSchema: { checkpointId: z.string().min(1).max(160) },
  }, ({ checkpointId }) => getContinuationCheckpoint(currentGraph(), checkpointId));

  register("get_continuation_comparison", {
    title: "Compare a continuation baseline, plan, and current context",
    description: "Return a deterministic Baseline/Planned/Current comparison for one exact checkpoint and planned overlay. It uses retained metadata, current Context Ref resolution, and append-only reconciliation only; it never infers missing implementation or uses AI/similarity matching.",
    inputSchema: { checkpointId: z.string().min(1).max(160), overlayId: z.string().min(1).max(160) },
  }, ({ checkpointId, overlayId }) => getContinuationComparison(currentGraph(), { checkpointId, overlayId }));

  register("get_checkpoint_divergence", {
    title: "Get read-only local checkpoint divergence",
    description: "Compare a checkpoint baseline with local Git/source state without fetch, checkout, merge, rebase, or ref mutation. Diverged does not claim a merge conflict.",
    inputSchema: { checkpointId: z.string().min(1).max(160) },
  }, ({ checkpointId }) => getCheckpointDivergence(currentGraph(), checkpointId));

  register("get_continuation_context", {
    title: "Get bounded continuation context for an agent",
    description: "Return one versioned, token-bounded continuation packet from a checkpoint and optional exact planned overlay. It contains no source body, shell, credential, or execution surface and reports stale or omitted Context Refs explicitly.",
    inputSchema: { checkpointId: z.string().min(1).max(160), overlayId: z.string().min(1).max(160).optional(), tokenBudget: z.number().int().min(1024).max(16384).optional() },
  }, ({ checkpointId, overlayId, tokenBudget }) => getContinuationContext(currentGraph(), { checkpointId, overlayId, tokenBudget }));

  register("list_planned_overlays", {
    title: "List immutable local planned overlays",
    description: "Return immutable delivery-plan overlays and their exact checkpoint freshness. Planned nodes and relationships remain outside the factual technical graph, Flow Lens, impact, search, parser coverage, and runtime evidence.",
    inputSchema: {},
  }, () => listPlannedOverlays(currentGraph()));

  register("get_planned_overlay", {
    title: "Get one immutable local planned overlay",
    description: "Return one delivery-plan overlay with Plan Refs for its planned nodes. This is not source evidence, a factual dependency, implementation proof, runtime observation, or verification result.",
    inputSchema: { overlayId: z.string().min(1).max(160) },
  }, ({ overlayId }) => getPlannedOverlay(currentGraph(), overlayId));

  register("resolve_plan_ref", {
    title: "Resolve one versioned Plan Ref",
    description: "Resolve only the exact fpp://local Plan Ref retained locally. A stale anchor remains explicit and Flopeek never redirects it to a current Context Ref, source node, or another plan.",
    inputSchema: { planRef: z.string().min(1).max(8192) },
  }, ({ planRef }) => resolvePlanRef(currentGraph(), planRef));

  register("list_plan_reconciliations", {
    title: "List append-only local plan reconciliations",
    description: "Return human, agent, or tool delivery assertions that link one exact Plan Ref to zero or more technical Context Refs. This does not change parser facts, Flow Lens, impact, test proof, runtime evidence, or approval authority.",
    inputSchema: { planRef: z.string().min(1).max(8192).optional() },
  }, ({ planRef } = {}) => listPlanReconciliations(currentGraph(), { planRef: planRef || null }));

  register("get_plan_reconciliation", {
    title: "Get one append-only local plan reconciliation",
    description: "Return one reconciliation record and current resolutions for its exact plan and actual references. Agent records remain proposals and never become human confirmation.",
    inputSchema: { reconciliationId: z.string().min(1).max(160) },
  }, ({ reconciliationId }) => getPlanReconciliation(currentGraph(), reconciliationId));

  const deliveryEvidence = z.array(z.object({ kind: z.string().min(1).max(80), reference: z.string().min(1).max(800), evidenceClass: z.string().min(1).max(80) })).max(100);
  const continuationCheckpointInput = z.object({
    operationId: z.string().min(1).max(240),
    id: z.string().min(1).max(160),
    expectedGraphVersion: z.number().int().min(0),
    handoffWorkspaceId: z.string().min(1).max(160).optional(),
    workRecordIds: z.array(z.string().min(1).max(160)).max(200).optional(),
    completedWorkRecordIds: z.array(z.string().min(1).max(160)).max(200).optional(),
    remainingWorkRecordIds: z.array(z.string().min(1).max(160)).max(200).optional(),
    selectedContextRefs: z.array(z.string().min(1).max(8192)).min(1).max(100),
    constraints: z.array(z.string().min(1).max(1200)).max(100).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(1200)).max(100).optional(),
    unresolvedQuestions: z.array(z.string().min(1).max(1200)).max(100).optional(),
    createdBy: z.string().min(1).max(240),
    createdByKind: z.enum(["human", "agent", "tool"]),
    supersedes: z.string().min(1).max(160).optional(),
  }).strict();
  registerMetadataWrite("create_continuation_checkpoint", {
    title: "Create an immutable local continuation checkpoint",
    description: "Write bounded local delivery-plan metadata tied to the exact current graph and selected current Context Refs. It rejects source bodies, raw logs, credentials, machine paths, private reasoning, stale context, and unknown fields; it never changes source or parser facts.",
    inputSchema: continuationCheckpointInput,
  }, (input) => createContinuationCheckpoint(currentGraph(), input));
  const plannedNodeEndpoint = z.union([
    z.object({ kind: z.literal("planned-node"), plannedNodeId: z.string().min(1).max(160) }).strict(),
    z.object({ kind: z.literal("context-ref"), contextRef: z.string().min(1).max(8192) }).strict(),
  ]);
  const plannedOverlayInput = z.object({
    operationId: z.string().min(1).max(240),
    id: z.string().min(1).max(160),
    expectedGraphVersion: z.number().int().min(0),
    checkpointId: z.string().min(1).max(160),
    nodes: z.array(z.object({
      id: z.string().min(1).max(160),
      kind: z.enum(["endpoint", "service", "module", "function", "database", "queue", "external", "test", "boundary", "other"]),
      title: z.string().min(1).max(240),
      responsibility: z.string().min(1).max(1200).optional(),
      acceptanceCriteria: z.array(z.string().min(1).max(1200)).max(100).optional(),
      anchors: z.array(z.string().min(1).max(8192)).min(1).max(100),
      candidatePath: z.string().min(1).max(1200).optional(),
    }).strict()).min(1).max(200),
    edges: z.array(z.object({
      relationship: z.enum(["planned_after", "planned_to_call", "planned_to_use", "planned_to_extend", "planned_to_replace", "planned_to_publish", "planned_to_subscribe", "planned_to_verify"]),
      source: plannedNodeEndpoint,
      target: plannedNodeEndpoint,
    }).strict()).max(500).optional(),
    createdBy: z.string().min(1).max(240),
    createdByKind: z.enum(["human", "agent", "tool"]),
  }).strict();
  registerMetadataWrite("create_planned_overlay", {
    title: "Create an immutable local planned overlay",
    description: "Write an exact delivery-plan overlay against one current checkpoint and its selected current Context Refs. It rejects source bodies, raw logs, credentials, machine paths, private reasoning, unselected anchors, factual relationships, and unknown fields. It never changes source or factual graph evidence.",
    inputSchema: plannedOverlayInput,
  }, (input) => createPlannedOverlay(currentGraph(), input));
  const reconciliationEvidenceReference = z.object({ kind: z.string().min(1).max(80), reference: z.string().min(1).max(800), evidenceClass: z.string().min(1).max(80) }).strict();
  const planReconciliationInput = z.object({
    operationId: z.string().min(1).max(240),
    id: z.string().min(1).max(160),
    planRef: z.string().min(1).max(8192),
    actualContextRefs: z.array(z.string().min(1).max(8192)).max(100).optional(),
    outcome: z.enum(["confirmed-implemented", "partially-implemented", "implemented-differently", "not-the-same", "superseded", "unresolved"]),
    actor: z.string().min(1).max(240),
    actorKind: z.enum(["human", "agent", "tool"]),
    evidenceReferences: z.array(reconciliationEvidenceReference).max(100).optional(),
    supersedes: z.string().min(1).max(160).optional(),
  }).strict();
  registerMetadataWrite("record_plan_reconciliation", {
    title: "Record an append-only local plan reconciliation",
    description: "Record one exact Plan Ref outcome against zero or more technical Context Refs. Positive implementation outcomes require human authorship and current actual Context Refs. This metadata never changes source, parser facts, Flow Lens, impact, test proof, runtime evidence, or approval authority.",
    inputSchema: planReconciliationInput,
  }, (input) => recordPlanReconciliation(currentGraph(), input));
  registerMetadataWrite("create_work_record", {
    title: "Create a local delivery work record",
    description: "Create a project-local planned work record linked to optional Context Refs. It writes only Flopeek metadata and never changes source, graph facts, or workflow completion.",
    inputSchema: { operationId: z.string().min(1).max(240), id: z.string().min(1).max(120), kind: z.enum(["objective", "requirement", "decision", "task", "checkpoint", "approval", "test-result", "review", "release", "observation", "incident"]), title: z.string().min(1).max(240), owner: z.string().min(1).max(240).optional(), dependencies: z.array(z.string().min(1).max(120)).max(200).optional(), contextRefs: z.array(z.string().min(1).max(8192)).max(100).optional(), plannedStart: z.string().min(1).max(80).optional(), plannedEnd: z.string().min(1).max(80).optional(), createdBy: z.string().min(1).max(240), createdAt: z.string().min(1).max(80) },
  }, (input) => createWorkRecord(currentGraph(), input));

  registerMetadataWrite("record_work_event", {
    title: "Record append-only local delivery evidence",
    description: "Append concise declared delivery evidence to a local work record. It does not accept source bodies, raw logs, credentials, or private reasoning, and does not independently prove runtime behavior.",
    inputSchema: { operationId: z.string().min(1).max(240), recordId: z.string().min(1).max(120), eventType: z.enum(["evidence-recorded", "approval-recorded", "release-recorded", "observation-recorded", "note-recorded"]), summary: z.string().min(1).max(1200), actor: z.string().min(1).max(240), observedAt: z.string().min(1).max(80), evidence: deliveryEvidence.optional() },
  }, (input) => recordWorkEvent(currentGraph(), input));

  registerMetadataWrite("assign_workflow", {
    title: "Assign a workflow to a local work record",
    description: "Append one local workflow assignment at the template's initial state. Assignment is local metadata and does not establish implementation, approval, or release evidence.",
    inputSchema: { operationId: z.string().min(1).max(240), recordId: z.string().min(1).max(120), workflowId: z.string().min(1).max(120), actor: z.string().min(1).max(240), observedAt: z.string().min(1).max(80) },
  }, (input) => assignWorkflow(currentGraph(), input));

  registerMetadataWrite("transition_work_record", {
    title: "Transition a local evidence-gated work record",
    description: "Append a permitted local workflow transition only when its declared evidence kinds are present. It never executes work, verifies a remote approval, or turns a status into technical proof.",
    inputSchema: { operationId: z.string().min(1).max(240), recordId: z.string().min(1).max(120), workflowId: z.string().min(1).max(120), expectedState: z.string().min(1).max(80), targetState: z.string().min(1).max(80), actor: z.string().min(1).max(240), actorRole: z.string().min(1).max(120), observedAt: z.string().min(1).max(80), evidence: deliveryEvidence.optional() },
  }, (input) => transitionWorkRecord(currentGraph(), input));

  register("get_context_card", {
    title: "Get a portable node Context Card",
    description: "Return bounded static evidence for one raw node at the current graph version. JSON is the default Context Packet; Markdown is a portable human handoff. It contains no source-file body, credentials, or runtime claims.",
    inputSchema: {
      id: z.string().min(1).max(2048),
      format: z.enum(["json", "markdown"]).optional(),
    },
  }, async ({ id, format = "json" }) => {
    const card = await core.getContextCard(currentGraph(), id, format);
    if (!card) throw new Error(`Node not found: ${id}`);
    return card;
  });

  register("resolve_context_ref", {
    title: "Resolve a Flopeek Context Ref",
    description: "Resolve a node or flow fp://local Context Ref against the current project. The result explicitly reports current, stale, historical, unresolved, or successor-candidate state and never silently redirects to unrelated evidence.",
    inputSchema: { contextRef: z.string().min(1).max(8192) },
  }, ({ contextRef }) => core.resolveContextRef(currentGraph(), contextRef));

  register("get_active_branch_git_evidence", {
    title: "Get active-branch Git path evidence for a Context Ref",
    description: "Return bounded read-only local Git commits reachable from the current attached branch HEAD that touched the current paths in a current or stale Context Card. This is path-touch evidence only; it does not prove original rationale, runtime behavior, review, test success, or release state.",
    inputSchema: {
      contextRef: z.string().min(1).max(8192),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, ({ contextRef, limit }) => getActiveBranchGitEvidence(currentGraph(), contextRef, { limit }));

  register("get_agent_evidence_traces", {
    title: "Get agent evidence traces",
    description: "Return bounded append-only agent-declared audit records linked to Flopeek Context Refs. Records contain concise outcome summaries, repository-relative changed paths, and declared verification outcomes; callers must not put private reasoning or sensitive/source content in these fields.",
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
    description: "Append idempotent local audit metadata for an agent action. This writes only .flopeek/agent-evidence-traces.json and cannot write repository source or create human verification. Supply concise outcomes only; never submit prompts, private reasoning, source content, credentials, or raw logs. Reusing operationId with identical input returns the existing immutable record.",
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
    description: "Scan a Git commit through a temporary archive, then store its static graph locally in .flopeek/history. The working tree is not checked out or modified.",
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

  register("get_git_context_continuity", {
    title: "Compare one Context Ref across static Git snapshots",
    description: "Resolve one current or stale Context Ref, then compare its exact static node or flow identity and same-path candidates across two local Git-archive snapshots. Same-path candidates are not rename, successor, implementation, runtime, or rationale proof.",
    inputSchema: {
      contextRef: z.string().min(1).max(8192),
      from: z.string().min(1).max(240).optional(),
      to: z.string().min(1).max(240).optional(),
    },
  }, ({ contextRef, from = "HEAD~1", to = "HEAD" }) => getGitContextContinuity(currentGraph(), contextRef, { from, to }));

  register("refresh_graph", {
    title: "Refresh the local Flopeek graph",
    description: "Reconcile the configured repository after code changes, reusing parser facts whose file fingerprint is unchanged, persist a versioned static graph state and bounded adjacent delta, and return its identity. Supply changed repository-relative paths when known so topology-neutral source edits remain attributable. The source code is read-only to Flopeek.",
    inputSchema: {
      paths: z.array(z.string().min(1).max(2048)).max(100).optional(),
    },
  }, async ({ paths }) => {
    const { graph: refreshed, delta, scanOutcome } = await refresh(paths, "agent-refresh");
    return {
      refreshedAt: refreshed.generatedAt,
      project: refreshed.project,
      graphState: refreshed.state,
      stats: refreshed.stats,
      refresh: refreshed.analysis.refresh,
      cache: options.cache === false
        ? "disabled"
        : core.sourceAuthority === "rust"
          ? path.join(root, ".flopeek", "native-core.sqlite3")
          : path.join(root, ".flopeek", "graph.json"),
      cacheState: refreshed.analysis.cacheState,
      derivedCacheInvalidation: refreshed.analysis.derivedCacheInvalidation,
      delta: graphDeltaCompatibilityProjection(delta, previousGraph, refreshed),
      adjacentDelta: refreshed.analysis.latestDelta || null,
      persistedDelta: options.cache === false ? null : refreshed.analysis.latestDelta || null,
      changedContexts: await core.getChangedContexts(refreshed, { fromVersion: refreshed.analysis.latestDelta?.fromGraphVersion, toVersion: refreshed.analysis.latestDelta?.toGraphVersion }),
      scanOutcome,
      agentContext: (await core.getProjectOverview(refreshed, { mode: "overview", scope: "application" })).aiContext,
    };
  });

  let closePromise = null;
  const close = () => {
    if (!closePromise) closePromise = (async () => {
      try {
        await server.close();
      } finally {
        await closeOwnedCore();
      }
    })();
    return closePromise;
  };
  return { server, root, refresh, startInitialScan, coordinator, close };
}

async function runMcpServer(options) {
  const [{ StdioServerTransport }, instance] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    createMcpServer({ ...options, deferInitialScan: true }),
  ]);
  const transport = new StdioServerTransport();
  let initialScanScheduled = false;
  instance.server.server.oninitialized = () => {
    if (initialScanScheduled) return;
    initialScanScheduled = true;
    setImmediate(() => {
      instance.startInitialScan().catch((error) => {
        process.stderr.write(`Flopeek MCP initial scan failed: ${error?.message || "unknown error"}\n`);
      });
    });
  };
  await instance.server.connect(transport);
  transport.onclose = () => instance.close().catch((error) => {
    process.stderr.write(`Flopeek MCP shutdown failed: ${error?.message || "unknown error"}\n`);
  });
  process.stderr.write(`Flopeek MCP connected for ${instance.root}\n`);
  return instance;
}

module.exports = { createMcpServer, runMcpServer };
