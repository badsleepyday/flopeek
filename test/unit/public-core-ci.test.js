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
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.source_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /uses: actions\/checkout@v7/);
  assert.match(workflow, /uses: actions\/setup-node@v7/);
  assert.match(workflow, /uses: dtolnay\/rust-toolchain@stable[\s\S]*?toolchain:\s*\$\{\{ steps\.toolchain-contract\.outputs\.rust \}\}/);
  assert.match(workflow, /uses: actions\/setup-dotnet@v6/);
  assert.match(workflow, /global-json-file:\s*global\.json/);
  assert.match(workflow, /uses: actions\/setup-go@v7/);
  assert.match(workflow, /go-version:\s*'1\.26\.4'/);
  assert.match(workflow, /setup-go@v7[\s\S]*?cache:\s*false/);
  assert.match(workflow, /npm run verify:native-adapter-parity -- --output native-adapter-parity\.json/);
  assert.match(workflow, /name: adapter-parity-\$\{\{ matrix\.os \}\}-node-\$\{\{ matrix\.node \}\}/);
  assert.match(publicSourceRunner, /lanes\["public-source"\]\.unshift\("test\/unit\/native-inventory-parity\.test\.js"\)/);
  for (const command of ["npm run verify:toolchains", "cargo fmt --check --manifest-path native/flopeek-core/Cargo.toml", "cargo clippy --locked --manifest-path native/flopeek-core/Cargo.toml -- -D warnings", "cargo test --locked --manifest-path native/flopeek-core/Cargo.toml", "npm run test:native-core", "cargo run --quiet --manifest-path native/flopeek-core/Cargo.toml -- --version", "cargo run --quiet --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-facts .", "cargo run --quiet --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-graph .", "node scripts/verify-branch-name.js", "npm run verify:core-baseline", "npm run test:public-source", "npm run test:package", "npm run audit:package", "npm run verify:clean-room"]) {
    assert.match(workflow, new RegExp(`- run: ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(packageJson.scripts["test:native-core"], /node scripts\/smoke-native-release\.js/);
});

test("candidate workflow builds each platform once and produces one immutable complete bundle", () => {
  const workflow = readWorkflow("native-candidate.yml");
  assert.match(workflow, /workflow_dispatch:/);
  for (const input of ["source_sha", "package_version", "release_channel"]) {
    assert.match(workflow, new RegExp(`\\n\\s{6}${input}:`));
  }
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml[\s\S]*source_sha: \$\{\{ inputs\.source_sha \}\}/);
  assert.equal((workflow.match(/cargo build --release --locked/g) || []).length, 1);
  assert.match(workflow, /matrix:[\s\S]*@flopeek\/native-win32-x64[\s\S]*@flopeek\/native-win32-arm64[\s\S]*@flopeek\/native-linux-x64-gnu[\s\S]*@flopeek\/native-linux-arm64-gnu[\s\S]*@flopeek\/native-darwin-x64[\s\S]*@flopeek\/native-darwin-arm64/);
  assert.match(workflow, /tar -xOf "\$tarball" package\/bin\/flopeek-native-core/);
  assert.match(workflow, /run-native-candidate-evidence\.js/);
  assert.match(workflow, /build-native-rollout-evidence\.js/);
  assert.match(workflow, /CANDIDATE_BUNDLE=\$\{\{ runner\.temp \}\}\/flopeek-native-bundle/);
  assert.match(workflow, /npm pack --json --pack-destination \$env:CANDIDATE_BUNDLE/);
  assert.match(workflow, /--output "\$CANDIDATE_EVIDENCE\/native-rollout-evidence\.json"/);
  assert.match(workflow, /build-native-release-manifest\.js/);
  assert.match(workflow, /name: native-candidate-bundle/);
  assert.doesNotMatch(workflow, /npm publish|gh release create|git push/);
  assert.doesNotMatch(workflow, /continue-on-error|\|\|\s*true/);
});

test("promotion workflow consumes a cross-run candidate behind protected environments without rebuilding", () => {
  const workflow = readWorkflow("native-promotion.yml");
  assert.match(workflow, /workflow_dispatch:/);
  for (const input of ["candidate_run_id", "release_manifest_sha256", "release_channel", "dry_run"]) {
    assert.match(workflow, new RegExp(`\\n\\s{6}${input}:`));
  }
  assert.match(workflow, /environment: \$\{\{ inputs\.dry_run && 'native-release-promotion-dry-run' \|\| 'native-release-promotion' \}\}/);
  assert.match(workflow, /uses: actions\/download-artifact@v8[\s\S]*github-token: \$\{\{ github\.token \}\}[\s\S]*run-id: \$\{\{ inputs\.candidate_run_id \}\}/);
  assert.match(workflow, /--expected-manifest-sha256 "\$\{\{ inputs\.release_manifest_sha256 \}\}"/);
  assert.match(workflow, /actions\/runs\/\$\{\{ inputs\.candidate_run_id \}\}/);
  assert.match(workflow, /run\.path -ne '\.github\/workflows\/native-candidate\.yml'/);
  assert.match(workflow, /run\.conclusion -ne 'success'/);
  assert.match(workflow, /verify-native-candidate-install\.js/);
  assert.match(workflow, /publish-npm-release-set\.js --assets candidate-bundle/);
  assert.match(workflow, /verify-native-registry-release\.js/);
  assert.match(workflow, /generate-native-promotion-attestation\.js/);
  assert.match(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /cargo (?:build|run)|npm pack/);
  assert.doesNotMatch(workflow, /packaging\/github-release-approval\.json|continue-on-error|\|\|\s*true/);
});
