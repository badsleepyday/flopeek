"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const readWorkflow = (name) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");

test("public Core CI proves package and clean-room behavior on the declared Node and OS matrix", () => {
  const workflow = readWorkflow("ci.yml");
  const publicSourceRunner = fs.readFileSync(path.join(ROOT, "scripts", "run-tests.js"), "utf8");
  assert.match(workflow, /os:\s*\[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(workflow, /node:\s*\[20, 22\]/);
  assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.os \}\}/);
  assert.match(workflow, /uses: dtolnay\/rust-toolchain@stable/);
  assert.match(publicSourceRunner, /lanes\["public-source"\]\.unshift\("test\/unit\/native-inventory-parity\.test\.js"\)/);
  for (const command of ["npm run test:native-core", "cargo run --quiet --manifest-path native/flopeek-core/Cargo.toml -- --version", "cargo run --quiet --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-facts .", "cargo run --quiet --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-graph .", "node scripts/verify-branch-name.js", "npm run verify:core-baseline", "npm run test:public-source", "npm run test:package", "npm run audit:package", "npm run verify:clean-room"]) {
    assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(packageJson.scripts["test:native-core"], /node scripts\/smoke-native-release\.js/);
});

test("tagged Core releases verify source and package evidence before creating a GitHub Release", () => {
  const workflow = readWorkflow("release.yml");
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /npm run verify:github-release -- --tag "\$GITHUB_REF_NAME"/);
  for (const command of ["npm run test:public-source", "npm run test:package", "npm run audit:package", "npm run verify:clean-room"]) {
    assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(workflow, /node scripts\/verify-clean-room-native-platform\.js --platform-tarball/);
  assert.match(workflow, /name: Verify complete release set before publication/);
  assert.match(workflow, /npm run verify:npm-publication/);
  assert.match(workflow, /npm run verify:github-release-preflight -- --tag "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /node scripts\/verify-native-release-set\.js --assets release-assets/);
  assert.match(workflow, /node scripts\/publish-npm-release-set\.js --assets release-assets --staging-tag "\$staging_tag"/);
  assert.match(workflow, /name: Anonymous registry clean-room install of the exact main package/);
  assert.match(workflow, /name: Move public dist-tags only after clean-room verification/);
  assert.match(workflow, /npm run verify:published-release -- --tag "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /node scripts\/cleanup-npm-staging-tags\.js --staging-tag "\$staging_tag"/);
  assert.doesNotMatch(workflow, /\|\|\s*true/);
  assert.match(workflow, /needs: \[native-binaries, publish-npm-release\]/);
  assert.match(workflow, /gh release create/);
});
