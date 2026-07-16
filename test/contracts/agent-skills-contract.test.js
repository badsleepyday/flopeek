"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const roles = [
  ["azka-flow-review", "Azka"],
  ["bono-implementation-review", "Bono"],
  ["cuna-system-flow-review", "Cuna"],
  ["dana-documentation-review", "Dana"],
  ["elda-release-review", "Elda"],
  ["fara-brainstorming", "Fara"],
  ["gama-research-development", "Gama"],
  ["hadi-automated-qa", "Hadi"],
  ["iris-manual-qa", "Iris"],
];

test("portable agent skills retain explicit routing, safe prompts, and artifact contracts", () => {
  const agentInstructions = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  for (const [skill, reviewer] of roles) {
    const skillRoot = path.join(root, ".agents", "skills", skill);
    const source = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const metadata = fs.readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
    assert.ok(source.startsWith("---\n") || source.startsWith("---\r\n"));
    assert.ok(source.includes(`name: ${skill}`));
    assert.ok(source.includes("description:"));
    assert.equal(source.includes("TODO"), false);
    assert.ok(source.split(/\r?\n/).length < 500);
    assert.ok(metadata.includes(`$${skill}`));
    assert.ok(metadata.includes("allow_implicit_invocation: false"));
    assert.ok(agentInstructions.includes(`| ${reviewer} | \`$${skill}\``));
  }

  const reviewSchema = JSON.parse(fs.readFileSync(path.join(root, "docs", "schemas", "flowpeek-independent-review.schema.json"), "utf8"));
  const specialistSchema = JSON.parse(fs.readFileSync(path.join(root, "docs", "schemas", "flowpeek-specialist-work-product.schema.json"), "utf8"));
  assert.equal(reviewSchema.properties.schemaVersion.const, "flowpeek-independent-review/v1");
  assert.ok(reviewSchema.properties.reviewer.properties.name.enum.includes("Hadi"));
  assert.ok(reviewSchema.properties.reviewer.properties.name.enum.includes("Iris"));
  assert.equal(specialistSchema.properties.schemaVersion.const, "flowpeek-specialist-work-product/v1");
  assert.deepEqual(specialistSchema.properties.specialist.properties.name.enum, ["Fara", "Gama"]);
  assert.match(agentInstructions, /same subject/);
  assert.match(agentInstructions, /next name starts with `J`/);
  const fara = fs.readFileSync(path.join(root, ".agents", "skills", "fara-brainstorming", "SKILL.md"), "utf8");
  assert.match(fara, /Role-gap discovery/);
  assert.match(fara, /next unused alphabetic initial/);
  assert.match(fara, /low-relevance, speculative, one-off/);

  const adoption = JSON.parse(fs.readFileSync(path.join(root, ".agent-team", "upstream.json"), "utf8"));
  assert.equal(adoption.schemaVersion, "portable-sdlc-agent-team/adoption/v1");
  assert.equal(adoption.adoptionMode, "project-specialized-adapter");
  assert.equal(adoption.roleMappings.length, roles.length);
  assert.deepEqual(adoption.roleMappings.map((mapping) => mapping.name), roles.map(([, reviewer]) => reviewer));
  for (const mapping of adoption.roleMappings) {
    assert.ok(roles.some(([skill, reviewer]) => reviewer === mapping.name && skill === mapping.projectSkill));
  }
  const adoptionDoc = fs.readFileSync(path.join(root, "docs", "portable-agent-team.md"), "utf8");
  assert.match(adoptionDoc, /project-specific adopter/);
  assert.match(adoptionDoc, /does not depend on a mutable global installation/);
});
