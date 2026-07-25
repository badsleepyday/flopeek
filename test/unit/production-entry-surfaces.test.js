"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function commit(root, subject) {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", subject]);
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-production-entry-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "flowpeek@example.invalid"]);
  git(root, ["config", "user.name", "Flowpeek test"]);
  write(root, ".gitignore", ".flowpeek/\n");
  write(root, "package.json", JSON.stringify({ name: "production-entry" }));
  write(root, "src/app/api/orders/route.ts", "export async function GET() { return { status: 'initial' }; }\n");
  commit(root, "add endpoint");
  const before = git(root, ["rev-parse", "HEAD"]);
  write(root, "src/app/api/orders/route.ts", "export async function POST() { return { status: 'changed' }; }\n");
  commit(root, "change endpoint");
  return { root, before, after: git(root, ["rev-parse", "HEAD"]) };
}

function text(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

test("production CLI history and stdio MCP load Git continuity without circular module warnings", async () => {
  const fixture = repository();
  const cli = path.join(__dirname, "..", "..", "src", "cli.js");
  let client;
  let transport;
  const stderr = [];
  try {
    const output = execFileSync(process.execPath, [cli, "history", fixture.root, "--from", fixture.before, "--to", fixture.after, "--format", "json"], {
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const history = JSON.parse(output);
    assert.equal(history.schemaVersion, "flowpeek-git-history-comparison/v1");
    assert.equal(history.topology.available, true);

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", fixture.root],
      cwd: path.join(__dirname, "..", ".."),
      stderr: "pipe",
    });
    transport.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    client = new Client({ name: "production-entry-test", version: "1.0.0" });
    await client.connect(transport);
    const result = text(await client.callTool({ name: "compare_git_snapshots", arguments: { from: fixture.before, to: fixture.after } }));
    assert.equal(result.schemaVersion, "flowpeek-git-history-comparison/v1");
    assert.equal(result.topology.available, true);
    assert.doesNotMatch(stderr.join(""), /circular dependency|getGraphDelta is not a function/i);
  } finally {
    if (client) await client.close();
    else if (transport) await transport.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
