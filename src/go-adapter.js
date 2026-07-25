const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let helperPath = null;
let helperAttempted = false;

function helperTimeout(defaultTimeout) {
  const value = Number(process.env.FLOWPEEK_TEST_MODE === "1" ? process.env.FLOWPEEK_TEST_HELPER_TIMEOUT_MS : null);
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
  const target = path.join(os.tmpdir(), `flowpeek-go-facts-${fingerprint}${extension}`);
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
  try {
    const output = execFileSync(helperPath, [], {
      input: JSON.stringify({ files: absolutePaths }),
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
