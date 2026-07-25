const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atomicWriteJson } = require("./graph-cache");
const { readOriginRemote } = require("./git-metadata");

const PROJECT_IDENTITY_SCHEMA_VERSION = 1;
const PROJECT_IDENTITY_FILENAME = ".flopeek/project.json";

class ProjectIdentityError extends Error {
  constructor(message) {
    super(`Invalid Flopeek project identity metadata: ${message}`);
    this.name = "ProjectIdentityError";
    this.code = "FLOPEEK_INVALID_PROJECT_IDENTITY";
  }
}

function projectIdentityPath(root) {
  return path.join(root, PROJECT_IDENTITY_FILENAME);
}

function validateProjectRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new ProjectIdentityError("project.json must contain an object.");
  if (record.schemaVersion !== PROJECT_IDENTITY_SCHEMA_VERSION) throw new ProjectIdentityError(`schemaVersion must be ${PROJECT_IDENTITY_SCHEMA_VERSION}.`);
  if (typeof record.projectId !== "string" || !record.projectId) throw new ProjectIdentityError("projectId must be a non-empty string.");
  if (record.source !== "generated") throw new ProjectIdentityError("source must be generated.");
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) throw new ProjectIdentityError("createdAt must be an ISO-8601 timestamp.");
  if (record.originRemote !== null && typeof record.originRemote !== "string") throw new ProjectIdentityError("originRemote must be a string or null.");
  return record;
}

function resolveProjectIdentity(root, configuredId = null, options = {}) {
  const currentRemote = options.originRemote === undefined ? readOriginRemote(root) : options.originRemote;
  if (configuredId) {
    return {
      projectId: configuredId,
      source: "configured",
      status: "configured",
      originRemote: currentRemote,
      limitation: "An explicit projectId takes precedence. Copy and fork relationships are not inferred from source code or Git history.",
    };
  }
  const target = projectIdentityPath(root);
  if (!fs.existsSync(target)) {
    const record = {
      schemaVersion: PROJECT_IDENTITY_SCHEMA_VERSION,
      projectId: `project:${randomUUID()}`,
      source: "generated",
      createdAt: new Date().toISOString(),
      originRemote: currentRemote,
    };
    if (options.persist === false) {
      return {
        projectId: record.projectId,
        source: "ephemeral",
        status: "ephemeral",
        originRemote: currentRemote,
        limitation: "This read-only scan does not persist project identity. Its generated ID is valid only for this scan and cannot be used as durable context.",
      };
    }
    atomicWriteJson(target, record);
    return {
      projectId: record.projectId,
      source: "generated",
      status: "created",
      originRemote: currentRemote,
      limitation: "The generated ID persists with .flopeek/project.json. A copied directory can retain the same ID and is not automatically distinguished without an explicit projectId.",
    };
  }
  let record;
  try {
    record = validateProjectRecord(JSON.parse(fs.readFileSync(target, "utf8")));
  } catch (error) {
    if (error instanceof ProjectIdentityError) throw error;
    throw new ProjectIdentityError(`project.json is not valid JSON (${error.message}).`);
  }
  return {
    projectId: record.projectId,
    source: "generated",
    status: record.originRemote && currentRemote && record.originRemote !== currentRemote ? "remote-mismatch" : "persistent",
    originRemote: currentRemote,
    limitation: record.originRemote && currentRemote && record.originRemote !== currentRemote
      ? "The persisted ID was created with a different origin remote. Treat this repository as a copy-or-fork candidate until a person confirms or configures projectId."
      : "A copied directory can retain the same generated ID and is not automatically distinguished without an explicit projectId.",
  };
}

module.exports = {
  PROJECT_IDENTITY_FILENAME,
  PROJECT_IDENTITY_SCHEMA_VERSION,
  ProjectIdentityError,
  projectIdentityPath,
  resolveProjectIdentity,
  validateProjectRecord,
};
