#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "contracts", "go-stdlib-catalog.json");
const EXPECTED_GO_VERSION = "go1.26.4";
const TARGETS = [
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" },
  { goos: "windows", goarch: "arm64" },
];
const execFileAsync = promisify(execFile);

function goCommand() {
  return process.platform === "win32" ? "go.exe" : "go";
}

function goOutput(...args) {
  return execFileSync(goCommand(), args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GOTOOLCHAIN: "local" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}

async function targetPackages(target) {
  const { stdout } = await execFileAsync(goCommand(), ["list", "std"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOARCH: target.goarch,
      GOEXPERIMENT: "",
      GOFLAGS: "",
      GOOS: target.goos,
      GOTOOLCHAIN: "local",
    },
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim().split(/\r?\n/u).filter(Boolean);
}

async function generatedCatalog() {
  const goVersion = goOutput("env", "GOVERSION");
  if (goVersion !== EXPECTED_GO_VERSION) {
    throw new Error(`Go stdlib catalog requires ${EXPECTED_GO_VERSION}; found ${goVersion}.`);
  }
  const packages = new Set(["C"]);
  for (const targetResult of await Promise.all(TARGETS.map(targetPackages))) {
    for (const specifier of targetResult) packages.add(specifier);
  }
  return {
    schemaVersion: "flopeek-go-stdlib-catalog/v1",
    goVersion,
    targets: TARGETS.map(({ goos, goarch }) => `${goos}/${goarch}`),
    packages: [...packages].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  };
}

async function main() {
  const rendered = `${JSON.stringify(await generatedCatalog(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, "utf8") !== rendered) {
      throw new Error(`Go stdlib catalog is stale. Run node ${path.relative(ROOT, __filename)}.`);
    }
    process.stdout.write(`Go stdlib catalog matches ${EXPECTED_GO_VERSION}.\n`);
  } else {
    fs.writeFileSync(OUTPUT, rendered, "utf8");
    process.stdout.write(`Generated ${path.relative(ROOT, OUTPUT)} for ${EXPECTED_GO_VERSION}.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
