"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { adapterForPath, getAdapterRegistry } = require("./adapter-registry");
const { classifyRepositoryPath, readRepositoryScope, scopeSummary } = require("./scope");

const DISCOVERY_SCHEMA = "flopeek-repository-discovery/v1";
const IGNORED_DIRECTORIES = new Set([
  ".flopeek", ".git", ".next", ".nuxt", ".project-flow", ".turbo",
  "build", "coverage", "dist", "node_modules", "out", "target", "vendor",
]);
const EXACT_MANIFESTS = new Map([
  ["package.json", "node-package"],
  ["pnpm-workspace.yaml", "pnpm-workspace"],
  ["pnpm-workspace.yml", "pnpm-workspace"],
  ["go.work", "go-workspace"],
  ["go.mod", "go-module"],
  ["Cargo.toml", "cargo"],
  ["pom.xml", "maven"],
  ["build.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["settings.gradle", "gradle-settings"],
  ["settings.gradle.kts", "gradle-settings"],
  ["composer.json", "composer"],
]);
const RESOLVER_CONTROL_FILES = new Set([
  "go.mod", "Cargo.toml", "pnpm-workspace.yaml", "pnpm-workspace.yml",
  "vite.config.js", "vite.config.cjs", "vite.config.mjs", "vite.config.ts",
  "vite.config.mts", "vite.config.cts", "vite.config.tsx",
  "webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts",
  "webpack.config.mts", "webpack.config.cts", "webpack.config.tsx",
]);

class RepositoryDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RepositoryDiscoveryError";
    this.code = code;
  }
}

function positiveInteger(value, field) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RepositoryDiscoveryError("invalid-limit", `${field} must be a positive safe integer.`);
  return parsed;
}

function manifestKind(filename) {
  if (EXACT_MANIFESTS.has(filename)) return EXACT_MANIFESTS.get(filename);
  const lower = filename.toLowerCase();
  if (lower.endsWith(".sln")) return "dotnet-solution";
  if (lower.endsWith(".csproj")) return "dotnet-project";
  return null;
}

