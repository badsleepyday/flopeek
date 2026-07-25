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
  const ignored = new Set([".git", ".flowpeek", "node_modules"]);
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
  const capabilities = read("docs/assets/orientation-capabilities.svg");
  assert.match(capabilities, /14\/14/);
  assert.match(capabilities, /Versioned stale refs/);
  const performance = read("docs/assets/incremental-performance.svg");
  assert.match(performance, /Symfony/);
  assert.match(performance, /54\.53×/);
});

test("README user paths and screenshots are present and portable", () => {
  const readme = read("README.md");
  for (const relativePath of [
    "docs/README.md",
    "docs/using-flowpeek.md",
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

test("bounded scan documentation states the shared complete-result-only contract", () => {
  const readme = read("README.md");
  const guide = read("docs/using-flowpeek.md");
  assert.equal(readme.includes("cancellation parity remain planned"), false);
  assert.ok(readme.includes("CLI, Viewer/HTTP/SSE, and MCP share"));
  assert.equal(guide.includes("This behavior is currently CLI-only."), false);
  assert.ok(guide.includes("local Viewer/HTTP/SSE, and MCP"));
  assert.ok(guide.includes("cancel_scan"));
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
