"use strict";

const path = require("node:path");
const { frameworkRoute } = require("./framework-route");

const CONFIG_PREFIXES = new Set(["vite", "vitest", "tailwind", "postcss", "eslint", "prettier", "drizzle", "svelte", "playwright", "tsconfig", "jsconfig", "pgtyped"]);

function removeExtension(filePath) {
  const extension = path.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function pathParts(relativePath) {
  return String(relativePath).replace(/\\/g, "/").split("/");
}

function titleCase(value) {
  let result = "";
  let previousWasLower = false;
  for (const character of value) {
    const isSeparator = ".-_/@".includes(character);
    const isUpper = character >= "A" && character <= "Z";
    if (isSeparator) {
      if (result && !result.endsWith(" ")) result += " ";
    } else {
      if (isUpper && previousWasLower && !result.endsWith(" ")) result += " ";
      result += result.length === 0 || result.endsWith(" ") ? character.toUpperCase() : character;
    }
    previousWasLower = character >= "a" && character <= "z";
  }
  return result.trim();
}

function isTestPath(relativePath) {
  const parts = pathParts(relativePath).map((part) => part.toLowerCase());
  const stem = removeExtension(parts.at(-1) || "");
  return parts.includes("__tests__") || stem.includes(".test") || stem.includes(".spec") || stem.endsWith("_test");
}

function isConfigurationFile(relativePath) {
  const stem = removeExtension(path.basename(relativePath)).toLowerCase();
  const firstToken = stem.split(".")[0];
  return CONFIG_PREFIXES.has(firstToken) || stem === "tsconfig" || stem === "jsconfig";
}

function hasStemToken(stem, values) {
  return stem.split(".").some((token) => values.includes(token));
}

function classifyFile(relativePath) {
  const filename = path.basename(relativePath);
  const stem = removeExtension(filename).toLowerCase();
  const framework = frameworkRoute(relativePath);
  let type = "module";
  let label = titleCase(removeExtension(filename));
  let layer = "application";
  if (filename.toLowerCase().endsWith(".d.ts")) {
    type = "declaration";
    layer = "devtool";
  } else if (isTestPath(relativePath)) {
    type = "test";
    layer = "test";
  } else if (isConfigurationFile(relativePath)) {
    type = "config";
    layer = "devtool";
  } else if (framework) {
    type = framework.kind === "layout" ? "module" : "route";
    label = framework.kind === "layout" ? `Layout ${framework.route}` : `Route ${framework.route}`;
  } else if (hasStemToken(stem, ["route", "routes", "router"])) type = "route";
  else if (stem.includes("controller")) type = "controller";
  else if (stem.includes("service") || stem.includes("usecase") || stem.includes("handler")) type = "service";
  else if (stem.includes("repository") || stem.endsWith(".repo") || stem.includes("dao")) type = "repository";
  else if (stem.includes("entity") || stem.includes("model") || stem.includes("schema") || stem.includes("migration")) type = "database";
  else if (["queue", "worker", "consumer", "producer", "subscriber"].some((token) => stem.includes(token))) type = "queue";

  const responsibility = {
    route: "Application entry point detected from the file structure or AST.",
    controller: "Connects a transport request to application logic.",
    service: "Orchestrates application logic and related dependencies.",
    repository: "Accesses or persists application data.",
    database: "Defines data structure or data access.",
    queue: "Handles asynchronous work or events.",
    test: "Verifies application component behavior.",
    declaration: "Type declaration that is not part of the runtime application flow.",
    config: "Build, tooling, or project configuration.",
    module: "Code module that participates in the application graph.",
  }[type];
  return { type, label, layer, detectedResponsibility: responsibility };
}

function deriveDomain(relativePath) {
  const parts = pathParts(relativePath);
  const rootIndex = parts.findIndex((part) => ["src", "apps", "packages", "modules", "services"].includes(part));
  const candidate = rootIndex >= 0 ? parts[rootIndex + 1] : parts[0];
  // A source root can contain modules directly (for example `src/cli.js`).
  // The previous implementation promoted each filename into a separate
  // "domain", which made a root-level application look like dozens of
  // unrelated domains. A filename is not a source-containment domain.
  if (!candidate || path.extname(candidate)) return "Project";
  return !["index", "main", "app", "routes"].includes(removeExtension(candidate).toLowerCase()) ? titleCase(candidate) : "Project";
}

function deriveFeature(relativePath) {
  const parts = pathParts(relativePath);
  const rootIndex = parts.findIndex((part) => ["src", "apps", "packages", "modules", "services"].includes(part));
  const segments = rootIndex >= 0 ? parts.slice(rootIndex + 1) : parts;
  const first = segments[0] || "project";
  const second = segments[1];
  // Files directly under a source root belong to the project/core feature.
  // This keeps a repository such as Flowpeek navigable without fabricating a
  // feature per filename.
  if (path.extname(first)) return "project";
  if (first === "app") {
    if (second === "api") return `api/${segments[2] && !segments[2].startsWith("[") ? segments[2] : "root"}`;
    return `pages/${second && !second.startsWith("[") ? second : "root"}`;
  }
  if (first === "components") return `ui/${second && !second.includes(".") ? second : "components"}`;
  if (first === "actions") return "server-actions";
  if (first === "db") return "data";
  if (first === "hooks") return "hooks";
  if (first === "lib") return `library/${second && !second.includes(".") ? second : "shared"}`;
  if (first === "types") return "types";
  if (first === "__test__") return "tests";
  return first;
}

module.exports = { classifyFile, deriveDomain, deriveFeature, isTestPath, titleCase };
