"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function markdownFiles(directory = ROOT) {
  const ignored = new Set([".git", ".flopeek", "node_modules"]);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolutePath);
    return entry.isFile() && path.extname(entry.name).toLowerCase() === ".md" ? [absolutePath] : [];
  });
}

test("public documentation charts match checked benchmark evidence", () => {
  const result = spawnSync(process.execPath, ["scripts/generate-doc-assets.js", "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const attributes = read(".gitattributes");
  assert.match(attributes, /^docs\/assets\/\*\.svg text eol=lf$/mu);
  for (const name of ["orientation-capabilities.svg", "incremental-performance.svg", "shared-context-workflow.svg"]) {
    assert.equal(read(`docs/assets/${name}`).includes("\r"), false, `${name} must use LF line endings`);
  }
  const capabilities = read("docs/assets/orientation-capabilities.svg");
  assert.match(capabilities, /14\/14/);
  assert.match(capabilities, /Versioned stale refs/);
  const performance = read("docs/assets/incremental-performance.svg");
  assert.match(performance, /Symfony/);
  assert.match(performance, /Vite/);
  assert.match(performance, /All 5 pinned repositories/);
  assert.match(performance, /<polyline/);
});

test("README user paths and screenshots are present and portable", () => {
  const readme = read("README.md");
  for (const relativePath of [
    "docs/README.md",
    "docs/using-flopeek.md",
    "docs/assets/shared-context-workflow.svg",
    "docs/assets/orientation-capabilities.svg",
    "docs/assets/incremental-performance.svg",
    "docs/assets/screenshots/flow-lens.png",
    "docs/assets/screenshots/flow-comparison.png",
    "docs/assets/screenshots/product-proof.png",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} must exist`);
    assert.ok(readme.includes(relativePath), `${relativePath} must be linked from README.md`);
  }
  assert.equal(readme.includes("C:\\Users\\"), false);
  assert.equal(readme.includes("AppData\\Local\\Temp"), false);
});

test("README leads with one reproducible change-context loop", () => {
  const readme = read("README.md");
  assert.match(readme, /## The five-minute change-context loop/);
  assert.match(readme, /Copy its versioned Context Ref/);
  assert.match(readme, /Compare before\/current evidence/);
  assert.match(readme, /## Run the change-context loop/);
  assert.match(readme, /npm install --global flopeek@beta/);
  assert.match(readme, /Use the explicit `@beta` channel until a stable release is published/);
  assert.equal(readme.includes("not available from npm yet"), false);
  assert.match(readme, /docs\/showcase-walkthrough\.md/);
  assert.equal(readme.includes("## What you get"), false);
});

test("public product identity keeps the brand and release boundary explicit", () => {
  const identity = read("docs/product-identity.md");
  const packageJson = JSON.parse(read("package.json"));
  assert.match(identity, /\*\*Flopeek\*\*/);
  assert.match(identity, /Versioned change context for developers and coding agents\./);
  assert.match(identity, /does \*\*not\*\* claim trademark clearance/);
  assert.equal(packageJson.name, "flopeek");
  assert.equal(packageJson.description, "Versioned change context for developers and coding agents.");
});

test("bounded scan documentation states the shared complete-result-only contract", () => {
  const readme = read("README.md");
  const guide = read("docs/using-flopeek.md");
  assert.equal(readme.includes("cancellation parity remain planned"), false);
  assert.ok(readme.includes("CLI, Viewer/HTTP/SSE, and MCP share"));
  assert.equal(guide.includes("This behavior is currently CLI-only."), false);
  assert.ok(guide.includes("local Viewer/HTTP/SSE, and MCP"));
  assert.ok(guide.includes("cancel_scan"));
});

test("roadmap makes native promotion the only NOW authority and freezes product breadth", () => {
  const roadmap = read("ROADMAP.md");
  const now = roadmap.split("### NOW — Native promotion decision")[1]?.split("### FROZEN — Until promotion or cancellation is recorded")[0];
  const frozen = roadmap.split("### FROZEN — Until promotion or cancellation is recorded")[1]?.split("### NEXT — After the recorded default-core decision")[0];
  assert.ok(now, "ROADMAP must define an authoritative native-promotion NOW section");
  assert.match(now, /single-authority recovery/);
  assert.match(now, /at\s+least five distinct repositories/);
  assert.match(now, /all six native platform packages/);
  assert.match(now, /several days of honest dogfood/);
  assert.match(now, /JavaScript remains the public default/);
  for (const boundary of ["Work continuation", "Semantic inference", "Multi-project expansion", "New language or framework adapters", "Viewer\/WebGL", "New MCP tools"]) {
    assert.match(frozen, new RegExp(boundary));
  }
  assert.match(roadmap, /## Frozen historical sequence — Versioned work continuation/);
  assert.doesNotMatch(roadmap, /## Next executable sequence — Versioned work continuation/);
  for (const delivered of ["Split fast unit/contract tests", "Create machine-readable adapter capability registry", "Add CLI `--version` and `doctor`", "Establish public license and packaging policy"]) {
    assert.ok(roadmap.includes(`- [x] ${delivered}`), `${delivered} must remain recorded as delivered`);
  }
});

test("clean-room documentation keeps its explicit public benchmark count aligned with package metadata", () => {
  const guide = read("docs/clean-room-package.md");
  const packageJson = JSON.parse(read("package.json"));
  const benchmarkCount = packageJson.files.filter((item) => item.startsWith("benchmarks/")).length;
  assert.match(guide, new RegExp(`\\b${benchmarkCount} explicitly named machine-readable public benchmark/template artifacts\\b`));
  assert.ok(guide.includes("until both npm and policy allowlists are deliberately updated"));
});

test("documentation screenshots are real PNG captures with a useful viewport", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const name of ["flow-lens.png", "flow-comparison.png", "product-proof.png"]) {
    const body = fs.readFileSync(path.join(ROOT, "docs", "assets", "screenshots", name));
    assert.ok(body.subarray(0, 8).equals(signature));
    assert.ok(body.length > 50_000, `${name} must contain a rendered Viewer capture`);
  }
});

test("Viewer QA guidance preserves current S5 evidence boundaries", () => {
  const guide = read("docs/viewer-observable-qa.md");
  assert.ok(guide.includes("beccef32af9b0a978d4463a90806aeb66a8f1a28"));
  assert.ok(guide.includes("six-job CI matrix"));
  assert.ok(guide.includes("v2 Flow Context Ref as `stale`"));
  assert.ok(guide.includes("390 px"));
  assert.ok(guide.includes("screen reader"));
  assert.ok(guide.includes("flopeek-independent-review/v1"));
  assert.ok(guide.includes("S5 is `partial`"));
  assert.ok(guide.includes("Chrome on Windows, Linux, Android, and iPhone"));
  assert.ok(guide.includes("physical macOS device was available"));
  assert.ok(guide.includes("not turn the reported platforms into reproducible accessibility"));
  assert.equal(guide.includes("dirty\ndevelopment tree"), false);
  assert.equal(guide.includes("full suite (296/296)"), false);
});

test("all local Markdown links resolve inside the repository", () => {
  const linkPattern = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  const missing = [];
  for (const markdownPath of markdownFiles()) {
    const body = fs.readFileSync(markdownPath, "utf8");
    for (const match of body.matchAll(linkPattern)) {
      const rawTarget = match[1];
      if (/^(?:https?:|mailto:|#)/iu.test(rawTarget)) continue;
      const target = decodeURIComponent(rawTarget.split("#", 1)[0]);
      if (!target) continue;
      const resolved = path.resolve(path.dirname(markdownPath), target);
      if (!fs.existsSync(resolved)) missing.push(`${path.relative(ROOT, markdownPath)} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});
