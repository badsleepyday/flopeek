"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");

test("portable Flopeek tool skill preserves the evidence-first agent contract", () => {
  const skillRoot = path.join(root, "integrations", "skills", "flopeek");
  const source = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const metadata = fs.readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(source, /^---\r?\nname: flopeek\r?\n/);
  assert.equal(source.includes("TODO"), false);
  assert.match(source, /get_agent_bootstrap/);
  assert.match(source, /refresh_graph/);
  assert.match(source, /source fallback/i);
  assert.match(source, /Do not infer runtime order/);
  assert.match(source, /Flopeek does not expose repository-source writes/);
  assert.match(metadata, /\$flopeek/);
  for (const forbidden of ["Azka", "Bono", "Cuna", "Dana", "Fara"]) assert.equal(source.includes(forbidden), false);
});
