"use strict";

const { createHash } = require("node:crypto");
const ADAPTER_CAPABILITY_SCHEMA = "flopeek-adapter-capabilities/v2";
const AVAILABILITY = new Set(["bundled", "toolchain-conditional", "inventory-only", "unavailable"]);
const LEVELS = new Set(["exact-static", "supported-subset", "structure-only", "inventory-only", "unsupported"]);
const adapterContract = require("../contracts/adapter-capabilities.json");

function normalizeAdapter(adapter, implementation = "javascript") {
  const selected = adapter.implementations?.[implementation] || null;
  const capabilities = adapter.productCapability || adapter.capabilities;
  return {
    ...adapter,
    ...(selected || {}),
    languages: [...adapter.languages].sort(),
    extensions: [...adapter.extensions].sort(),
    filenames: [...(adapter.filenames || [])].sort(),
    capabilities: { ...capabilities, frameworkFacts: [...capabilities.frameworkFacts].sort() },
    ...(adapter.productCapability ? {
      productCapability: { ...capabilities, frameworkFacts: [...capabilities.frameworkFacts].sort() },
    } : {}),
    resolverCapabilities: [...adapter.resolverCapabilities].sort(),
    limitations: [...adapter.limitations].sort(),
  };
}

function validateAdapterRegistry(registry) {
  if (!registry || registry.schema !== ADAPTER_CAPABILITY_SCHEMA || !Array.isArray(registry.adapters)) throw new Error("Invalid adapter capability registry schema.");
  const ids = new Set();
  const extensions = new Set();
  for (const adapter of registry.adapters) {
    const allowed = new Set(["id", "languages", "extensions", "filenames", "parser", "availability", "requiredToolchain", "capabilities", "productCapability", "implementations", "resolverCapabilities", "evidenceClass", "limitations"]);
    for (const key of Object.keys(adapter)) if (!allowed.has(key)) throw new Error(`Unknown adapter registry field: ${key}`);
    if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || ids.has(adapter.id)) throw new Error(`Invalid or duplicate adapter ID: ${adapter.id}`);
    ids.add(adapter.id);
    if (!AVAILABILITY.has(adapter.availability)) throw new Error(`Invalid adapter availability: ${adapter.availability}`);
    if (adapter.implementations) {
      for (const implementation of ["javascript", "native"]) {
        const value = adapter.implementations[implementation];
        if (!value || !AVAILABILITY.has(value.availability)
          || !Object.hasOwn(value, "parser") || !Object.hasOwn(value, "requiredToolchain")) {
          throw new Error(`Adapter ${adapter.id} has an invalid ${implementation} implementation.`);
        }
      }
    }
    if (!Array.isArray(adapter.languages) || !adapter.languages.length || !Array.isArray(adapter.extensions) || !adapter.extensions.length) throw new Error(`Adapter ${adapter.id} requires languages and extensions.`);
    for (const extension of adapter.extensions) {
      if (!/^\.[a-z0-9]+$/.test(extension) || extension !== extension.toLowerCase() || extensions.has(extension)) throw new Error(`Invalid extension for ${adapter.id}: ${extension}`);
      extensions.add(extension);
    }
    if (adapter.filenames !== undefined && (!Array.isArray(adapter.filenames) || adapter.filenames.some((filename) => typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)))) throw new Error(`Invalid filenames for ${adapter.id}.`);
    const capabilityFields = new Set(["structure", "imports", "directCalls", "frameworkFacts"]);
    if (!adapter.capabilities || ![...capabilityFields].every((key) => Object.hasOwn(adapter.capabilities, key))) throw new Error(`Adapter ${adapter.id} has incomplete capabilities.`);
    for (const key of Object.keys(adapter.capabilities)) if (!capabilityFields.has(key)) throw new Error(`Unknown capability field for ${adapter.id}: ${key}`);
    for (const key of ["structure", "imports", "directCalls"]) if (!LEVELS.has(adapter.capabilities[key])) throw new Error(`Invalid ${key} level for ${adapter.id}.`);
    for (const field of ["languages", "resolverCapabilities", "limitations", "capabilities.frameworkFacts"]) {
      const value = field === "capabilities.frameworkFacts" ? adapter.capabilities.frameworkFacts : adapter[field];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`Adapter ${adapter.id} has invalid ${field}.`);
    }
    if (!LEVELS.has(adapter.evidenceClass)) throw new Error(`Invalid evidence class for ${adapter.id}.`);
    if (adapter.availability === "toolchain-conditional" && !adapter.requiredToolchain) throw new Error(`Adapter ${adapter.id} must declare a required toolchain.`);
    if (adapter.availability !== "toolchain-conditional" && adapter.requiredToolchain !== null) throw new Error(`Adapter ${adapter.id} has an unexpected toolchain requirement.`);
  }
  return true;
}

function getAdapterRegistry(options = {}) {
  const implementation = options.implementation === "native" ? "native" : "javascript";
  const registry = {
    schema: adapterContract.schema,
    adapters: adapterContract.adapters
      .map((adapter) => normalizeAdapter(adapter, implementation))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  validateAdapterRegistry(registry);
  return registry;
}

function adapterContractDigest() {
  return `sha256:${createHash("sha256").update(JSON.stringify(adapterContract)).digest("hex")}`;
}

function adapterForPath(filePath, registry = getAdapterRegistry()) {
  const name = String(filePath).split(/[\\/]/).pop() || "";
  const extension = name.includes(".") ? `.${name.split(".").pop().toLowerCase()}` : "";
  const filename = name.toLowerCase();
  return registry.adapters.find((adapter) => adapter.extensions.includes(extension)
    || (adapter.filenames || []).some((candidate) => candidate.toLowerCase() === filename)) || null;
}

module.exports = { ADAPTER_CAPABILITY_SCHEMA, adapterContractDigest, adapterForPath, getAdapterRegistry, validateAdapterRegistry };
