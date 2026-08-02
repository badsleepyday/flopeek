"use strict";

const path = require("node:path");

function nativeTestCommand(root, env = process.env) {
  if (env.FLOPEEK_NATIVE_CORE_BINARY) {
    return {
      command: path.resolve(env.FLOPEEK_NATIVE_CORE_BINARY),
      args: [],
      cwd: root,
    };
  }
  return {
    command: "cargo",
    args: ["run", "--quiet", "--manifest-path", path.join(root, "native", "flopeek-core", "Cargo.toml"), "--"],
    cwd: root,
  };
}

module.exports = { nativeTestCommand };
