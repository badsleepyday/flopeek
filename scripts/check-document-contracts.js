"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];
const requireMatch = (text, pattern, label) => { if (!pattern.test(text)) failures.push(`Missing ${label}.`); };
const rejectMatch = (text, pattern, label) => { if (pattern.test(text)) failures.push(`Stale ${label}.`); };

const packageJson = JSON.parse(read("package.json"));
const policy = JSON.parse(read("packaging/public-repository-policy.json"));
const workflow = read(".github/workflows/public-snapshot.yml");
const support = read("SUPPORT.md");
const roadmap = read("ROADMAP.md");
const publicGuide = read("docs/public-private-repositories.md");

if (packageJson.license !== "Apache-2.0") failures.push("package.json must declare Apache-2.0.");
if (!fs.existsSync(path.join(root, "LICENSE"))) failures.push("LICENSE must exist.");
if (!policy.requiredPaths.includes("LICENSE")) failures.push("Public repository policy must require LICENSE.");
requireMatch(workflow, /GITHUB_REF_NAME}" != "master"/, "private master stable-release guard");
requireMatch(workflow, /base_branch="main"/, "public main stable target");
requireMatch(publicGuide, /`badsleepyday\/flowpeek` public destination/, "configured public destination");
requireMatch(publicGuide, /private `master`/, "private master documentation");
rejectMatch(`${support}\n${roadmap}\n${publicGuide}`, /blocked by (?:the )?missing license|no selected license|no license has been selected/i, "missing-license claim");
requireMatch(support, /fixture gate reports 40\/40 expected relationships/, "current fixture corpus total");

if (failures.length) {
  process.stderr.write(`Document contract check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Document contracts are current.\n");
