"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const readWorkflow = (name) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");

test("public Core CI proves package and clean-room behavior on the declared Node and OS matrix", () => {
  const workflow = readWorkflow("ci.yml");
  assert.match(workflow, /os:\s*\[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(workflow, /node:\s*\[20, 22\]/);
  assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.os \}\}/);
  for (const command of ["node scripts/verify-branch-name.js", "npm run test:public-source", "npm run test:package", "npm run audit:package", "npm run verify:clean-room"]) {
    assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("tagged Core releases verify source and package evidence before creating a GitHub Release", () => {
  const workflow = readWorkflow("release.yml");
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /npm run verify:github-release -- --tag "\$GITHUB_REF_NAME"/);
  for (const command of ["npm run test:public-source", "npm run test:package", "npm run audit:package", "npm run verify:clean-room"]) {
    assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /npm publish/);
});
