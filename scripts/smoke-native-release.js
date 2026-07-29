#!/usr/bin/env node
"use strict";

// This deliberately executes the packaged release candidate rather than
// `cargo run`: CI must prove that the binary selected by normal native
// resolution starts and speaks its version contract on every OS.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const executable = process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
const binary = path.join(root, "native", "flopeek-core", "target", "release", executable);
if (!fs.existsSync(binary)) throw new Error(`Native release binary is missing: ${binary}`);
const version = execFileSync(binary, ["--version"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 }).trim();
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (version !== expectedVersion) throw new Error(`Native release version mismatch: expected ${expectedVersion}, received ${JSON.stringify(version)}.`);
process.stdout.write(`Native release smoke: ${version}\n`);
