const fs = require("node:fs");
const path = require("node:path");

const CONFIG_FILENAME = ".flowpeek/config.json";
const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_SCOPE_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  sourceRoots: [],
  testRoots: ["test", "tests", "__tests__"],
  fixtureRoots: ["test/fixtures", "tests/fixtures", "__fixtures__"],
  exclude: [],
  projectId: null,
  flowEntries: { tests: false, fixtures: false },
});
const GENERATED_DIRECTORY_NAMES = new Set(["generated", "__generated__"]);
const PROJECT_ID_ALLOWED_CHARACTERS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:._-");

class RepositoryScopeConfigError extends Error {
  constructor(message) {
    super(`Invalid Flowpeek repository scope configuration: ${message}`);
    this.name = "RepositoryScopeConfigError";
    this.code = "FLOWPEEK_INVALID_SCOPE_CONFIG";
  }
}

function toPosix(value) {
  return String(value).replaceAll("\\", "/");
}

function splitPath(value) {
  return toPosix(value).split("/").filter(Boolean);
}

function normaliseRule(value, field, { allowGlob = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new RepositoryScopeConfigError(`${field} entries must be non-empty strings.`);
  const normalized = toPosix(value.trim()).replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || normalized.startsWith("/")) throw new RepositoryScopeConfigError(`${field} entries must be repository-relative paths.`);
  const segments = splitPath(normalized);
  if (segments.includes("..")) throw new RepositoryScopeConfigError(`${field} entries must not traverse outside the repository.`);
  if (!allowGlob && segments.some((segment) => segment.includes("*"))) throw new RepositoryScopeConfigError(`${field} roots cannot contain glob segments.`);
  if (allowGlob && segments.some((segment) => segment.includes("*") && segment !== "*" && segment !== "**")) throw new RepositoryScopeConfigError(`${field} supports only whole-segment * and ** globs.`);
  return normalized;
}

function normalisePathList(value, field, options) {
  if (!Array.isArray(value)) throw new RepositoryScopeConfigError(`${field} must be an array of repository-relative paths.`);
  return [...new Set(value.map((entry) => normaliseRule(entry, field, options)))].sort();
}

function cloneDefaults() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    sourceRoots: [...DEFAULT_SCOPE_CONFIG.sourceRoots],
    testRoots: [...DEFAULT_SCOPE_CONFIG.testRoots],
    fixtureRoots: [...DEFAULT_SCOPE_CONFIG.fixtureRoots],
    exclude: [...DEFAULT_SCOPE_CONFIG.exclude],
    projectId: DEFAULT_SCOPE_CONFIG.projectId,
    flowEntries: { ...DEFAULT_SCOPE_CONFIG.flowEntries },
  };
}

function isValidProjectId(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 160) return false;
  for (const character of value) {
    if (!PROJECT_ID_ALLOWED_CHARACTERS.has(character)) return false;
  }
  return true;
}

function validateScopeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepositoryScopeConfigError("config.json must contain an object.");
  const allowed = new Set(["schemaVersion", "sourceRoots", "testRoots", "fixtureRoots", "exclude", "projectId", "flowEntries"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new RepositoryScopeConfigError(`unknown property \"${key}\".`);
  }
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new RepositoryScopeConfigError(`schemaVersion must be ${CONFIG_SCHEMA_VERSION}.`);
  const defaults = cloneDefaults();
  const flowEntries = value.flowEntries === undefined ? defaults.flowEntries : value.flowEntries;
  if (!flowEntries || typeof flowEntries !== "object" || Array.isArray(flowEntries)) throw new RepositoryScopeConfigError("flowEntries must be an object.");
  for (const key of Object.keys(flowEntries)) {
    if (key !== "tests" && key !== "fixtures") throw new RepositoryScopeConfigError(`flowEntries has unknown property \"${key}\".`);
    if (typeof flowEntries[key] !== "boolean") throw new RepositoryScopeConfigError(`flowEntries.${key} must be a boolean.`);
  }
  const projectId = value.projectId === undefined ? defaults.projectId : value.projectId;
  if (projectId !== null && !isValidProjectId(projectId)) throw new RepositoryScopeConfigError("projectId must be null or a stable identifier containing only letters, numbers, colon, dot, underscore, or hyphen.");
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    sourceRoots: value.sourceRoots === undefined ? defaults.sourceRoots : normalisePathList(value.sourceRoots, "sourceRoots"),
    testRoots: value.testRoots === undefined ? defaults.testRoots : normalisePathList(value.testRoots, "testRoots"),
    fixtureRoots: value.fixtureRoots === undefined ? defaults.fixtureRoots : normalisePathList(value.fixtureRoots, "fixtureRoots"),
    exclude: value.exclude === undefined ? defaults.exclude : normalisePathList(value.exclude, "exclude", { allowGlob: true }),
    projectId,
    flowEntries: {
      tests: flowEntries.tests === undefined ? defaults.flowEntries.tests : flowEntries.tests,
      fixtures: flowEntries.fixtures === undefined ? defaults.flowEntries.fixtures : flowEntries.fixtures,
    },
  };
}

