"use strict";

const path = require("node:path");
const { nativeRustShadowProjection } = require("../src/native-rust-shadow");

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
process.stdout.write(`${JSON.stringify(nativeRustShadowProjection(root))}\n`);
