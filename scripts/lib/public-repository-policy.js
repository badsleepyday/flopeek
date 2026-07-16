"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readRepositoryScope } = require("../../src/scope");

const POLICY_SCHEMA = "flowpeek-public-repository-policy/v1";
const AUDIT_SCHEMA = "flowpeek-public-repository-audit/v1";

class PublicRepositoryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PublicRepositoryError";
    this.code = code;
    this.details = details;
  }
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicRepositoryError("invalid-object", `${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length) throw new PublicRepositoryError("unknown-field", `${field} contains unknown fields: ${unknown.join(", ")}.`);
}

function portablePath(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new PublicRepositoryError("invalid-path", `${field} must be a non-empty portable path.`);
  const normalized = value.trim().split("\\").join("/").replace(/^\.\//u, "");
  const parts = normalized.split("/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || parts.some((part) => !part || part === "." || part === "..")) throw new PublicRepositoryError("unsafe-path", `${field} must be repository-relative.`);
  return normalized;
}

function uniqueList(value, field, parser = portablePath) {
  if (!Array.isArray(value)) throw new PublicRepositoryError("invalid-list", `${field} must be an array.`);
  const normalized = value.map((item, index) => parser(item, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new PublicRepositoryError("duplicate-list-item", `${field} must not contain duplicates.`);
  return normalized;
}

function simpleSegment(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new PublicRepositoryError("invalid-segment", `${field} must be one path segment.`);
  return value.trim();
}

function validatePolicy(input) {
  exactKeys(input, ["schemaVersion", "sourceRepository", "overlays", "allowedExactPaths", "allowedDirectories", "requiredPaths", "deniedPathSegments", "deniedBasenames", "deniedBasenamePrefixes", "deniedSuffixes", "maximumEntries", "maximumBytes", "releaseReadiness"], "policy");
  if (input.schemaVersion !== POLICY_SCHEMA) throw new PublicRepositoryError("invalid-schema", `policy.schemaVersion must be ${POLICY_SCHEMA}.`);
  exactKeys(input.sourceRepository, ["classification", "cleanWorktreeRequiredForExport", "copyGitHistory"], "policy.sourceRepository");
  if (input.sourceRepository.classification !== "private-development" || input.sourceRepository.cleanWorktreeRequiredForExport !== true || input.sourceRepository.copyGitHistory !== false) throw new PublicRepositoryError("unsafe-source-boundary", "The source must remain private-development, require a clean export, and never copy Git history.");
  exactKeys(input.releaseReadiness, ["licenseFileRequired", "packageLicenseRequired", "packagePrivateMustBeFalse", "securityPolicyRequired", "changelogRequired", "contributingGuideRequired", "ownerApprovalRequired"], "policy.releaseReadiness");
  if (Object.values(input.releaseReadiness).some((value) => value !== true)) throw new PublicRepositoryError("unsafe-release-boundary", "Every public release readiness gate must remain enabled.");
  if (!Number.isSafeInteger(input.maximumEntries) || input.maximumEntries < 1) throw new PublicRepositoryError("invalid-entry-limit", "policy.maximumEntries must be positive.");
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) throw new PublicRepositoryError("invalid-byte-limit", "policy.maximumBytes must be positive.");
  if (!Array.isArray(input.overlays)) throw new PublicRepositoryError("invalid-overlays", "policy.overlays must be an array.");
  const overlays = input.overlays.map((overlay, index) => {
    exactKeys(overlay, ["source", "destination"], `policy.overlays[${index}]`);
    const source = portablePath(overlay.source, `policy.overlays[${index}].source`);
    const destination = portablePath(overlay.destination, `policy.overlays[${index}].destination`);
    if (source === destination) throw new PublicRepositoryError("invalid-overlay", `policy.overlays[${index}] must map two different paths.`);
    return { source, destination };
  });
  if (new Set(overlays.map((item) => item.destination)).size !== overlays.length) throw new PublicRepositoryError("duplicate-overlay-destination", "Overlay destinations must be unique.");
  const allowedExactPaths = uniqueList(input.allowedExactPaths, "policy.allowedExactPaths");
  const allowedDirectories = uniqueList(input.allowedDirectories, "policy.allowedDirectories");
  const destinationAllowed = (destination) => allowedExactPaths.includes(destination) || allowedDirectories.some((directory) => destination.startsWith(`${directory}/`));
  if (overlays.some((overlay) => !destinationAllowed(overlay.destination))) throw new PublicRepositoryError("overlay-outside-allowlist", "Every overlay destination must be explicitly allowed.");
  return {
    ...input,
    overlays,
    allowedExactPaths,
    allowedDirectories,
    requiredPaths: uniqueList(input.requiredPaths, "policy.requiredPaths"),
    deniedPathSegments: uniqueList(input.deniedPathSegments, "policy.deniedPathSegments", simpleSegment),
    deniedBasenames: uniqueList(input.deniedBasenames, "policy.deniedBasenames", simpleSegment),
    deniedBasenamePrefixes: uniqueList(input.deniedBasenamePrefixes, "policy.deniedBasenamePrefixes", simpleSegment).map((item) => item.toLowerCase()),
    deniedSuffixes: uniqueList(input.deniedSuffixes, "policy.deniedSuffixes", simpleSegment).map((item) => item.toLowerCase()),
  };
}

function loadPolicy(file) {
  try { return validatePolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if (error instanceof PublicRepositoryError) throw error;
    throw new PublicRepositoryError("invalid-policy-file", `Unable to load public repository policy: ${error.message}`);
  }
}

function pathAllowed(file, policy) {
  return policy.allowedExactPaths.includes(file) || policy.allowedDirectories.some((directory) => file.startsWith(`${directory}/`));
}

function git(root, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: root, encoding, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new PublicRepositoryError("git-command-failed", `git ${args.join(" ")} failed.`, { status: result.status, stderr: String(result.stderr || "").slice(0, 1000) });
  return result.stdout;
}

function repositoryInventory(root) {
  const repository = fs.realpathSync(root);
  const tracked = String(git(repository, ["ls-files", "-z"])).split("\0").filter(Boolean).map((file, index) => portablePath(file, `tracked[${index}]`));
  const status = String(git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]));
  const revision = String(git(repository, ["rev-parse", "HEAD"])).trim();
  return { repository, tracked, clean: status.trim() === "", revision };
}

function selectPublicFiles(tracked, policy) {
  return selectPublicEntries(tracked, policy).map((entry) => entry.destination);
}

function selectPublicEntries(tracked, policy) {
  const trackedSet = new Set(tracked);
  const overlaySources = new Set(policy.overlays.map((overlay) => overlay.source));
  const overlayDestinations = new Set(policy.overlays.map((overlay) => overlay.destination));
  const direct = tracked
    .filter((file) => pathAllowed(file, policy) && !overlaySources.has(file) && !overlayDestinations.has(file))
    .map((file) => ({ source: file, destination: file }));
  const overlays = policy.overlays
    .filter((overlay) => trackedSet.has(overlay.source))
    .map((overlay) => ({ ...overlay }));
  return [...direct, ...overlays].sort((left, right) => left.destination.localeCompare(right.destination));
}

function deniedReasons(files, policy) {
  const results = [];
  for (const file of files) {
    const parts = file.split("/");
    const basename = path.posix.basename(file);
    if (parts.some((part) => policy.deniedPathSegments.includes(part))) results.push({ code: "denied-segment", path: file });
    if (policy.deniedBasenames.includes(basename)) results.push({ code: "denied-basename", path: file });
    if (policy.deniedBasenamePrefixes.some((prefix) => basename.toLowerCase().startsWith(prefix))) results.push({ code: "denied-basename-prefix", path: file });
    if (policy.deniedSuffixes.some((suffix) => file.toLowerCase().endsWith(suffix))) results.push({ code: "denied-suffix", path: file });
  }
  return results;
}

function licensePresent(files) {
  return files.some((file) => /^(?:license|licence)(?:\.[^/]+)?$/iu.test(file));
}

function auditPublicFiles(filesInput, policyInput, packageJson, options = {}) {
  const policy = validatePolicy(policyInput);
  const files = filesInput.map((file, index) => portablePath(file, `files[${index}]`));
  const fileSet = new Set(files);
  const errors = [];
  const outsideAllowlist = files.filter((file) => !pathAllowed(file, policy));
  if (outsideAllowlist.length) errors.push({ code: "outside-allowlist", paths: outsideAllowlist });
  const denied = deniedReasons(files, policy);
  if (denied.length) errors.push({ code: "denied-content", items: denied });
  const missing = policy.requiredPaths.filter((file) => !fileSet.has(file));
  if (missing.length) errors.push({ code: "missing-required-path", paths: missing });
  const totalBytes = Number.isSafeInteger(options.totalBytes) ? options.totalBytes : null;
  if (files.length > policy.maximumEntries) errors.push({ code: "entry-limit-exceeded", actual: files.length, maximum: policy.maximumEntries });
  if (totalBytes !== null && totalBytes > policy.maximumBytes) errors.push({ code: "byte-limit-exceeded", actual: totalBytes, maximum: policy.maximumBytes });
  const releaseBlockers = [];
  if (!licensePresent(files)) releaseBlockers.push("license-file-missing");
  if (typeof packageJson?.license !== "string" || !packageJson.license.trim()) releaseBlockers.push("package-license-missing");
  if (packageJson?.private !== false) releaseBlockers.push("package-private-boundary-active");
  if (!fileSet.has("SECURITY.md") && !fileSet.has(".github/SECURITY.md")) releaseBlockers.push("security-policy-missing");
  if (!fileSet.has("CHANGELOG.md")) releaseBlockers.push("changelog-missing");
  if (!fileSet.has("CONTRIBUTING.md")) releaseBlockers.push("contributing-guide-missing");
  if (options.sourceClean === false) releaseBlockers.push("source-worktree-dirty");
  return {
    schemaVersion: AUDIT_SCHEMA,
    structureStatus: errors.length ? "failed" : "passed",
    source: {
      classification: policy.sourceRepository.classification,
      revision: typeof options.revision === "string" && /^[0-9a-f]{40}$/u.test(options.revision) ? options.revision : null,
      clean: typeof options.sourceClean === "boolean" ? options.sourceClean : null,
    },
    candidate: {
      files: files.length,
      bytes: totalBytes,
      version: typeof packageJson?.version === "string" ? packageJson.version : null,
      containsGitHistory: false,
    },
    checks: {
      allowlist: outsideAllowlist.length === 0,
      deniedContent: denied.length === 0,
      requiredPaths: missing.length === 0,
      bounded: files.length <= policy.maximumEntries && (totalBytes === null || totalBytes <= policy.maximumBytes),
    },
    releaseReadiness: {
      technicalStatus: releaseBlockers.length ? "blocked" : "eligible-for-owner-review",
      blockers: releaseBlockers,
      ownerApprovalRequired: true,
      ownerApprovalRecorded: false,
      publicReleaseApproved: false,
    },
    errors,
    limitations: [
      "This audit validates a clean public tree candidate, not a public remote, branch protection, release, registry publication, or license choice.",
      "The exporter copies no private Git history; the public repository must maintain its own independent history.",
      "A passing structure audit never grants owner approval or changes package.json private state.",
    ],
  };
}

function candidateBytes(root, entries) {
  return entries.reduce((total, entry) => {
    const source = path.join(root, ...entry.source.split("/"));
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new PublicRepositoryError("unsupported-entry", `${entry.source} must be a regular file.`);
    return total + stat.size;
  }, 0);
}

function auditRepository(root, policyPath) {
  const inventory = repositoryInventory(root);
  const policy = loadPolicy(policyPath);
  if (policy.allowedExactPaths.includes(".flowpeek/config.json")) readRepositoryScope(inventory.repository);
  const entries = selectPublicEntries(inventory.tracked, policy);
  const files = entries.map((entry) => entry.destination);
  const packageJson = JSON.parse(fs.readFileSync(path.join(inventory.repository, "package.json"), "utf8"));
  const report = auditPublicFiles(files, policy, packageJson, { totalBytes: candidateBytes(inventory.repository, entries), sourceClean: inventory.clean, revision: inventory.revision });
  return { ...inventory, policy, entries, files, packageJson, report };
}

function outputPath(root, value) {
  if (!value) throw new PublicRepositoryError("missing-output", "--output is required.");
  const source = fs.realpathSync(root);
  const output = path.resolve(value);
  const insideSource = path.relative(source, output);
  const containsSource = path.relative(output, source);
  if (!insideSource.startsWith("..") || !containsSource.startsWith("..")) throw new PublicRepositoryError("unsafe-output", "The public candidate must be outside the private source repository.");
  if (fs.existsSync(output)) throw new PublicRepositoryError("output-exists", "The public candidate output must not already exist.");
  return output;
}

function exportPublicRepository(root, policyPath, outputValue) {
  const audit = auditRepository(root, policyPath);
  if (!audit.clean) throw new PublicRepositoryError("dirty-source", "Commit or discard every private-source change before exporting a public candidate.");
  if (audit.report.structureStatus !== "passed") throw new PublicRepositoryError("invalid-candidate", "The public candidate failed its structural audit.", audit.report.errors);
  const output = outputPath(audit.repository, outputValue);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), ".flowpeek-public-export-"));
  try {
    for (const entry of audit.entries) {
      const source = path.join(audit.repository, ...entry.source.split("/"));
      const destination = path.join(staging, ...entry.destination.split("/"));
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new PublicRepositoryError("unsupported-entry", `${entry.source} must be a regular non-symlink file.`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      try { fs.chmodSync(destination, stat.mode); } catch {}
    }
    fs.renameSync(staging, output);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { output, report: audit.report };
}

module.exports = {
  AUDIT_SCHEMA,
  POLICY_SCHEMA,
  PublicRepositoryError,
  auditPublicFiles,
  auditRepository,
  exportPublicRepository,
  loadPolicy,
  outputPath,
  pathAllowed,
  selectPublicFiles,
  selectPublicEntries,
  validatePolicy,
};
