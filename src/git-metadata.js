"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function gitMarker(start) {
  let current = path.resolve(start);
  while (true) {
    const marker = path.join(current, ".git");
    if (fs.existsSync(marker)) return marker;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function gitDirectory(start) {
  const marker = gitMarker(start);
  if (!marker) return null;
  const stat = fs.statSync(marker);
  if (stat.isDirectory()) return marker;
  if (!stat.isFile()) return null;
  const declaration = fs.readFileSync(marker, "utf8").trim();
  const prefix = "gitdir:";
  if (!declaration.toLowerCase().startsWith(prefix)) return null;
  const declared = declaration.slice(prefix.length).trim();
  return declared ? path.resolve(path.dirname(marker), declared) : null;
}

function commonGitDirectory(start) {
  const directory = gitDirectory(start);
  if (!directory) return null;
  const commonFile = path.join(directory, "commondir");
  if (!fs.existsSync(commonFile)) return directory;
  const declared = fs.readFileSync(commonFile, "utf8").trim();
  return declared ? path.resolve(directory, declared) : directory;
}

function unquoteConfigValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).split('\\"').join('"').split("\\\\").join("\\");
  }
  return trimmed;
}

function readOriginRemote(start) {
  const common = commonGitDirectory(start);
  if (!common) return null;
  const configPath = path.join(common, "config");
  if (!fs.existsSync(configPath)) return null;
  let inOrigin = false;
  for (const rawLine of fs.readFileSync(configPath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inOrigin = line.toLowerCase() === '[remote "origin"]';
      continue;
    }
    if (!inOrigin) continue;
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== "url") continue;
    return unquoteConfigValue(line.slice(separator + 1)) || null;
  }
  return null;
}

function parsePorcelainV2(output) {
  let revision = null;
  let branch = "detached";
  let dirty = false;
  for (const rawLine of String(output || "").split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      revision = value && value !== "(initial)" ? value : null;
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value && value !== "(detached)" ? value : "detached";
    } else if (!line.startsWith("# ")) dirty = true;
  }
  return { branch, revision, dirty };
}

function notRepositoryMetadata() {
  return {
    branch: "not-a-git-repository",
    revision: null,
    shallow: null,
    dirty: null,
    availability: "not-a-repository",
    reason: "Git metadata is unavailable because this directory is not a readable Git repository.",
  };
}

function readGitMetadata(root) {
  // `git -C <root> status` walks parent directories before reporting this
  // same result. Avoid spawning a synchronous process for every scan when
  // neither the root nor an ancestor has a Git marker; gitMarker follows the
  // same discovery boundary and also supports worktree marker files.
  if (!gitMarker(root)) return notRepositoryMetadata();
  try {
    const output = execFileSync("git", ["-C", root, "status", "--porcelain=v2", "--branch"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const parsed = parsePorcelainV2(output);
    const common = commonGitDirectory(root);
    return {
      ...parsed,
      shallow: common ? fs.existsSync(path.join(common, "shallow")) : null,
      availability: "available",
      reason: null,
    };
  } catch (error) {
    const detail = String(error.stderr || error.message || "");
    if (detail.toLowerCase().includes("dubious ownership") || detail.toLowerCase().includes("safe.directory")) {
      return { branch: "git-metadata-unavailable", revision: null, shallow: null, dirty: null, availability: "unavailable", reason: "Git metadata is unavailable because the repository is not trusted by the current Git safe-directory policy." };
    }
    return notRepositoryMetadata();
  }
}

module.exports = {
  commonGitDirectory,
  gitDirectory,
  parsePorcelainV2,
  readGitMetadata,
  readOriginRemote,
};
