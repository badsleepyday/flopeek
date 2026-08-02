"use strict";

const fs = require("node:fs");

function canonicalRealpath(inputPath, fileSystem = fs) {
  const nativeRealpath = fileSystem.realpathSync?.native;
  if (typeof nativeRealpath === "function") return nativeRealpath(inputPath);
  if (typeof fileSystem.realpathSync === "function") return fileSystem.realpathSync(inputPath);
  throw new TypeError("A synchronous realpath implementation is required.");
}

module.exports = { canonicalRealpath };
