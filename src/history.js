const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getGraphDelta } = require("./graph-service");
const { scanRepository } = require("./scanner");
const { resolveProjectIdentity } = require("./project-identity");

const HISTORY_SCHEMA = "flowpeek-git-history/v1";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function git(root, args, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], {
    encoding: options.encoding,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: options.maxBuffer || MAX_ARCHIVE_BYTES,
  });
}

function gitText(root, args) {
  try {
    return String(git(root, args, { encoding: "utf8" })).trim();
  } catch {
    return null;
  }
}

function resolveCommit(root, ref) {
  const revision = gitText(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!revision) throw new Error(`Unable to resolve Git commit '${ref}'.`);
  return revision;
}

function commitMetadata(root, ref) {
  const revision = resolveCommit(root, ref);
  return {
    requestedRef: ref,
    revision,
    shortRevision: revision.slice(0, 12),
    subject: gitText(root, ["show", "-s", "--format=%s", revision]) || "",
    committedAt: gitText(root, ["show", "-s", "--format=%cI", revision]) || null,
  };
}

function historyDirectory(root) {
  return path.join(root, ".flowpeek", "history");
}

function snapshotPath(root, revision) {
  return path.join(historyDirectory(root), `${revision}.json`);
}

function readSnapshot(root, revision) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath(root, revision), "utf8"));
    if (snapshot?.schemaVersion !== HISTORY_SCHEMA || snapshot.commit?.revision !== revision || !Array.isArray(snapshot.graph?.nodes) || !Array.isArray(snapshot.graph?.edges)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function writeSnapshot(root, snapshot) {
  const directory = historyDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  const target = snapshotPath(root, snapshot.commit.revision);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
  fs.renameSync(temporary, target);
  return target;
}

function scanCommit(root, commit) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-git-snapshot-"));
  const archivePath = path.join(temporaryRoot, "source.tar");
  try {
    const archive = git(root, ["archive", "--format=tar", commit.revision], { maxBuffer: MAX_ARCHIVE_BYTES });
    fs.writeFileSync(archivePath, archive);
    const tar = process.platform === "win32" ? "tar.exe" : "tar";
    execFileSync(tar, ["-xf", archivePath, "-C", temporaryRoot], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_ARCHIVE_BYTES });
    fs.rmSync(archivePath, { force: true });
    const graph = scanRepository(temporaryRoot);
    const identity = resolveProjectIdentity(root);
    graph.project = {
      root,
      name: graph.project.name,
      projectId: identity.projectId,
      identity,
      git: { branch: "detached-snapshot", revision: commit.shortRevision, shallow: false },
    };
    return graph;
  } catch (error) {
    const detail = error.stderr ? ` ${String(error.stderr).trim()}` : "";
    throw new Error(`Unable to scan Git commit ${commit.shortRevision}.${detail}`.trim());
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function createGitSnapshot(inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const commit = commitMetadata(root, options.ref || "HEAD");
  const existing = !options.force && readSnapshot(root, commit.revision);
  if (existing) return { created: false, path: snapshotPath(root, commit.revision), snapshot: existing };
  const snapshot = {
    schemaVersion: HISTORY_SCHEMA,
    createdAt: new Date().toISOString(),
    commit,
    graph: scanCommit(root, commit),
  };
  return { created: true, path: writeSnapshot(root, snapshot), snapshot };
}

function flowSummary(flow) {
  return {
    id: flow.id,
    title: flow.title,
    entryId: flow.entryId,
    steps: flow.steps.map((step) => ({ id: step.id, label: step.label, type: step.type, depth: step.depth })),
  };
}

function flowSignature(flow) {
  return `${flow.title}\u0000${flow.entryId}\u0000${flow.steps.map((step) => step.id).join("\u0000")}`;
}

function getFlowDelta(previousGraph, graph, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const previous = new Map((previousGraph.flows || []).map((flow) => [flow.id, flow]));
  const current = new Map((graph.flows || []).map((flow) => [flow.id, flow]));
  const addedIds = [...current.keys()].filter((id) => !previous.has(id)).sort();
  const removedIds = [...previous.keys()].filter((id) => !current.has(id)).sort();
  const changedIds = [...current.keys()].filter((id) => previous.has(id) && flowSignature(current.get(id)) !== flowSignature(previous.get(id))).sort();
  return {
    summary: { addedFlows: addedIds.length, removedFlows: removedIds.length, changedFlows: changedIds.length },
    addedFlows: addedIds.slice(0, limit).map((id) => flowSummary(current.get(id))),
    removedFlows: removedIds.slice(0, limit).map((id) => flowSummary(previous.get(id))),
    changedFlows: changedIds.slice(0, limit).map((id) => ({ before: flowSummary(previous.get(id)), after: flowSummary(current.get(id)) })),
    truncated: addedIds.length > limit || removedIds.length > limit || changedIds.length > limit,
    limitation: "A flow comparison is a before/after static graph comparison. It does not prove runtime execution and cannot surface source edits that leave the same graph IDs and flow steps.",
  };
}

function changedPathsBetween(root, fromRevision, toRevision) {
  const output = gitText(root, ["diff", "--name-only", "--diff-filter=ACMR", fromRevision, toRevision]);
  return output ? output.split(/\r?\n/).filter(Boolean).sort() : [];
}

function compareGitSnapshots(inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const from = createGitSnapshot(root, { ref: options.from || "HEAD~1" });
  const to = createGitSnapshot(root, { ref: options.to || "HEAD" });
  const limit = options.limit;
  return {
    schemaVersion: "flowpeek-git-history-comparison/v1",
    before: { commit: from.snapshot.commit, path: from.path, created: from.created },
    after: { commit: to.snapshot.commit, path: to.path, created: to.created },
    changedPaths: changedPathsBetween(root, from.snapshot.commit.revision, to.snapshot.commit.revision),
    topology: getGraphDelta(from.snapshot.graph, to.snapshot.graph, { limit }),
    flows: getFlowDelta(from.snapshot.graph, to.snapshot.graph, { limit }),
    limitation: "Snapshots use Git commit archives and are stored locally in .flowpeek/history. They exclude uncommitted working-tree changes and do not execute code or configuration.",
  };
}

module.exports = { HISTORY_SCHEMA, compareGitSnapshots, createGitSnapshot, getFlowDelta, readSnapshot };
