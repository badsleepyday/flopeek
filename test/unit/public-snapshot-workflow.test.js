"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "public-snapshot.yml"), "utf8");

test("public snapshot workflow keeps stable and prerelease source tracks separate after private review", () => {
  assert.match(workflow, /release\/alpha/);
  assert.match(workflow, /release\/beta/);
  assert.match(workflow, /patch/);
  assert.match(workflow, /minor/);
  assert.match(workflow, /major/);
  assert.match(workflow, /Run a stable .* release from private main/);
  assert.match(workflow, /FLOWPEEK_PUBLIC_SYNC_ENABLED/);
  assert.match(workflow, /FLOWPEEK_PUBLIC_SNAPSHOT_APPROVED/);
  assert.match(workflow, /FLOWPEEK_PUBLIC_REPOSITORY/);
  assert.match(workflow, /FLOWPEEK_PUBLIC_PUSH_TOKEN/);
  assert.match(workflow, /npm run export:public-repository/);
  assert.match(workflow, /rsync -a --delete --exclude \.git/);
  assert.match(workflow, /npm --prefix .* version prerelease --preid/);
  assert.match(workflow, /npm --prefix .* version "\$VERSION_BUMP"/);
  assert.match(workflow, /base_branch="alpha"/);
  assert.match(workflow, /base_branch="beta"/);
  assert.match(workflow, /base_branch="main"/);
  assert.match(workflow, /steps\.channel\.outputs\.baseBranch/);
  assert.match(workflow, /Creating public \$PUBLIC_BASE_BRANCH from public main/);
  assert.match(workflow, /Public main does not exist/);
  assert.match(workflow, /seeding the first snapshot from the exported package version/);
  assert.match(workflow, /git -C .* push origin "HEAD:refs\/heads\/\$PUBLIC_BASE_BRANCH"/);
  assert.doesNotMatch(workflow, /gh pr create/);
  assert.doesNotMatch(workflow, /push --mirror/);
});
