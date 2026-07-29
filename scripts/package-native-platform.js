#!/usr/bin/env node
"use strict";

// Creates one publishable, platform-locked npm package from a verified Rust
// release binary. The main package never embeds a cross-platform executable;
// npm selects its optional dependency by os/cpu instead.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const packageName = argument("--package");
const os = argument("--os");
const cpu = argument("--cpu");
const binary = argument("--binary");
const output = argument("--output");
const expectedPackage = {
  "win32:x64": "@flopeek/native-win32-x64",
  "win32:arm64": "@flopeek/native-win32-arm64",
  "darwin:x64": "@flopeek/native-darwin-x64",
  "darwin:arm64": "@flopeek/native-darwin-arm64",
  "linux:x64": "@flopeek/native-linux-x64-gnu",
  "linux:arm64": "@flopeek/native-linux-arm64-gnu",
}[`${os}:${cpu}`];
if (!packageName || !os || !cpu || !binary || !output) {
  fail("Usage: package-native-platform --package @flopeek/native-… --os win32 --cpu x64 --binary path --output directory");
} else if (packageName !== expectedPackage) {
  fail(`Unsupported or mismatched native package target: ${packageName} for ${os}/${cpu}.`);
} else if (!fs.existsSync(binary)) {
  fail(`Native release binary is missing: ${binary}`);
} else {
  const root = path.resolve(__dirname, "..");
  const main = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const destination = path.resolve(output);
  const bin = path.join(destination, "bin");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  const executable = os === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core";
  const target = path.join(bin, executable);
  fs.copyFileSync(binary, target);
  if (os !== "win32") fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(destination, "package.json"), `${JSON.stringify({
    name: packageName,
    version: main.version,
    private: false,
    license: main.license,
    description: `Native Flopeek core binary for ${os}/${cpu}.`,
    flopeekNative: {
      protocolVersion: "flopeek-native-protocol/v1",
      binarySha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
    },
    os: [os],
    cpu: [cpu],
    files: ["bin/"],
    publishConfig: { access: "public", tag: main.publishConfig?.tag || "beta" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(destination, "README.md"), `# ${packageName}\n\nPlatform binary package for Flopeek. Installed as an optional dependency of \`flopeek\`.\n`);
  process.stdout.write(`${destination}\n`);
}
