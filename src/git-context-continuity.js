"use strict";

const fs = require("node:fs");
const { contextPaths } = require("./active-branch-git-evidence");
const { createGitSnapshot } = require("./history");

const GIT_CONTEXT_CONTINUITY_SCHEMA = "flopeek-git-context-continuity/v1";
const MAX_PATH_CANDIDATES_PER_PATH = 12;

function nodeSummary(node) {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    path: node.path || null,
    line: Number.isSafeInteger(node.line) ? node.line : null,
  };
}

function flowSummary(flow) {
  return {
    id: flow.id,
    title: flow.title,
    entryId: flow.entryId,
    steps: (flow.steps || []).map((step) => ({
      id: step.id,
      label: step.label,
      type: step.type,
      depth: step.depth,
    })),
  };
}

function flowStepSignature(flow) {
  return `${flow.entryId || ""}\u0000${(flow.steps || []).map((step) => step.id).join("\u0000")}`;
}

function cardFlowStepSignature(card) {
  return `${card?.flow?.entryId || ""}\u0000${(card?.projection?.steps || []).map((step) => step.id).join("\u0000")}`;
}

function contextIdentity(card) {
  if (card?.kind === "node") return { kind: "node", id: card.node?.id || null };
  if (card?.kind === "flow") return { kind: "flow", id: card.flow?.id || null };
  return { kind: null, id: null };
}

function pathCandidates(snapshotGraph, paths) {
  const nodes = snapshotGraph.nodes || [];
  return paths.map((relativePath) => {
    const matching = nodes.filter((node) => node.path === relativePath);
    return {
      path: relativePath,
      candidates: matching.slice(0, MAX_PATH_CANDIDATES_PER_PATH).map(nodeSummary),
      totalCandidates: matching.length,
      truncated: matching.length > MAX_PATH_CANDIDATES_PER_PATH,
    };
  });
}

function matchSnapshot(snapshotGraph, card, paths) {
  const identity = contextIdentity(card);
  const candidates = pathCandidates(snapshotGraph, paths);
  if (!identity.id) {
    return {
      status: "unavailable",
      reason: "The resolved Context Card has no stable static identity to compare.",
      pathCandidates: candidates,
    };
  }
  if (identity.kind === "node") {
    const node = (snapshotGraph.nodes || []).find((item) => item.id === identity.id) || null;
    return {
      status: node ? "exact-static-node-present" : "exact-static-node-absent",
      exactStaticNode: node ? nodeSummary(node) : null,
      pathCandidates: candidates,
    };
  }
  const flow = (snapshotGraph.flows || []).find((item) => item.id === identity.id) || null;
  if (!flow) {
    return {
      status: "exact-static-flow-absent",
      exactStaticFlow: null,
      pathCandidates: candidates,
    };
  }
  const sameSteps = cardFlowStepSignature(card) === flowStepSignature(flow);
  return {
    status: sameSteps ? "exact-static-flow-present-same-steps" : "exact-static-flow-present-changed-steps",
    exactStaticFlow: flowSummary(flow),
    pathCandidates: candidates,
  };
}

function unavailable(graph, contextRef, resolution, reason, details = {}) {
  return {
    schemaVersion: GIT_CONTEXT_CONTINUITY_SCHEMA,
    status: "unavailable",
    project: {
      projectId: graph.project.projectId,
      graphVersion: graph.state.graphVersion,
      sourceRevision: graph.state.sourceRevision || null,
    },
    context: {
      requestedRef: contextRef,
      resolutionStatus: resolution?.status || "unresolved",
      resolvedRef: resolution?.resolvedRef || null,
      kind: resolution?.card?.kind || null,
      staticIdentity: contextIdentity(resolution?.card),
      paths: [],
    },
    snapshots: { before: null, after: null },
    requestedRange: { from: details.from || null, to: details.to || null },
    reason,
    limitations: [
      "This result compares only static Git-archive snapshots. It does not check out, fetch, merge, rebase, mutate refs, or execute repository code.",
      "Exact static identity presence is not proof of runtime behavior, original rationale, review, test success, release state, or semantic equivalence after refactoring.",
      "Same-path candidates are not automatic rename, move, successor, or implementation matches. Missing retained evidence is unavailable, not proof that behavior or intent is absent.",
    ],
  };
}

function snapshotProjection(snapshotResult, card, paths) {
  return {
    commit: snapshotResult.snapshot.commit,
    created: snapshotResult.created,
    match: matchSnapshot(snapshotResult.snapshot.graph, card, paths),
  };
}

function getGitContextContinuity(inputRoot, graph, contextRef, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const resolution = options.resolution || null;
  const from = options.from || "HEAD~1";
  const to = options.to || "HEAD";
  if (!resolution || !["current", "stale"].includes(resolution.status) || !resolution.card) {
    return unavailable(graph, contextRef, resolution, "The Context Ref does not resolve to a current or stale Context Card with retained current paths.", { from, to });
  }
  const paths = contextPaths(resolution);
  if (!paths.length) {
    return unavailable(graph, contextRef, resolution, "The resolved Context Card has no safe repository-relative source paths to compare.", { from, to });
  }
  try {
    const before = createGitSnapshot(root, { ref: from });
    const after = createGitSnapshot(root, { ref: to });
    return {
      schemaVersion: GIT_CONTEXT_CONTINUITY_SCHEMA,
      status: "available",
      project: {
        projectId: graph.project.projectId,
        graphVersion: graph.state.graphVersion,
        sourceRevision: graph.state.sourceRevision || null,
      },
      context: {
        requestedRef: contextRef,
        resolutionStatus: resolution.status,
        resolvedRef: resolution.resolvedRef || null,
        kind: resolution.card.kind,
        staticIdentity: contextIdentity(resolution.card),
        paths,
      },
      snapshots: {
        before: snapshotProjection(before, resolution.card, paths),
        after: snapshotProjection(after, resolution.card, paths),
      },
      requestedRange: { from, to },
      limitations: [
        "This result compares static Git-archive snapshots. It excludes uncommitted working-tree changes and does not execute code or configuration.",
        "An exact static node ID or flow ID may remain present while its meaning, runtime behavior, or business purpose changes. A same-path candidate is not an automatic rename, move, successor, or implementation match.",
        "This projection does not reconstruct a historical Context Card, infer rationale, follow renames, inspect every Git ref, or prove review, test success, release state, or runtime behavior.",
        "The result contains no source-file bodies, author identity, credentials, raw Git output, checkout, fetch, merge, rebase, or Git-ref mutation.",
      ],
    };
  } catch {
    return unavailable(graph, contextRef, resolution, "The requested static Git snapshots could not be created from available local commit evidence.", { from, to });
  }
}

module.exports = {
  GIT_CONTEXT_CONTINUITY_SCHEMA,
  MAX_PATH_CANDIDATES_PER_PATH,
  getGitContextContinuity,
};
