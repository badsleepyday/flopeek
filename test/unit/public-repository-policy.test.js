"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  PublicRepositoryError,
  auditPublicFiles,
  exportPublicRepository,
  loadPolicy,
  outputPath,
  selectPublicEntries,
} = require("../../scripts/lib/public-repository-policy");

const ROOT = path.resolve(__dirname, "..", "..");
const POLICY_PATH = path.join(ROOT, "packaging", "public-repository-policy.json");

function write(root, relativePath, content = "fixture\n") {
  const file = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

function fixturePolicy() {
  return {
    schemaVersion: "flowpeek-public-repository-policy/v1",
    sourceRepository: { classification: "private-development", cleanWorktreeRequiredForExport: true, copyGitHistory: false },
    overlays: [{ source: "packaging/public-overlay/ci.yml", destination: ".github/workflows/ci.yml" }],
    allowedExactPaths: [".flowpeek/config.json", ".github/workflows/ci.yml", "README.md", "package.json", "src/cli.js", "test/unit/example.test.js"],
    allowedDirectories: [],
    requiredPaths: [".flowpeek/config.json", ".github/workflows/ci.yml", "README.md", "package.json", "src/cli.js", "test/unit/example.test.js"],
    deniedPathSegments: [".agent-team", ".agents", ".git", "node_modules"],
    deniedBasenames: [".env", ".npmrc", "AGENTS.md", "credentials.json", "id_ed25519", "id_rsa"],
    deniedBasenamePrefixes: [".env.", "credentials.", "secrets."],
    deniedSuffixes: [".crt", ".key", ".log", ".pem", ".pfx"],
    maximumEntries: 20,
    maximumBytes: 100_000,
    releaseReadiness: { licenseFileRequired: true, packageLicenseRequired: true, packagePrivateMustBeFalse: true, securityPolicyRequired: true, changelogRequired: true, contributingGuideRequired: true, ownerApprovalRequired: true },
  };
}

function makeRepository() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-public-policy-"));
  const source = path.join(parent, "private-source");
  fs.mkdirSync(source);
  write(source, ".flowpeek/config.json", "{\"schemaVersion\":1}\n");
  write(source, ".github/workflows/ci.yml", "name: Private verify\n");
  write(source, "packaging/public-overlay/ci.yml", "name: Public verify\n");
  write(source, ".agents/skills/internal/SKILL.md");
  write(source, "AGENTS.md");
  write(source, "README.md", "# Public fixture\n");
  write(source, "package.json", JSON.stringify({ name: "flowpeek", version: "0.2.0", private: true }, null, 2));
  write(source, "src/cli.js", "#!/usr/bin/env node\n");
  write(source, "test/unit/example.test.js");
  write(source, "policy.json", `${JSON.stringify(fixturePolicy(), null, 2)}\n`);
  git(source, "init", "--quiet");
  git(source, "config", "core.autocrlf", "false");
  git(source, "config", "core.safecrlf", "false");
  git(source, "add", "--all");
  git(source, "-c", "user.name=Flowpeek Test", "-c", "user.email=flowpeek@example.invalid", "commit", "--quiet", "-m", "fixture");
  return { parent, source, policy: path.join(source, "policy.json") };
}

test("development repository projects a bounded public tree without agent governance", () => {
  const policy = loadPolicy(POLICY_PATH);
  const entries = selectPublicEntries([
    ".flowpeek/config.json",
    ".github/workflows/ci.yml",
    ".github/workflows/real-corpus.yml",
    ".agents/skills/internal/SKILL.md",
    ".agent-team/upstream.json",
    "AGENTS.md",
    "README.md",
    "SUPPORT.md",
    "package-lock.json",
    "package.json",
    "packaging/public-repository-overlay/.github/workflows/ci.yml",
    "public/index.html",
    "src/cli.js",
    "src/mcp.js",
    "test/unit/package-policy.test.js",
  ], policy);
  const files = entries.map((entry) => entry.destination);
  assert.ok(files.includes(".flowpeek/config.json"));
  assert.ok(files.includes(".github/workflows/ci.yml"));
  assert.equal(entries.find((entry) => entry.destination === ".github/workflows/ci.yml").source, "packaging/public-repository-overlay/.github/workflows/ci.yml");
  assert.equal(files.includes("AGENTS.md"), false);
  assert.equal(files.some((file) => file.startsWith(".agents/") || file.startsWith(".agent-team/")), false);
  const audit = auditPublicFiles(policy.requiredPaths, policy, { name: "flowpeek", version: "0.2.0", private: true }, { totalBytes: 1000, sourceClean: true, revision: "a".repeat(40) });
  assert.equal(audit.structureStatus, "passed");
  assert.ok(audit.releaseReadiness.blockers.includes("license-file-missing"));
  assert.ok(audit.releaseReadiness.blockers.includes("package-license-missing"));
  assert.ok(audit.releaseReadiness.blockers.includes("package-private-boundary-active"));
  assert.equal(policy.sourceRepository.copyGitHistory, false);
});

test("public tree audit rejects governance, credentials, and release-boundary drift", () => {
  const policy = fixturePolicy();
  const files = [...policy.requiredPaths, "AGENTS.md", ".agents/skills/internal/SKILL.md", "src/.env.production", "src/private.pem"];
  const report = auditPublicFiles(files, policy, { name: "flowpeek", version: "0.2.0", private: true }, { totalBytes: 1000, sourceClean: true, revision: "a".repeat(40) });
  assert.equal(report.structureStatus, "failed");
  assert.equal(report.checks.deniedContent, false);
  assert.equal(report.releaseReadiness.technicalStatus, "blocked");
  assert.equal(report.releaseReadiness.publicReleaseApproved, false);
});

test("clean export copies only the public snapshot and creates no Git history", () => {
  const fixture = makeRepository();
  const output = path.join(fixture.parent, "public-candidate");
  try {
    const result = exportPublicRepository(fixture.source, fixture.policy, output);
    assert.equal(result.report.structureStatus, "passed");
    assert.ok(fs.existsSync(path.join(output, ".flowpeek", "config.json")));
    assert.ok(fs.existsSync(path.join(output, ".github", "workflows", "ci.yml")));
    assert.equal(fs.readFileSync(path.join(output, ".github", "workflows", "ci.yml"), "utf8"), "name: Public verify\n");
    assert.equal(fs.existsSync(path.join(output, "packaging", "public-overlay", "ci.yml")), false);
    assert.equal(fs.existsSync(path.join(output, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(output, ".agents")), false);
    assert.equal(fs.existsSync(path.join(output, ".git")), false);
    assert.equal(result.report.candidate.containsGitHistory, false);
  } finally {
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("export refuses dirty source and destinations that could overlap it", () => {
  const fixture = makeRepository();
  try {
    assert.throws(() => outputPath(fixture.source, path.join(fixture.source, "candidate")), (error) => error instanceof PublicRepositoryError && error.code === "unsafe-output");
    assert.throws(() => outputPath(fixture.source, fixture.parent), (error) => error instanceof PublicRepositoryError && error.code === "unsafe-output");
    write(fixture.source, "README.md", "dirty\n");
    assert.throws(() => exportPublicRepository(fixture.source, fixture.policy, path.join(fixture.parent, "candidate")), (error) => error instanceof PublicRepositoryError && error.code === "dirty-source");
  } finally {
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
});