function safePackageName(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

function toPosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function planSignature(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\n`);
  return `sha256:${hash.digest("hex")}`;
}

function isResolverControlFile(filename) {
  return filename.endsWith(".json") || RESOLVER_CONTROL_FILES.has(filename);
}

function isIncludedDirectory(entry) {
  return entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".");
}

function fingerprintEntries(files, controlFiles) {
  return planSignature([...new Map([
    ...files.map((file) => [file.path, file]),
    ...controlFiles.map((file) => [file.path, file]),
  ]).values()].sort((left, right) => left.path.localeCompare(right.path)));
}

function immutablePlan(root, fingerprint, files, controlFiles, directories, controlDirectories, selection) {
  return Object.freeze({
    root,
    fingerprint,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
    controlFiles: Object.freeze(controlFiles.map((file) => Object.freeze({ ...file }))),
    directories: Object.freeze([...directories]),
    controlDirectories: Object.freeze([...controlDirectories]),
    selection: selection ? Object.freeze({ ...selection }) : null,
  });
}

function resolvePlanPath(root, relativePath, allowRoot = false) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) return null;
  const absolutePath = path.resolve(root, relativePath.split("/").join(path.sep));
  const rootRelativePath = path.relative(root, absolutePath);
  if (rootRelativePath === "") return allowRoot ? absolutePath : null;
  if (rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)) return null;
  return absolutePath;
}

function resolvePackageSelection(root, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw new RepositoryDiscoveryError("invalid-package-path", "packagePath must be a non-empty repository-relative package directory.");
  const requestedPath = value.trim();
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) throw new RepositoryDiscoveryError("invalid-package-path", "packagePath must be repository-relative.");
  const requestedSegments = requestedPath.replaceAll("\\", "/").split("/");
  if (requestedSegments.some((segment) => segment === "..")) throw new RepositoryDiscoveryError("invalid-package-path", "packagePath must not contain parent-directory traversal.");
  const absolutePath = path.resolve(root, requestedSegments.join(path.sep));
  const rootRelativePath = path.relative(root, absolutePath);
  if (rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)) throw new RepositoryDiscoveryError("invalid-package-path", "packagePath must remain inside the repository.");
  const localSegments = rootRelativePath ? rootRelativePath.split(path.sep) : [];
  let checkedPath = root;
  for (const segment of localSegments) {
    checkedPath = path.join(checkedPath, segment);
    let checked;
    try {
      checked = fs.lstatSync(checkedPath);
    } catch {
      throw new RepositoryDiscoveryError("package-not-found", "packagePath must name an existing directory containing package.json.");
    }
    if (checked.isSymbolicLink()) throw new RepositoryDiscoveryError("package-not-found", "packagePath must not traverse symbolic-link directories.");
  }
  let directory;
  let manifest;
  try {
    directory = fs.lstatSync(absolutePath);
    manifest = fs.lstatSync(path.join(absolutePath, "package.json"));
  } catch {
    throw new RepositoryDiscoveryError("package-not-found", "packagePath must name an existing directory containing package.json.");
  }
  if (!directory.isDirectory() || directory.isSymbolicLink() || !manifest.isFile() || manifest.isSymbolicLink()) {
    throw new RepositoryDiscoveryError("package-not-found", "packagePath must name a non-symbolic-link directory containing a regular package.json file.");
  }
  const packagePath = toPosix(root, absolutePath) || ".";
  return {
    requestedPath,
    path: packagePath,
    manifest: packagePath === "." ? "package.json" : `${packagePath}/package.json`,
    name: safePackageName(path.join(absolutePath, "package.json")),
    absolutePath,
  };
}

function selectionControlDirectories(root, selection) {
  if (!selection) return ["."];
  const directories = ["."];
  const segments = selection.path === "." ? [] : selection.path.split("/");
  for (let index = 1; index <= segments.length; index += 1) directories.push(segments.slice(0, index).join("/"));
  return directories;
}

function verificationResult(valid, expectedFingerprint, actualFingerprint, reason, diagnostics = []) {
  return {
    schemaVersion: "flopeek-analysis-plan-verification/v1",
    valid,
    expectedFingerprint,
    actualFingerprint,
    reason,
    diagnostics,
  };
}

// This checks the immutable discovery plan directly instead of rediscovering the
// repository. It intentionally reads each planned directory so a newly-created
// source directory cannot evade verification, but it does not repeat workspace,
// adapter, scope-report, manifest, or limit discovery work.
function verifyAnalysisPlan(inputRoot, analysisPlan) {
  let root;
  try {
    root = fs.realpathSync(inputRoot);
  } catch (error) {
    return verificationResult(false, analysisPlan?.fingerprint || null, null, "repository-unavailable", [{ code: "repository-unavailable", message: error?.message || "Repository root is unavailable." }]);
  }
  if (!analysisPlan || !Array.isArray(analysisPlan.files) || !Array.isArray(analysisPlan.controlFiles) || !Array.isArray(analysisPlan.directories) || !Array.isArray(analysisPlan.controlDirectories)) {
    return verificationResult(false, analysisPlan?.fingerprint || null, null, "invalid-analysis-plan", [{ code: "invalid-analysis-plan", message: "The bounded scan did not receive a complete immutable discovery plan." }]);
  }
  if (analysisPlan.root && path.resolve(analysisPlan.root) !== root) {
    return verificationResult(false, analysisPlan.fingerprint || null, null, "analysis-plan-root-mismatch", [{ code: "analysis-plan-root-mismatch", message: "The immutable discovery plan belongs to a different repository root." }]);
  }

  const registry = getAdapterRegistry();
  const scope = readRepositoryScope(root);
  const expectedDirectories = new Set(analysisPlan.directories);
  const actualFiles = [];
  const actualControlFiles = new Map();
  const diagnostics = [];

  const addControlFile = (absolutePath, relativePath, stat = null) => {
    try {
      const current = stat || fs.statSync(absolutePath);
      if (current.isFile() && current.size <= 1_000_000) actualControlFiles.set(relativePath, { path: relativePath, size: current.size, mtimeMs: current.mtimeMs });
    } catch {
      // A missing or unreadable expected control changes the resulting fingerprint.
    }
  };

  const inspectControlDirectory = (directoryPath) => {
    const absoluteDirectory = directoryPath === "." ? root : resolvePlanPath(root, directoryPath);
    if (!absoluteDirectory) return verificationResult(false, analysisPlan.fingerprint || null, null, "invalid-analysis-plan", [{ code: "invalid-control-directory-path", path: directoryPath }]);
    let directoryStat;
    let entries;
    try {
      directoryStat = fs.lstatSync(absoluteDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("planned control directory is no longer a local directory");
      entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      return verificationResult(false, analysisPlan.fingerprint || null, null, "planned-control-directory-changed", [{ code: "planned-control-directory-changed", path: directoryPath, message: error?.message || "Planned control directory could not be read." }]);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !isResolverControlFile(entry.name)) continue;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      addControlFile(absolutePath, toPosix(root, absolutePath));
    }
    return null;
  };

  for (const directoryPath of analysisPlan.controlDirectories) {
    const controlFailure = inspectControlDirectory(directoryPath);
    if (controlFailure) return controlFailure;
  }

  for (const directoryPath of analysisPlan.directories) {
    const absoluteDirectory = directoryPath === "." ? root : resolvePlanPath(root, directoryPath);
    if (!absoluteDirectory) return verificationResult(false, analysisPlan.fingerprint || null, null, "invalid-analysis-plan", [{ code: "invalid-directory-path", path: directoryPath }]);
    let directoryStat;
    let entries;
    try {
      directoryStat = fs.lstatSync(absoluteDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("planned directory is no longer a local directory");
      entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      return verificationResult(false, analysisPlan.fingerprint || null, null, "planned-directory-changed", [{ code: "planned-directory-changed", path: directoryPath, message: error?.message || "Planned directory could not be read." }]);
    }
    for (const entry of entries) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = toPosix(root, absolutePath);
      if (isIncludedDirectory(entry)) {
        if (!expectedDirectories.has(relativePath)) {
          return verificationResult(false, analysisPlan.fingerprint || null, null, "source-directory-added", [{ code: "source-directory-added", path: relativePath }]);
        }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        diagnostics.push({ code: "file-unreadable", path: relativePath });
        continue;
      }
      if (isResolverControlFile(entry.name)) addControlFile(absolutePath, relativePath, stat);
      const adapter = adapterForPath(entry.name, registry);
      if (!adapter || stat.size > 1_000_000 || classifyRepositoryPath(relativePath, scope) === "excluded") continue;
      actualFiles.push({ path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  addControlFile(path.join(root, ".flopeek", "config.json"), ".flopeek/config.json");
  actualFiles.sort((left, right) => left.path.localeCompare(right.path));
  const actualFingerprint = fingerprintEntries(actualFiles, [...actualControlFiles.values()]);
  if (actualFingerprint !== analysisPlan.fingerprint) {
    return verificationResult(false, analysisPlan.fingerprint, actualFingerprint, "source-inventory-changed", diagnostics);
  }
  return verificationResult(true, analysisPlan.fingerprint, actualFingerprint, null, diagnostics);
}

function discoverRepository(inputRoot, options = {}) {
  const root = fs.realpathSync(inputRoot);
  const selection = resolvePackageSelection(root, options.packagePath);
  const selectedRoot = selection?.absolutePath || root;
  const scope = readRepositoryScope(root);
  const registry = getAdapterRegistry();
  const limits = {
    timeBudgetMs: positiveInteger(options.timeBudgetMs, "timeBudgetMs"),
    maxFiles: positiveInteger(options.maxFiles, "maxFiles"),
    maxBytes: positiveInteger(options.maxBytes, "maxBytes"),
  };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = now();
  const deadline = limits.timeBudgetMs === null ? null : startedAt + limits.timeBudgetMs;
  const adapters = new Map(registry.adapters.map((adapter) => [adapter.id, {
    id: adapter.id,
    availability: adapter.availability,
    requiredToolchain: adapter.requiredToolchain,
    files: 0,
    bytes: 0,
  }]));
  const manifests = [];
  const packages = [];
  const diagnostics = [];
  const scopeCounts = { application: 0, test: 0, fixture: 0, generated: 0, excluded: 0 };
  let visitedDirectories = 0;
  let candidateFiles = 0;
  let candidateBytes = 0;
  let oversizedFiles = 0;
  let unreadableEntries = 0;
  let timeBudgetExceeded = false;
  const analysisFiles = [];
  const controlFiles = new Map();
  const directories = [];
  const controlDirectories = selectionControlDirectories(root, selection);

  const addControlFile = (absolute, relativePath, stat = null) => {
    try {
      const current = stat || fs.statSync(absolute);
      if (current.isFile() && current.size <= 1_000_000) {
        controlFiles.set(relativePath, { path: relativePath, size: current.size, mtimeMs: current.mtimeMs });
      }
    } catch {
      // Unreadable controls are reported by their normal traversal when visible.
    }
  };

  addControlFile(path.join(root, ".flopeek", "config.json"), ".flopeek/config.json");

  const collectControlFiles = (directoryPath) => {
    const absoluteDirectory = directoryPath === "." ? root : resolvePlanPath(root, directoryPath);
    if (!absoluteDirectory) return;
    let entries;
    try {
      entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      unreadableEntries += 1;
      diagnostics.push({ code: "control-directory-unreadable", path: directoryPath });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !isResolverControlFile(entry.name)) continue;
      const absolute = path.join(absoluteDirectory, entry.name);
      addControlFile(absolute, toPosix(root, absolute));
    }
  };
  for (const directoryPath of controlDirectories) collectControlFiles(directoryPath);

  const checkpoint = () => {
    if (deadline !== null && now() >= deadline) {
      timeBudgetExceeded = true;
      return false;
    }
    return true;
  };

  const visit = (directory) => {
    if (!checkpoint()) return;
    visitedDirectories += 1;
    directories.push(toPosix(root, directory) || ".");
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      unreadableEntries += 1;
      diagnostics.push({ code: "directory-unreadable", path: toPosix(root, directory) || "." });
      return;
    }
    for (const entry of entries) {
      if (!checkpoint()) return;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (isIncludedDirectory(entry)) visit(absolute);
        if (timeBudgetExceeded) return;
        continue;
      }
      if (entry.isSymbolicLink()) {
        diagnostics.push({ code: "symbolic-link-skipped", path: toPosix(root, absolute) });
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toPosix(root, absolute);
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        unreadableEntries += 1;
        diagnostics.push({ code: "file-unreadable", path: relativePath });
        continue;
      }
      if (isResolverControlFile(entry.name)) addControlFile(absolute, relativePath, stat);
      const kind = manifestKind(entry.name);
      if (kind) {
        const manifestScope = relativePath === "package.json" ? "project-control" : classifyRepositoryPath(relativePath, scope);
        const manifest = { kind, path: relativePath, scope: manifestScope };
        manifests.push(manifest);
        if (kind === "node-package") packages.push({ path: path.posix.dirname(relativePath) === "." ? "." : path.posix.dirname(relativePath), name: safePackageName(absolute), manifest: relativePath, scope: manifestScope });
      }
      const adapter = adapterForPath(entry.name, registry);
      if (!adapter) continue;
      if (stat.size > 1_000_000) {
        oversizedFiles += 1;
        diagnostics.push({ code: "file-size-limit", path: relativePath, bytes: stat.size });
        continue;
      }
      const sourceScope = classifyRepositoryPath(relativePath, scope);
      scopeCounts[sourceScope] += 1;
      if (sourceScope === "excluded") continue;
      candidateFiles += 1;
      candidateBytes += stat.size;
      analysisFiles.push({ path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
      const adapterSummary = adapters.get(adapter.id);
      adapterSummary.files += 1;
      adapterSummary.bytes += stat.size;
    }
  };

  visit(selectedRoot);
  const fileLimitExceeded = limits.maxFiles !== null && candidateFiles > limits.maxFiles;
  const byteLimitExceeded = limits.maxBytes !== null && candidateBytes > limits.maxBytes;
  const reasons = [];
  if (timeBudgetExceeded) reasons.push("time-budget-exceeded");
  if (fileLimitExceeded) reasons.push("file-limit-exceeded");
  if (byteLimitExceeded) reasons.push("byte-limit-exceeded");
  const completedAt = now();
  const status = reasons.length ? "bounded" : "complete";
  const scopeReport = scopeSummary(scope, [], []);
  scopeReport.counts = scopeCounts;

  analysisFiles.sort((left, right) => left.path.localeCompare(right.path));
  const controlFileEntries = [...controlFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
  const fingerprint = fingerprintEntries(analysisFiles, controlFileEntries);
  const result = {
    schemaVersion: DISCOVERY_SCHEMA,
    generatedAt: new Date().toISOString(),
    project: {
      name: safePackageName(path.join(root, "package.json")) || path.basename(root),
    },
    status,
    reasons,
    limits,
    durationMs: Math.max(0, Number((completedAt - startedAt).toFixed(3))),
    inventory: {
      complete: !timeBudgetExceeded,
      visitedDirectories,
      candidateFiles,
      candidateBytes,
      controlFiles: controlFiles.size,
      fingerprint,
      oversizedFiles,
      unreadableEntries,
    },
    scope: scopeReport,
    adapters: [...adapters.values()].filter((adapter) => adapter.files > 0).sort((left, right) => left.id.localeCompare(right.id)),
    workspace: {
      manifests: manifests.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)),
      packages: packages.sort((left, right) => left.path.localeCompare(right.path)),
      limitations: [
        "Discovery identifies static manifest files and package names without executing repository configuration.",
        "Manifest scope is path-derived; project-control marks the root package manifest even when sourceRoots narrow code discovery.",
        "Manifest presence does not prove that a package, module, build, or runtime integration is active.",
      ],
    },
    selection: selection ? {
      kind: "static-package-path",
      status: "selected",
      requestedPath: selection.requestedPath,
      path: selection.path,
      manifest: selection.manifest,
      packageName: selection.name,
      limitations: [
        "The selected package path is a bounded static source subtree, not proof of workspace membership, dependency ownership, build activation, or runtime topology.",
        "Scoped scans use a session-only graph identity and do not replace the repository-wide graph cache.",
      ],
    } : {
      kind: "repository",
      status: "repository-wide",
      requestedPath: null,
      path: ".",
      manifest: null,
      packageName: null,
      limitations: [],
    },
    diagnostics,
    decision: {
      safeToStartFullScan: status === "complete",
      reason: status === "complete"
        ? "Discovery completed within every declared bound."
        : "The full scan was not started because discovery exceeded at least one declared bound.",
    },
    limitations: [
      "Discovery is an inventory and resource-bound preflight, not a parsed technical graph.",
      "A time-bounded inventory may omit undiscovered files and manifests; inventory.complete reports this explicitly.",
      "File and byte limits are evaluated against in-scope candidate source after deterministic discovery.",
      selection ? "Package scope is an explicit static source subtree and does not prove workspace topology or runtime behavior." : "Repository-wide discovery uses the configured static scope and does not prove runtime topology or behavior.",
    ],
  };
  if (options.includeAnalysisPlan === true) {
    Object.defineProperty(result, "analysisPlan", {
      value: immutablePlan(root, result.inventory.fingerprint, analysisFiles, controlFileEntries, directories.sort((left, right) => left.localeCompare(right)), controlDirectories, selection ? {
        kind: "static-package-path",
        path: selection.path,
        manifest: selection.manifest,
        packageName: selection.name,
      } : null),
      enumerable: false,
    });
  }
  return result;
}

module.exports = {
  DISCOVERY_SCHEMA,
  RepositoryDiscoveryError,
  discoverRepository,
  planSignature,
  verifyAnalysisPlan,
};
