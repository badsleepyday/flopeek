"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { nativeTestCommand } = require("../helpers/native-test-command");

test("native proof harness binds to the exact candidate binary when provided", () => {
  const root = path.resolve("fixture-root");
  const binary = path.resolve("candidate", "flopeek-native-core");
  assert.deepEqual(nativeTestCommand(root, { FLOPEEK_NATIVE_CORE_BINARY: binary }), {
    command: binary,
    args: [],
    cwd: root,
  });
});

test("native proof harness retains the source-backed Cargo path outside candidate evidence", () => {
  const root = path.resolve("fixture-root");
  assert.deepEqual(nativeTestCommand(root, {}), {
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", path.join(root, "native", "flopeek-core", "Cargo.toml"), "--"],
    cwd: root,
  });
});
