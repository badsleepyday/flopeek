"use strict";

const { execFileSync } = require("node:child_process");
const { getContinuationCheckpoint } = require("./continuation-checkpoint");
const { parseContextRef } = require("./context-card");

const CONTINUATION_DIVERGENCE_SCHEMA = "flowpeek-continuation-divergence/v1";
const MAX_CHANGED_PATHS = 100;

function git(root, args, options = {}) {
  try {
    return { ok: true, output: execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    return { ok: false, output: "", detail: String(error.stderr || error.message || "Git command failed.").trim(), status: error.status ?? null, ...options };
  }
}

function boundedPaths(output) {
  const all = String(output || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).sort();
  return { items: all.slice(0, MAX_CHANGED_PATHS), total: all.length, truncated: all.length > MAX_CHANGED_PATHS };
}

function workingTreePaths(root) {
  const paths = new Set();
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const response = git(root, args);
    for (const item of response.output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) paths.add(item);
  }
  return boundedPaths([...paths].join("\n"));
}

function contextFreshness(graph, checkpoint) {
  return checkpoint.selectedContextRefs.map((record) => {
    try {
      const parsed = parseContextRef(record.contextRef);
      const present = parsed.kind === "node"
        ? graph.nodes.some((node) => node.id === parsed.contextId)
        : parsed.kind === "flow"
          ? graph.flows.some((flow) => flow.id === parsed.contextId)
          : false;
      const status = parsed.projectId !== graph.project.projectId || !present ? "unresolved" : parsed.graphVersion === graph.state.graphVersion ? "current" : "stale";
      return { contextRef: record.contextRef, status };
    } catch {
      return { contextRef: record.contextRef, status: "unresolved" };
    }
  });
}

function result(graph, checkpoint, status, detail, options = {}) {
  return {
    schemaVersion: CONTINUATION_DIVERGENCE_SCHEMA,
    status,
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion },
    baseline: { checkpointId: checkpoint.id, gitRevision: checkpoint.baseline.gitRevision, branch: checkpoint.baseline.branch, sourceFingerprint: checkpoint.baseline.sourceFingerprint },
    current: { gitRevision: options.currentRevision || null, branch: options.branch || null, dirty: options.dirty ?? null, sourceFingerprint: graph.state.sourceFingerprint },
    changedPaths: options.changedPaths || { items: [], total: 0, truncated: false },
    selectedContextFreshness: contextFreshness(graph, checkpoint),
    diagnostics: detail ? [{ code: `continuation-divergence-${status}`, message: detail }] : [],
    limitation: "Divergence is a read-only local Git/source comparison. It does not fetch, checkout, merge, rebase, mutate refs, prove a merge conflict, reconstruct historical code, or establish implementation, test, runtime, or approval evidence.",
  };
}

function getCheckpointDivergence(root, graph, checkpointId) {
  const checkpointResult = getContinuationCheckpoint(root, graph, checkpointId);
  if (checkpointResult.status !== "available") return { schemaVersion: CONTINUATION_DIVERGENCE_SCHEMA, status: "unknown", project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion }, baseline: null, current: null, changedPaths: { items: [], total: 0, truncated: false }, selectedContextFreshness: [], diagnostics: checkpointResult.diagnostics || [], limitation: "Checkpoint evidence is unavailable; Flowpeek does not infer local divergence." };
  const checkpoint = checkpointResult.checkpoint;
  const metadata = graph.project.git || {};
  if (metadata.availability === "not-a-repository") return result(graph, checkpoint, "non-git", "The current project is not a readable Git repository.");
  if (metadata.availability !== "available") return result(graph, checkpoint, "unknown", metadata.reason || "Git metadata is unavailable.");
  if (!checkpoint.baseline.gitRevision) return result(graph, checkpoint, "commit-unavailable", "The checkpoint was created without a committed Git revision.", { branch: metadata.branch, dirty: metadata.dirty });
  const baseline = git(root, ["rev-parse", "--verify", `${checkpoint.baseline.gitRevision}^{commit}`]);
  if (!baseline.ok) return result(graph, checkpoint, "commit-unavailable", "The checkpoint Git revision is not available in this local repository.", { branch: metadata.branch, dirty: metadata.dirty });
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.ok) return result(graph, checkpoint, "commit-unavailable", "The local Git HEAD revision is unavailable.", { branch: metadata.branch, dirty: metadata.dirty });
  const currentRevision = head.output;
  const dirtyPaths = workingTreePaths(root);
  const changedPaths = boundedPaths(git(root, ["diff", "--name-only", `${baseline.output}..${currentRevision}`]).output);
  if (baseline.output === currentRevision) return result(graph, checkpoint, metadata.dirty ? "working-tree-changed" : "exact", metadata.dirty ? "The baseline commit matches HEAD, but the working tree has local changes." : "The baseline commit exactly matches local HEAD.", { currentRevision, branch: metadata.branch, dirty: metadata.dirty, changedPaths: metadata.dirty ? dirtyPaths : changedPaths });
  const baselineAncestor = git(root, ["merge-base", "--is-ancestor", baseline.output, currentRevision]);
  if (baselineAncestor.ok) return result(graph, checkpoint, "ahead", "Local HEAD is ahead of the checkpoint baseline.", { currentRevision, branch: metadata.branch, dirty: metadata.dirty, changedPaths });
  const currentAncestor = git(root, ["merge-base", "--is-ancestor", currentRevision, baseline.output]);
  if (currentAncestor.ok) return result(graph, checkpoint, "behind", "Local HEAD is behind the checkpoint baseline.", { currentRevision, branch: metadata.branch, dirty: metadata.dirty, changedPaths });
  return result(graph, checkpoint, "diverged", "Local HEAD and the checkpoint baseline have diverged. This is not a merge-conflict claim.", { currentRevision, branch: metadata.branch, dirty: metadata.dirty, changedPaths });
}

module.exports = { CONTINUATION_DIVERGENCE_SCHEMA, MAX_CHANGED_PATHS, getCheckpointDivergence };
