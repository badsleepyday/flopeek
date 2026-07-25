"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_POLICY_SCHEMA = "flopeek-package-policy/v2";
const PACKAGE_AUDIT_SCHEMA = "flopeek-package-audit/v1";

class PackagePolicyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "PackagePolicyError";
    this.code = code;
    this.details = details;
  }
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PackagePolicyError("invalid-object", `${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length) throw new PackagePolicyError("unknown-field", `${field} contains unknown fields: ${unknown.join(", ")}.`);
}

function portablePath(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new PackagePolicyError("invalid-path", `${field} must be a non-empty portable path.`);
  const normalized = value.trim().split("\\").join("/").replace(/^\.\//u, "");
  const parts = normalized.split("/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || parts.includes("") || parts.includes(".") || parts.includes("..")) throw new PackagePolicyError("unsafe-path", `${field} must be a normalized repository-relative path.`);
  return normalized;
}

function uniqueTextList(value, field, parser = (item, itemField) => portablePath(item, itemField)) {
  if (!Array.isArray(value)) throw new PackagePolicyError("invalid-list", `${field} must be an array.`);
  const normalized = value.map((item, index) => parser(item, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new PackagePolicyError("duplicate-list-item", `${field} must not contain duplicate items.`);
  return normalized;
}

function validatePolicy(input) {
  exactKeys(input, ["schemaVersion", "package", "allowedExactPaths", "allowedDirectories", "requiredPaths", "deniedPathSegments", "deniedBasenames", "deniedBasenamePrefixes", "deniedSuffixes", "maximumEntries", "maximumUnpackedBytes"], "policy");
  if (input.schemaVersion !== PACKAGE_POLICY_SCHEMA) throw new PackagePolicyError("invalid-schema", `policy.schemaVersion must be ${PACKAGE_POLICY_SCHEMA}.`);
  exactKeys(input.package, ["name", "publication", "bin", "minimumNodeMajor"], "policy.package");
  if (input.package.name !== "flopeek") throw new PackagePolicyError("invalid-package-name", "policy.package.name must be flopeek.");
  exactKeys(input.package.publication, ["state", "distTag", "approvalFile"], "policy.package.publication");
  if (input.package.publication.state !== "prepared") throw new PackagePolicyError("unsafe-release-policy", "The package publication state must remain prepared until a separate release approval.");
  if (input.package.publication.distTag !== "beta") throw new PackagePolicyError("unsafe-release-policy", "The prepared package must use the beta dist-tag.");
  if (!Number.isSafeInteger(input.package.minimumNodeMajor) || input.package.minimumNodeMajor < 20) throw new PackagePolicyError("invalid-node-version", "policy.package.minimumNodeMajor must be an integer of at least 20.");
  if (!Number.isSafeInteger(input.maximumEntries) || input.maximumEntries < 1) throw new PackagePolicyError("invalid-entry-limit", "policy.maximumEntries must be a positive integer.");
  if (!Number.isSafeInteger(input.maximumUnpackedBytes) || input.maximumUnpackedBytes < 1) throw new PackagePolicyError("invalid-size-limit", "policy.maximumUnpackedBytes must be a positive integer.");
  const simpleText = (item, field) => {
    if (typeof item !== "string" || !item.trim() || item.includes("/") || item.includes("\\") || item.includes("\0")) throw new PackagePolicyError("invalid-text", `${field} must be a single path segment.`);
    return item.trim();
  };
  const suffix = (item, field) => {
    const text = simpleText(item, field);
    if (!text.startsWith(".")) throw new PackagePolicyError("invalid-suffix", `${field} must start with a period.`);
    return text.toLowerCase();
  };
  return {
    schemaVersion: PACKAGE_POLICY_SCHEMA,
    package: {
      ...input.package,
      publication: { ...input.package.publication, approvalFile: portablePath(input.package.publication.approvalFile, "policy.package.publication.approvalFile") },
      bin: portablePath(input.package.bin, "policy.package.bin"),
    },
    allowedExactPaths: uniqueTextList(input.allowedExactPaths, "policy.allowedExactPaths"),
    allowedDirectories: uniqueTextList(input.allowedDirectories, "policy.allowedDirectories"),
    requiredPaths: uniqueTextList(input.requiredPaths, "policy.requiredPaths"),
    deniedPathSegments: uniqueTextList(input.deniedPathSegments, "policy.deniedPathSegments", simpleText),
    deniedBasenames: uniqueTextList(input.deniedBasenames, "policy.deniedBasenames", simpleText),
    deniedBasenamePrefixes: uniqueTextList(input.deniedBasenamePrefixes, "policy.deniedBasenamePrefixes", simpleText).map((item) => item.toLowerCase()),
    deniedSuffixes: uniqueTextList(input.deniedSuffixes, "policy.deniedSuffixes", suffix),
    maximumEntries: input.maximumEntries,
    maximumUnpackedBytes: input.maximumUnpackedBytes,
  };
}

function loadPackagePolicy(file) {
  try { return validatePolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if (error instanceof PackagePolicyError) throw error;
    throw new PackagePolicyError("invalid-policy-file", `Unable to load package policy: ${error.message}`);
  }
}

function packagePathAllowed(file, policy) {
  return policy.allowedExactPaths.includes(file) || policy.allowedDirectories.some((directory) => file.startsWith(`${directory}/`));
}

function auditPackageFiles(packResult, policyInput, packageJson) {
  const policy = validatePolicy(policyInput);
  if (!packResult || typeof packResult !== "object" || !Array.isArray(packResult.files)) throw new PackagePolicyError("invalid-pack-result", "npm pack did not return a file inventory.");
  const files = packResult.files.map((item, index) => portablePath(item?.path, `pack.files[${index}].path`));
  const fileSet = new Set(files);
  const errors = [];
  if (new Set(files).size !== files.length) errors.push({ code: "duplicate-path", paths: files.filter((item, index) => files.indexOf(item) !== index) });
  const outsideAllowlist = files.filter((file) => !packagePathAllowed(file, policy));
  if (outsideAllowlist.length) errors.push({ code: "outside-allowlist", paths: outsideAllowlist });
  const deniedSegments = files.filter((file) => file.split("/").some((segment) => policy.deniedPathSegments.includes(segment)));
  if (deniedSegments.length) errors.push({ code: "denied-segment", paths: deniedSegments });
  const deniedBasenames = files.filter((file) => policy.deniedBasenames.includes(path.posix.basename(file)));
  if (deniedBasenames.length) errors.push({ code: "denied-basename", paths: deniedBasenames });
  const deniedBasenamePrefixes = files.filter((file) => policy.deniedBasenamePrefixes.some((item) => path.posix.basename(file).toLowerCase().startsWith(item)));
  if (deniedBasenamePrefixes.length) errors.push({ code: "denied-basename-prefix", paths: deniedBasenamePrefixes });
  const deniedSuffixes = files.filter((file) => policy.deniedSuffixes.some((item) => file.toLowerCase().endsWith(item)));
  if (deniedSuffixes.length) errors.push({ code: "denied-suffix", paths: deniedSuffixes });
  const missing = policy.requiredPaths.filter((file) => !fileSet.has(file));
  if (missing.length) errors.push({ code: "missing-required-path", paths: missing });
  if (files.length > policy.maximumEntries) errors.push({ code: "entry-limit-exceeded", actual: files.length, maximum: policy.maximumEntries });
  if (!Number.isSafeInteger(packResult.unpackedSize) || packResult.unpackedSize > policy.maximumUnpackedBytes) errors.push({ code: "unpacked-size-limit-exceeded", actual: packResult.unpackedSize ?? null, maximum: policy.maximumUnpackedBytes });
  if (packResult.name !== policy.package.name || packageJson.name !== policy.package.name) errors.push({ code: "package-name-mismatch", expected: policy.package.name });
  if (packResult.version !== packageJson.version) errors.push({ code: "package-version-mismatch", expected: packageJson.version, actual: packResult.version ?? null });
  if (packageJson.private !== false) errors.push({ code: "release-publication-metadata", expectedPrivate: false, actualPrivate: packageJson.private ?? null });
  if (packageJson.publishConfig?.access !== "public" || packageJson.publishConfig?.tag !== policy.package.publication.distTag) {
    errors.push({ code: "release-publication-metadata", expectedAccess: "public", expectedDistTag: policy.package.publication.distTag });
  }
  if (packageJson.scripts?.prepublishOnly !== "npm run verify:npm-publication") errors.push({ code: "release-approval-boundary", expectedScript: "npm run verify:npm-publication" });
  if (packageJson.bin?.flopeek !== policy.package.bin) errors.push({ code: "binary-path-mismatch", expected: policy.package.bin, actual: packageJson.bin?.flopeek ?? null });
  const declaredNode = Number(String(packageJson.engines?.node || "").match(/\d+/u)?.[0]);
  if (!Number.isSafeInteger(declaredNode) || declaredNode < policy.package.minimumNodeMajor) errors.push({ code: "node-engine-mismatch", minimum: policy.package.minimumNodeMajor, actual: packageJson.engines?.node ?? null });
  return {
    schemaVersion: PACKAGE_AUDIT_SCHEMA,
    status: errors.length ? "failed" : "passed",
    package: {
      name: packResult.name,
      version: packResult.version,
      private: packageJson.private === true,
      filename: path.basename(String(packResult.filename || `${packResult.name}-${packResult.version}.tgz`)),
      packedBytes: Number.isSafeInteger(packResult.size) ? packResult.size : null,
      unpackedBytes: Number.isSafeInteger(packResult.unpackedSize) ? packResult.unpackedSize : null,
      entries: files.length,
    },
    policy: {
      schemaVersion: policy.schemaVersion,
      maximumEntries: policy.maximumEntries,
      maximumUnpackedBytes: policy.maximumUnpackedBytes,
      requiredPaths: policy.requiredPaths.length,
      releasePublishingApproved: false,
      publicationState: policy.package.publication.state,
      distTag: policy.package.publication.distTag,
    },
    checks: {
      allowlist: outsideAllowlist.length === 0,
      deniedContent: deniedSegments.length + deniedBasenames.length + deniedBasenamePrefixes.length + deniedSuffixes.length === 0,
      requiredRuntime: missing.length === 0,
      boundedSize: files.length <= policy.maximumEntries && Number.isSafeInteger(packResult.unpackedSize) && packResult.unpackedSize <= policy.maximumUnpackedBytes,
      packageIdentity: packResult.name === policy.package.name && packageJson.name === policy.package.name && packResult.version === packageJson.version,
      releaseBoundary: packageJson.private === false && packageJson.publishConfig?.access === "public" && packageJson.publishConfig?.tag === policy.package.publication.distTag && packageJson.scripts?.prepublishOnly === "npm run verify:npm-publication",
    },
    errors,
    limitations: [
      "The inventory proves only the npm tarball file list and declared package metadata.",
      "It does not prove installation, command behavior, parser accuracy, runtime correctness, release readiness, or publication permission.",
    ],
  };
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmInvocation() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  return cli ? { command: process.execPath, prefixArgs: [cli] } : { command: npmExecutable(), prefixArgs: [] };
}

function parsePackOutput(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || "")); }
  catch (error) { throw new PackagePolicyError("invalid-pack-output", `npm pack did not return JSON: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new PackagePolicyError("invalid-pack-output", "npm pack must return exactly one package result.");
  return parsed[0];
}

