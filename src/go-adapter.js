const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let helperPath = null;
let helperAttempted = false;
let standardImportCatalog = null;
const GO_STDLIB_CATALOG_SCHEMA = "flopeek-go-stdlib-catalog/v1";
const GO_STDLIB_CATALOG_TARGETS = [
  "darwin/amd64",
  "darwin/arm64",
  "linux/amd64",
  "linux/arm64",
  "windows/amd64",
  "windows/arm64",
];

function standardImports() {
  if (standardImportCatalog) return standardImportCatalog;
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "contracts", "go-stdlib-catalog.json"), "utf8"));
  if (catalog?.schemaVersion !== GO_STDLIB_CATALOG_SCHEMA
    || catalog.goVersion !== "go1.26.4"
    || JSON.stringify(catalog.targets) !== JSON.stringify(GO_STDLIB_CATALOG_TARGETS)
    || typeof catalog.goVersion !== "string"
    || !Array.isArray(catalog.packages)
    || catalog.packages.some((specifier) => typeof specifier !== "string")
    || new Set(catalog.packages).size !== catalog.packages.length
    || !catalog.packages.includes("C")) {
    throw new Error(`Go stdlib catalog must use ${GO_STDLIB_CATALOG_SCHEMA}.`);
  }
  standardImportCatalog = Object.freeze([...catalog.packages]);
  return standardImportCatalog;
}

function helperTimeout(defaultTimeout) {
  const value = Number(process.env.FLOPEEK_TEST_MODE === "1" ? process.env.FLOPEEK_TEST_HELPER_TIMEOUT_MS : null);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultTimeout;
}

function goCommand() {
  return process.platform === "win32" ? "go.exe" : "go";
}

function buildHelper() {
  const sourcePath = path.join(__dirname, "go-facts.go");
  const source = fs.readFileSync(sourcePath);
  const fingerprint = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
  const extension = process.platform === "win32" ? ".exe" : "";
  const target = path.join(os.tmpdir(), `flopeek-go-facts-${fingerprint}${extension}`);
  if (fs.existsSync(target)) return target;
  const temporary = `${target}.${process.pid}.${Date.now()}${extension}`;
  try {
    execFileSync(goCommand(), ["build", "-o", temporary, sourcePath], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    try {
      fs.renameSync(temporary, target);
    } catch {
      if (!fs.existsSync(target)) throw new Error("Unable to create Go parser helper.");
      fs.rmSync(temporary, { force: true });
    }
    return target;
  } catch {
    fs.rmSync(temporary, { force: true });
    return null;
  }
}

function goFacts(absolutePaths) {
  if (!absolutePaths.length) return new Map();
  if ((!helperPath || !fs.existsSync(helperPath)) && !helperAttempted) {
    helperAttempted = true;
    helperPath = buildHelper();
  }
  if (!helperPath) return new Map();
  // The packaged catalog is part of the adapter contract. Keep toolchain
  // unavailability optional, but never hide a missing or invalid catalog as
  // an inventory-only Go scan.
  const catalog = standardImports();
  try {
    const output = execFileSync(helperPath, [], {
      input: JSON.stringify({ files: absolutePaths, standardImports: catalog }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: helperTimeout(60_000),
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(output);
    return new Map((parsed.facts || []).filter((fact) => typeof fact?.file === "string").map((fact) => [path.resolve(fact.file), fact]));
  } catch {
    return new Map();
  }
}

module.exports = { goFacts };
