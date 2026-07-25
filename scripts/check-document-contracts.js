"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];
const requireMatch = (text, pattern, label) => { if (!pattern.test(text)) failures.push(`Missing ${label}.`); };
const rejectMatch = (text, pattern, label) => { if (pattern.test(text)) failures.push(`Stale ${label}.`); };

const packageJson = JSON.parse(read("package.json"));
const support = read("SUPPORT.md");
const roadmap = read("ROADMAP.md");
const architecture = read("ARCHITECTURE.md");
const releasing = read("RELEASING.md");

if (packageJson.license !== "Apache-2.0") failures.push("package.json must declare Apache-2.0.");
if (!fs.existsSync(path.join(root, "LICENSE"))) failures.push("LICENSE must exist.");
requireMatch(releasing, /`main` is the only long-lived public source branch/, "public main release contract");
requireMatch(releasing, /Private overlay boundary/, "private overlay release boundary");
requireMatch(support, /The public `main` branch is the canonical Flowpeek Core source/, "canonical public Core support statement");
requireMatch(architecture, /Public Core releases are created from immutable tags on `main`/, "tagged public Core architecture statement");
rejectMatch(`${support}\n${roadmap}\n${architecture}`, /private development source of truth|private-development to public-source projection|public repository creation, visibility change/i, "retired private-to-public source model");
rejectMatch(`${support}\n${roadmap}\n${architecture}`, /export:public-repository|audit:public-repository|public-snapshot\.yml/, "retired public snapshot tooling");
requireMatch(support, /fixture gate reports 40\/40 expected relationships/, "current fixture corpus total");

if (failures.length) {
  process.stderr.write(`Document contract check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Document contracts are current.\n");
