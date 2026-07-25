"use strict";

const fs = require("node:fs");
const path = require("node:path");

const NPM_PUBLICATION_APPROVAL_SCHEMA = "flowpeek-npm-publication-approval/v1";

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length) throw new Error(`${field} contains unknown fields: ${unknown.join(", ")}.`);
}

function loadNpmPublicationApproval(file) {
  const approval = JSON.parse(fs.readFileSync(file, "utf8"));
  exactKeys(approval, ["schemaVersion", "status", "packageName", "version", "distTag"], "npm publication approval");
  if (approval.schemaVersion !== NPM_PUBLICATION_APPROVAL_SCHEMA) throw new Error(`npm publication approval must use ${NPM_PUBLICATION_APPROVAL_SCHEMA}.`);
  if (!['not-approved', 'approved'].includes(approval.status)) throw new Error("npm publication approval status must be not-approved or approved.");
  for (const field of ["packageName", "version", "distTag"]) {
    if (typeof approval[field] !== "string" || !approval[field].trim()) throw new Error(`npm publication approval ${field} must be a non-empty string.`);
  }
  return approval;
}

function assertNpmPublicationApproved(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const approval = loadNpmPublicationApproval(path.join(root, "packaging", "npm-publication-approval.json"));
  if (approval.status !== "approved") throw new Error("npm publication is not approved; set the exact approval record only after the owner release decision.");
  if (packageJson.private !== false) throw new Error("npm publication requires package.json private to be false.");
  if (packageJson.name !== approval.packageName || packageJson.version !== approval.version) throw new Error("npm publication approval does not match the package identity.");
  if (packageJson.publishConfig?.tag !== approval.distTag || packageJson.publishConfig?.access !== "public") throw new Error("npm publication approval does not match the declared public dist-tag configuration.");
  return approval;
}

module.exports = { NPM_PUBLICATION_APPROVAL_SCHEMA, loadNpmPublicationApproval, assertNpmPublicationApproved };