function readRepositoryScope(root) {
  const configPath = path.join(root, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return { ...cloneDefaults(), source: "defaults", configPath: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new RepositoryScopeConfigError(`.flowpeek/config.json is not valid JSON (${error.message}).`);
  }
  return { ...validateScopeConfig(parsed), source: "config", configPath: CONFIG_FILENAME };
}

function pathWithinRoot(relativePath, root) {
  if (root === ".") return true;
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function segmentMatches(pattern, value) {
  return pattern === "*" || pattern === value;
}

function matchesExcludePattern(relativePath, pattern) {
  const pathSegments = splitPath(relativePath);
  const patternSegments = splitPath(pattern);
  const visit = (pathIndex, patternIndex) => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const token = patternSegments[patternIndex];
    if (token === "**") {
      if (patternIndex === patternSegments.length - 1) return true;
      for (let index = pathIndex; index <= pathSegments.length; index += 1) {
        if (visit(index, patternIndex + 1)) return true;
      }
      return false;
    }
    return pathIndex < pathSegments.length && segmentMatches(token, pathSegments[pathIndex]) && visit(pathIndex + 1, patternIndex + 1);
  };
  if (!patternSegments.some((segment) => segment.includes("*"))) return pathWithinRoot(relativePath, pattern);
  return visit(0, 0);
}

function looksLikeTestPath(relativePath) {
  const segments = splitPath(relativePath).map((segment) => segment.toLowerCase());
  const filename = segments.at(-1) || "";
  const extension = filename.lastIndexOf(".");
  const stem = extension > 0 ? filename.slice(0, extension) : filename;
  return segments.includes("__tests__") || stem.includes(".test") || stem.includes(".spec") || stem.endsWith("_test");
}

function looksGenerated(relativePath) {
  const segments = splitPath(relativePath).map((segment) => segment.toLowerCase());
  const filename = segments.at(-1) || "";
  return segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment)) || filename.includes(".generated.");
}

function classifyRepositoryPath(relativePath, scope) {
  const normalized = normaliseRule(relativePath, "repository path");
  if (scope.exclude.some((pattern) => matchesExcludePattern(normalized, pattern))) return "excluded";
  if (scope.fixtureRoots.some((root) => pathWithinRoot(normalized, root))) return "fixture";
  if (scope.testRoots.some((root) => pathWithinRoot(normalized, root)) || looksLikeTestPath(normalized)) return "test";
  if (looksGenerated(normalized)) return "generated";
  if (scope.sourceRoots.length && !scope.sourceRoots.some((root) => pathWithinRoot(normalized, root))) return "excluded";
  return "application";
}

function scopeSummary(scope, records, excludedPaths = []) {
  const counts = { application: 0, test: 0, fixture: 0, generated: 0, excluded: excludedPaths.length };
  for (const record of records) counts[record.sourceScope] += 1;
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    source: scope.source,
    configPath: scope.configPath,
    sourceRoots: scope.sourceRoots,
    testRoots: scope.testRoots,
    fixtureRoots: scope.fixtureRoots,
    exclude: scope.exclude,
    projectId: scope.projectId,
    flowEntries: scope.flowEntries,
    precedence: ["excluded", "fixture", "test", "generated", "application"],
    counts,
    limitations: [
      "Scope classification is path-based and does not execute repository configuration.",
      "Generated source is retained for diagnostics but is not an application-flow entry by default.",
      "Diagnostic/all views include test, fixture, and generated source; their relationships remain static evidence, not runtime behavior.",
    ],
  };
}

function scopeSignature(scope) {
  return JSON.stringify({
    schemaVersion: scope.schemaVersion,
    sourceRoots: scope.sourceRoots,
    testRoots: scope.testRoots,
    fixtureRoots: scope.fixtureRoots,
    exclude: scope.exclude,
    projectId: scope.projectId,
    flowEntries: scope.flowEntries,
  });
}

module.exports = {
  CONFIG_FILENAME,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_SCOPE_CONFIG,
  RepositoryScopeConfigError,
  classifyRepositoryPath,
  readRepositoryScope,
  scopeSignature,
  scopeSummary,
};
