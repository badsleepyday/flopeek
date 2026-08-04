"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { commonGitDirectory, gitDirectory, parsePorcelainV2, readOriginRemote } = require("../../src/git-metadata");

test("porcelain v2 metadata is parsed without treating headers as dirty files", () => {
  const clean = parsePorcelainV2("# branch.oid abc123\n# branch.head main\n");
  assert.deepEqual(clean, { branch: "main", revision: "abc123", dirty: false });
  const dirty = parsePorcelainV2("# branch.oid abc123\n# branch.head (detached)\n1 .M N... 100644 100644 100644 abc abc file.ts\n? new.ts\n");
  assert.deepEqual(dirty, { branch: "detached", revision: "abc123", dirty: true });
  assert.equal(parsePorcelainV2("# branch.oid (initial)\n# branch.head main\n").revision, null);
});

test("Git directory, common directory, and origin remote are read statically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-git-metadata-"));
  try {
    const repository = path.join(root, "repository");
    const nested = path.join(repository, "packages", "app");
    const common = path.join(root, "common.git");
    const worktree = path.join(common, "worktrees", "app");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(repository, ".git"), `gitdir: ${worktree}\n`, "utf8");
    fs.writeFileSync(path.join(worktree, "commondir"), "../..\n", "utf8");
    fs.writeFileSync(path.join(common, "config"), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.test/flopeek.git\n', "utf8");
    assert.equal(gitDirectory(nested), worktree);
    assert.equal(commonGitDirectory(nested), common);
    assert.equal(readOriginRemote(nested), "https://example.test/flopeek.git");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
