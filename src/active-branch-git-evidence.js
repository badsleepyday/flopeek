const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const ACTIVE_BRANCH_GIT_EVIDENCE_SCHEMA = "flowpeek-active-branch-git-evidence/v1";
const DEFAULT_COMMIT_LIMIT = 12;
const MAX_COMMIT_LIMIT = 50;
const MAX_CONTEXT_PATHS = 24;

function gitText(root, args) {
  try {
    return String(execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 512 * 1024,
    })).trim();
  } catch {
    return null;
  }
}

function relativePath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) return null;
  return path;
}

function contextPaths(resolution) {
  if (!resolution?.card) return [];
  const raw = resolution.card.kind === "node"
    ? [resolution.card.node?.path]
    : resolution.card.kind === "flow"
      ? (resolution.card.projection?.steps || []).map((step) => step.node?.path)
      : [];
  return [...new Set(raw.map(relativePath).filter(Boolean))].sort().slice(0, MAX_CONTEXT_PATHS);
}

function boundedLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_COMMIT_LIMIT;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_COMMIT_LIMIT) {
    throw new Error(`Commit limit must be an integer from 1 to ${MAX_COMMIT_LIMIT}.`);
  }
  return number;
}

function parseCommitRecords(output) {
  if (!output) return [];
  return output.split("\u001e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [revision, parents, committedAt, subject] = record.split("\u001f");
    return {
      revision,
      shortRevision: revision.slice(0, 12),
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      committedAt: committedAt || null,
      subject: subject || "",
    };
  }).filter((record) => /^[0-9a-f]{40}$/i.test(record.revision));
}

function pathCommits(root, relative, limit) {
  const output = gitText(root, [
    "log",
    "--no-renames",
    `-n${limit + 1}`,
    "--format=%H%x1f%P%x1f%cI%x1f%s%x1e",
    "HEAD",
    "--",
    relative,
  ]);
  const all = parseCommitRecords(output);
  return { path: relative, commits: all.slice(0, limit), truncated: all.length > limit };
}

function unavailable(graph, contextRef, resolution, reason, details = {}) {
  return {
    schemaVersion: ACTIVE_BRANCH_GIT_EVIDENCE_SCHEMA,
    status: "unavailable",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    context: {
      requestedRef: contextRef,
      resolutionStatus: resolution?.status || "unresolved",
      resolvedRef: resolution?.resolvedRef || null,
      kind: resolution?.card?.kind || null,
      paths: [],
    },
    branch: { name: details.branch || null, headRevision: details.headRevision || null, shallow: details.shallow ?? null },
    retrieval: { scope: "active-branch-reachable-path-history", perPathCommitLimit: details.limit || DEFAULT_COMMIT_LIMIT, returnedPaths: 0, returnedCommits: 0, truncated: false },
    paths: [],
    reason,
    limitations: [
      "This read-only result does not execute repository code, fetch, checkout, merge, rebase, or modify Git refs.",
      "Path-touch commit evidence is not proof of runtime behavior, business intent, original rationale, review, test success, or release state.",
      "Missing retained evidence is unavailable, not evidence that behavior or rationale is absent.",
    ],
  };
}

function getActiveBranchGitEvidence(inputRoot, graph, contextRef, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const resolution = options.resolution || null;
  const limit = boundedLimit(options.limit);
  if (!resolution || !["current", "stale"].includes(resolution.status) || !resolution.card) {
    return unavailable(graph, contextRef, resolution, "The Context Ref does not resolve to a current or stale Context Card with retained current paths.", { limit });
  }
  const isGit = gitText(root, ["rev-parse", "--is-inside-work-tree"]);
  if (isGit !== "true") return unavailable(graph, contextRef, resolution, "The target repository is not an available local Git work tree.", { limit });
  const branch = gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headRevision = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const shallowValue = gitText(root, ["rev-parse", "--is-shallow-repository"]);
  const shallow = shallowValue === "true" ? true : shallowValue === "false" ? false : null;
  if (!headRevision) return unavailable(graph, contextRef, resolution, "The local Git work tree has no resolvable HEAD commit.", { branch, shallow, limit });
  if (!branch) return unavailable(graph, contextRef, resolution, "HEAD is detached, so active-branch evidence is unavailable. Use an attached local branch before relying on this projection.", { headRevision, shallow, limit });
  const paths = contextPaths(resolution);
  if (!paths.length) return unavailable(graph, contextRef, resolution, "The resolved Context Card has no safe repository-relative source paths to inspect.", { branch, headRevision, shallow, limit });
  const pathEvidence = paths.map((relative) => pathCommits(root, relative, limit));
  const returnedCommits = pathEvidence.reduce((total, item) => total + item.commits.length, 0);
  return {
    schemaVersion: ACTIVE_BRANCH_GIT_EVIDENCE_SCHEMA,
    status: "available",
    project: { projectId: graph.project.projectId, graphVersion: graph.state.graphVersion, sourceRevision: graph.state.sourceRevision || null },
    context: {
      requestedRef: contextRef,
      resolutionStatus: resolution.status,
      resolvedRef: resolution.resolvedRef || null,
      kind: resolution.card.kind,
      paths,
    },
    branch: { name: branch, headRevision, shortHeadRevision: headRevision.slice(0, 12), shallow },
    retrieval: {
      scope: "active-branch-reachable-path-history",
      perPathCommitLimit: limit,
      returnedPaths: pathEvidence.length,
      returnedCommits,
      truncated: pathEvidence.some((item) => item.truncated),
    },
    paths: pathEvidence,
    limitations: [
      "This is read-only local Git evidence from commits reachable from the current attached branch HEAD and only for current Context Card paths.",
      "A listed commit touched a path; it does not prove that it introduced a symbol, explains the original rationale, or caused a runtime behavior.",
      "Git path history does not follow renames or moves in this bounded projection. Squash, rewrite, shallow history, deleted refs, imported history, and unavailable commits can omit earlier evidence.",
      "This result contains no source-file body, author identity, credential, raw Git output, checkout, fetch, merge, rebase, or target-code execution.",
    ],
  };
}

module.exports = {
  ACTIVE_BRANCH_GIT_EVIDENCE_SCHEMA,
  DEFAULT_COMMIT_LIMIT,
  MAX_COMMIT_LIMIT,
  contextPaths,
  getActiveBranchGitEvidence,
};
