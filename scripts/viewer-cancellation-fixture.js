"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanRepository, writeGraphCache } = require("../src/scanner");
const { startServer } = require("../src/server");

const FILES = 6_000;
const PORT = 4799;
const ROOT = path.join(os.tmpdir(), "flowpeek-df010-bounded-viewer");

function write(relativePath, content) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createFixture() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write("package.json", JSON.stringify({ name: "flowpeek-df010-bounded-viewer" }));
  write("src/route.ts", "export async function GET() { return { ok: true }; }\n");
  for (let index = 0; index < FILES; index += 1) write(`src/module-${index}.ts`, `export function module${index}() { return ${index}; }\n`);
  const baseline = scanRepository(ROOT);
  writeGraphCache(ROOT, baseline, { reason: "df010-viewer-cancellation-baseline" });
}

async function main() {
  createFixture();
  const app = await startServer({
    root: ROOT,
    port: PORT,
    cache: true,
    maxFiles: FILES + 1,
    timeBudgetMs: 30_000,
    analysisDelayMs: 8_000,
    open: false,
    registerServeWorkspace: false,
  });
  console.log(`DF-010 Viewer fixture: http://127.0.0.1:${app.port}/`);
  console.log("Click Scan repository, confirm Scanning and Cancel are visible, then cancel and confirm stale-unverified fallback.");
  const shutdown = () => app.server.close(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(0);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
