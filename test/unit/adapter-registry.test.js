const assert = require("node:assert/strict");
const test = require("node:test");
const { ADAPTER_CAPABILITY_SCHEMA, getAdapterRegistry, validateAdapterRegistry } = require("../../src/adapter-registry");

test("adapter capability registry is versioned, sorted, and valid", () => {
  const registry = getAdapterRegistry();
  assert.equal(registry.schema, ADAPTER_CAPABILITY_SCHEMA);
  assert.deepEqual(registry.adapters.map((adapter) => adapter.id), [...registry.adapters.map((adapter) => adapter.id)].sort());
  assert.equal(validateAdapterRegistry(registry), true);
  assert.ok(registry.adapters.some((adapter) => adapter.id === "typescript" && adapter.parser === "typescript-ast"));
  assert.ok(registry.adapters.some((adapter) => adapter.id === "go" && adapter.requiredToolchain === "Go toolchain"));
});

test("adapter capability registry rejects invalid vocabulary and unknown fields", () => {
  const registry = getAdapterRegistry();
  const invalidLevel = structuredClone(registry);
  invalidLevel.adapters[0].capabilities.structure = "runtime";
  assert.throws(() => validateAdapterRegistry(invalidLevel), /Invalid structure level/);
  const unknownField = structuredClone(registry);
  unknownField.adapters[0].future = true;
  assert.throws(() => validateAdapterRegistry(unknownField), /Unknown adapter registry field/);
  const unknownCapability = structuredClone(registry);
  unknownCapability.adapters[0].capabilities.runtime = "guessed";
  assert.throws(() => validateAdapterRegistry(unknownCapability), /Unknown capability field/);
});