function runPackageAudit(root, options = {}) {
  const repository = fs.realpathSync(root);
  const policyPath = path.resolve(options.policyPath || path.join(repository, "packaging", "package-policy.json"));
  const policy = loadPackagePolicy(policyPath);
  const packageJson = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
  const args = ["pack", "--json"];
  if (options.dryRun !== false) args.push("--dry-run");
  if (options.packDestination) args.push("--pack-destination", path.resolve(options.packDestination));
  const npm = npmInvocation();
  const result = spawnSync(npm.command, [...npm.prefixArgs, ...args], { cwd: repository, encoding: "utf8", timeout: options.timeoutMilliseconds || 120_000, windowsHide: true });
  if (result.error) throw new PackagePolicyError("pack-command-failed", `Unable to start npm pack: ${result.error.message}`);
  if (result.status !== 0) throw new PackagePolicyError("pack-command-failed", `npm pack failed with exit code ${result.status}.`, { stderr: String(result.stderr || "").slice(0, 2000) });
  const packResult = parsePackOutput(result.stdout);
  return { report: auditPackageFiles(packResult, policy, packageJson), packResult, policy, packageJson, warningsPresent: Boolean(String(result.stderr || "").trim()) };
}

module.exports = {
  PACKAGE_AUDIT_SCHEMA,
  PACKAGE_POLICY_SCHEMA,
  PackagePolicyError,
  auditPackageFiles,
  loadPackagePolicy,
  npmExecutable,
  npmInvocation,
  parsePackOutput,
  runPackageAudit,
  validatePolicy,
};
