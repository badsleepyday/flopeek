const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getGraphDelta } = require("./graph-delta");
const { resolveProjectIdentity } = require("./project-identity");

const HISTORY_SCHEMA = "flopeek-git-history/v1";
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
  return path.join(root, ".flopeek", "history");
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

function tarText(buffer, offset, width) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end < 0 || end > offset + width ? offset + width : end).toString("utf8");
}

function tarOctal(buffer, offset, width) {
  const value = tarText(buffer, offset, width).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error("Git archive contains an invalid tar size.");
  return Number.parseInt(value, 8);
}

function parsePax(buffer) {
  const values = {};
  let offset = 0;
  while (offset < buffer.length) {
    const separator = buffer.indexOf(0x20, offset);
    if (separator < 0) throw new Error("Git archive contains an invalid PAX header.");
    const recordLength = Number.parseInt(buffer.subarray(offset, separator).toString("ascii"), 10);
    if (!Number.isSafeInteger(recordLength) || recordLength <= separator - offset + 1 || offset + recordLength > buffer.length) {
      throw new Error("Git archive contains an invalid PAX record length.");
    }
    const record = buffer.subarray(separator + 1, offset + recordLength).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1).replace(/\n$/, "");
    offset += recordLength;
  }
  return values;
}

function snapshotDestination(root, rawPath) {
  if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\") || rawPath.includes(":")) throw new Error("Git archive contains an unsafe path.");
  const normalized = path.posix.normalize(rawPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("Git archive contains an unsafe path.");
  }
  const destination = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, destination);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Git archive contains an unsafe path.");
  }
  return destination;
}

function extractGitArchive(archive, temporaryRoot) {
  let offset = 0;
  let globalPax = {};
  let nextPax = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarOctal(header, 124, 12);
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > archive.length) throw new Error("Git archive ended before a tar entry was complete.");
    const payload = archive.subarray(payloadStart, payloadEnd);
    const type = String.fromCharCode(header[156] || 48);
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    offset = payloadStart + Math.ceil(size / 512) * 512;

    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(payload) };
      continue;
    }
    if (type === "x") {
      nextPax = parsePax(payload);
      continue;
    }

    const metadata = { ...globalPax, ...(nextPax || {}) };
    nextPax = null;
    const destination = snapshotDestination(temporaryRoot, metadata.path || headerPath);
    if (type === "5") {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, payload);
    }
  }
}

function scanCommit(root, commit) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-git-snapshot-"));
  try {
    // Extract Git's own archive in-process. Windows tar implementations can
    // treat C:\\temp as a remote target, while an in-process extractor keeps the
    // snapshot read-only and never checks out the caller's working tree.
    const archive = git(root, ["archive", "--format=tar", commit.revision], { maxBuffer: MAX_ARCHIVE_BYTES });
    extractGitArchive(archive, temporaryRoot);
    const graph = require("./scanner").scanRepository(temporaryRoot);
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
    schemaVersion: "flopeek-git-history-comparison/v1",
    before: { commit: from.snapshot.commit, path: from.path, created: from.created },
    after: { commit: to.snapshot.commit, path: to.path, created: to.created },
    changedPaths: changedPathsBetween(root, from.snapshot.commit.revision, to.snapshot.commit.revision),
    topology: getGraphDelta(from.snapshot.graph, to.snapshot.graph, { limit }),
    flows: getFlowDelta(from.snapshot.graph, to.snapshot.graph, { limit }),
    limitation: "Snapshots use Git commit archives and are stored locally in .flopeek/history. They exclude uncommitted working-tree changes and do not execute code or configuration.",
  };
}

module.exports = { HISTORY_SCHEMA, compareGitSnapshots, createGitSnapshot, getFlowDelta, readSnapshot };
