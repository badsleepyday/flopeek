"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { getFlowProjection } = require("../../src/flow-lens");
const { scanRepository } = require("../../src/scanner");

const FIXTURE_ROOT = path.join(__dirname, "..", "fixtures", "framework-command-flow");

test("scanner detects exact Click, Typer, and Flask CLI command declarations from source", () => {
  const graph = scanRepository(FIXTURE_ROOT, { persistIdentity: false });
  const commands = graph.nodes.filter((node) => node.kind === "command" && node.entryKind === "framework-command");
  assert.deepEqual(commands.map((node) => ({ adapter: node.adapter, commandName: node.commandName, targetId: node.targetId })).sort((left, right) => left.adapter.localeCompare(right.adapter)), [
    { adapter: "click", commandName: "cleanup", targetId: "symbol:src/commands.py:function:cleanup" },
    { adapter: "flask", commandName: "sync", targetId: "symbol:src/flask_commands.py:function:sync" },
    { adapter: "typer", commandName: "purge", targetId: "symbol:src/typer_commands.py:function:purge_cache" },
  ]);
  assert.equal(graph.analysis.entryPoints.supported.frameworkCommands.length, 3);
  assert.deepEqual(graph.analysis.entryPoints.unsupported.frameworkCommands, [{
    path: "src/unsupported_command.py",
    adapter: "click",
    targetName: "dynamic",
    reason: "non-literal-or-unsupported-command-name",
  }]);

  for (const command of commands) {
    const edge = graph.edges.find((candidate) => candidate.source === command.id && candidate.type === "declares-command-target");
    assert.equal(edge?.target, command.targetId, `${command.adapter} command must bind its declared function`);
    const lens = getFlowProjection(graph, command.id);
    assert.equal(lens?.flow.entry.kind, "framework-command");
    assert.equal(lens?.entryEvidence.binding, "exact-framework-command-target");
    assert.equal(lens?.confidence, "exact-static-evidence");
  }
});
