"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { createContinuationCheckpoint } = require("../../src/continuation-checkpoint");
const { getCheckpointDivergence } = require("../../src/continuation-divergence");
const { scanRepository } = require("../../src/scanner");

function git(root, args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim(); }
function write(root, file, value) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value, "utf8"); }
function commit(root, message) { git(root, ["add", "."]); git(root, ["commit", "-m", message]); }
function checkpoint(root, graph, id = "checkpoint.divergence") {
  createContinuationCheckpoint(root, graph, { operationId: `${id}.operation`, id, expectedGraphVersion: graph.state.graphVersion, selectedContextRefs: [createContextRef(graph.project.projectId, "flow", graph.flows[0].id, graph.state.graphVersion)], createdBy: "test", createdByKind: "human" });
}
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-divergence-"));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "Flopeek test"]);
  write(root, ".gitignore", ".flopeek/\n"); write(root, "package.json", JSON.stringify({ name: "divergence" })); write(root, "src/app/api/orders/route.ts", "export async function GET() { return { ok: true }; }\n"); commit(root, "baseline");
  return root;
}

test("read-only divergence reports exact, dirty, ahead, behind, diverged, missing revision, and non-Git states", () => {
  const root = repository();
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-divergence-non-git-"));
  try {
    const baseline = scanRepository(root, { persistIdentity: true }); checkpoint(root, baseline);
    assert.equal(getCheckpointDivergence(root, baseline, "checkpoint.divergence").status, "exact");
    write(root, "src/dirty.ts", "export const dirty = true;\n");
    const dirty = scanRepository(root, { persistIdentity: true });
    const dirtyDivergence = getCheckpointDivergence(root, dirty, "checkpoint.divergence");
    assert.equal(dirtyDivergence.status, "working-tree-changed");
    assert.deepEqual(dirtyDivergence.changedPaths.items, ["src/dirty.ts"]);
    commit(root, "ahead");
    const ahead = scanRepository(root, { persistIdentity: true });
    assert.equal(getCheckpointDivergence(root, ahead, "checkpoint.divergence").status, "ahead");
    checkpoint(root, ahead, "checkpoint.ahead");

    const base = git(root, ["rev-parse", "HEAD~1"]);
    git(root, ["checkout", "-b", "other", base]); write(root, "src/other.ts", "export const other = true;\n"); commit(root, "other");
    const diverged = scanRepository(root, { persistIdentity: true });
    assert.equal(getCheckpointDivergence(root, diverged, "checkpoint.ahead").status, "diverged");
    git(root, ["checkout", "-B", "behind", base]);
    const behind = scanRepository(root, { persistIdentity: true });
    assert.equal(getCheckpointDivergence(root, behind, "checkpoint.ahead").status, "behind");

    const noCommitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-divergence-empty-git-")); git(noCommitRoot, ["init"]); write(noCommitRoot, "package.json", JSON.stringify({ name: "empty" })); write(noCommitRoot, "src/app/api/a/route.ts", "export function GET() {}\n");
    const noCommitGraph = scanRepository(noCommitRoot, { persistIdentity: true }); checkpoint(noCommitRoot, noCommitGraph, "checkpoint.empty");
    assert.equal(getCheckpointDivergence(noCommitRoot, noCommitGraph, "checkpoint.empty").status, "commit-unavailable"); fs.rmSync(noCommitRoot, { recursive: true, force: true });
    write(nonGit, "package.json", JSON.stringify({ name: "non-git" })); write(nonGit, "src/app/api/a/route.ts", "export function GET() {}\n"); const nonGitGraph = scanRepository(nonGit, { persistIdentity: true }); checkpoint(nonGit, nonGitGraph, "checkpoint.non-git");
    assert.equal(getCheckpointDivergence(nonGit, nonGitGraph, "checkpoint.non-git").status, "non-git");
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(nonGit, { recursive: true, force: true }); }
});
