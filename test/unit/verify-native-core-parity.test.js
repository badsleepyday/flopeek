"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseArguments } = require("../../scripts/verify-native-core-parity");

test("native core parity verifier requires explicit existing roots", () => {
  assert.throws(() => parseArguments([]), /Supply one or more --root/u);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseArguments(["--root"]), /requires a repository path/u);
});

test("native core parity verifier normalizes repeated roots", () => {
  const root = process.cwd();
  assert.deepEqual(parseArguments(["--root", root, "--root", root]), [root]);
});
