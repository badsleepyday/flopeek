"use strict";

const fs = require("fs");
const path = require("path");
const { getAdapterRegistry } = require("../src/adapter-registry");

const root = path.resolve(__dirname, "..");
const supportPath = path.join(root, "SUPPORT.md");
const start = "<!-- GENERATED:ADAPTER-CAPABILITIES:START -->";
const end = "<!-- GENERATED:ADAPTER-CAPABILITIES:END -->";
const check = process.argv.includes("--check");
const registry = getAdapterRegistry();
const cell = (value) => String(value).replaceAll("|", "\\|");
const level = (adapter, key) => adapter.capabilities[key];
const block = [
  start,
  "",
  "## Generated adapter capability registry",
  "",
  `Registry schema: \`${registry.schema}\`. This table is generated from \`src/adapter-registry.js\`; repository parse coverage remains separate in graph analysis.`,
  "",
  "| Adapter | Languages/extensions | Parser | Availability | Structure | Imports | Direct calls | Required toolchain |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...registry.adapters.map((adapter) => `| ${cell(adapter.id)} | ${cell(`${adapter.languages.join(", ")} / ${adapter.extensions.join(" ")}`)} | ${cell(adapter.parser)} | ${cell(adapter.availability)} | ${level(adapter, "structure")} | ${level(adapter, "imports")} | ${level(adapter, "directCalls")} | ${cell(adapter.requiredToolchain || "None")} |`),
  "",
  "The registry describes proven static parser capabilities, not runtime execution, relationship recall outside audited slices, dynamic dispatch, dependency injection, reflection, or target configuration execution.",
  "",
  end,
].join("\n");
const source = fs.readFileSync(supportPath, "utf8");
if (!source.includes(start) || !source.includes(end)) throw new Error("SUPPORT.md is missing adapter capability generated block markers.");
const next = source.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
if (check) {
  if (next !== source) throw new Error("Generated SUPPORT.md is stale. Run npm run generate:support.");
  process.stdout.write("SUPPORT.md generated capability block is current.\n");
} else {
  fs.writeFileSync(supportPath, next);
  process.stdout.write("Generated SUPPORT.md adapter capability block.\n");
}
