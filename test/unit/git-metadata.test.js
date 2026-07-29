"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readGitMetadata } = require("../../src/git-metadata");

test("Git metadata short-circuits a directory without a repository marker", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-no-git-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readGitMetadata(root), {
    branch: "not-a-git-repository",
    revision: null,
    shallow: null,
    dirty: null,
    availability: "not-a-repository",
    reason: "Git metadata is unavailable because this directory is not a readable Git repository.",
  });
});
