"use strict";

const ADAPTER_CAPABILITY_SCHEMA = "flowpeek-adapter-capabilities/v1";
const AVAILABILITY = new Set(["bundled", "toolchain-conditional", "inventory-only"]);
const LEVELS = new Set(["exact-static", "supported-subset", "structure-only", "inventory-only", "unsupported"]);

const adapters = [
  {
    id: "csharp", languages: ["csharp"], extensions: [".cs"], parser: "csharp-roslyn", availability: "toolchain-conditional", requiredToolchain: ".NET SDK with Roslyn assemblies",
    capabilities: { structure: "exact-static", imports: "exact-static", directCalls: "unsupported", frameworkFacts: [] },
    resolverCapabilities: [], evidenceClass: "exact-static", limitations: ["Call graph and runtime dispatch are not implemented."],
  },
  {
    id: "go", languages: ["go"], extensions: [".go"], parser: "go-parser", availability: "toolchain-conditional", requiredToolchain: "Go toolchain",
    capabilities: { structure: "exact-static", imports: "exact-static", directCalls: "supported-subset", frameworkFacts: ["local go.mod module packages"] },
    resolverCapabilities: ["static local module packages"], evidenceClass: "exact-static", limitations: ["Build tags, function values, method dispatch, ambiguous package functions, and package-name mismatches are unsupported."],
  },
  {
    id: "inventory", languages: ["astro", "c", "cpp", "headers", "kotlin", "ruby", "scala", "shell", "swift", "vue"], extensions: [".astro", ".bash", ".c", ".cc", ".cpp", ".cxx", ".h", ".kt", ".kts", ".rb", ".scala", ".sh", ".swift", ".vue", ".zsh"], parser: "inventory", availability: "inventory-only", requiredToolchain: null,
    capabilities: { structure: "inventory-only", imports: "unsupported", directCalls: "unsupported", frameworkFacts: [] },
    resolverCapabilities: [], evidenceClass: "inventory-only", limitations: ["Files are classified but receive no structural relationships."],
  },
  {
    id: "java", languages: ["java"], extensions: [".java"], parser: "tree-sitter-java", availability: "bundled", requiredToolchain: null,
    capabilities: { structure: "exact-static", imports: "exact-static", directCalls: "supported-subset", frameworkFacts: [] },
    resolverCapabilities: [], evidenceClass: "exact-static", limitations: ["Instance, qualified, overloaded, reflection, and DI/container dispatch are unsupported."],
  },
  {
    id: "php", languages: ["php"], extensions: [".php"], parser: "php-parser", availability: "bundled", requiredToolchain: null,
    capabilities: { structure: "exact-static", imports: "exact-static", directCalls: "supported-subset", frameworkFacts: [] },
    resolverCapabilities: [], evidenceClass: "exact-static", limitations: ["Composer autoloading, dynamic include, method/static dispatch, and container calls are unsupported."],
  },
  {
    id: "python", languages: ["python"], extensions: [".py"], parser: "python-lezer", availability: "bundled", requiredToolchain: null,
    capabilities: { structure: "exact-static", imports: "supported-subset", directCalls: "supported-subset", frameworkFacts: ["literal HTTP decorators", "Flask and Blueprint literal routes"] },
    resolverCapabilities: ["relative and src-package imports"], evidenceClass: "exact-static", limitations: ["Attribute calls, dynamic dispatch, and dynamic decorator configuration are unsupported."],
  },
  {
    id: "rust", languages: ["rust"], extensions: [".rs"], parser: "tree-sitter-rust", availability: "bundled", requiredToolchain: null,
    capabilities: { structure: "exact-static", imports: "supported-subset", directCalls: "supported-subset", frameworkFacts: ["conventional Cargo src module layout"] },
    resolverCapabilities: ["crate/self/super modules in conventional Cargo src roots"], evidenceClass: "exact-static", limitations: ["Macros, traits, function values, qualified module calls, custom targets, and #[path] modules are unsupported."],
  },
  {
    id: "svelte", languages: ["svelte"], extensions: [".svelte"], parser: "svelte-compiler", availability: "bundled", requiredToolchain: null,
    capabilities: { structure: "exact-static", imports: "supported-subset", directCalls: "supported-subset", frameworkFacts: ["SvelteKit file-system routes"] },
    resolverCapabilities: ["supported script imports"], evidenceClass: "exact-static", limitations: ["Reactive and runtime component behavior are not traced."],
  },
  {
    id: "typescript", languages: ["javascript", "jsx", "tsx", "typescript"], extensions: [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"], parser: "typescript-ast", availability: "bundled", requiredToolchain: null,
    capabilities: { structure: "exact-static", imports: "exact-static", directCalls: "supported-subset", frameworkFacts: ["Express", "Fastify", "NestJS", "Next.js", "Prisma", "TypeORM", "Drizzle", "BullMQ"] },
    resolverCapabilities: ["relative paths", "tsconfig/jsconfig paths", "static Vite/Webpack aliases", "package imports/exports", "npm/pnpm workspaces", "Yarn PnP JSON"], evidenceClass: "exact-static", limitations: ["Dynamic imports, general method dispatch, callbacks, dependency injection, reflection, and runtime loading are unsupported."],
  },
];

function normalizeAdapter(adapter) {
  return {
    ...adapter,
    languages: [...adapter.languages].sort(),
    extensions: [...adapter.extensions].sort(),
    capabilities: { ...adapter.capabilities, frameworkFacts: [...adapter.capabilities.frameworkFacts].sort() },
    resolverCapabilities: [...adapter.resolverCapabilities].sort(),
    limitations: [...adapter.limitations].sort(),
  };
}

function validateAdapterRegistry(registry) {
  if (!registry || registry.schema !== ADAPTER_CAPABILITY_SCHEMA || !Array.isArray(registry.adapters)) throw new Error("Invalid adapter capability registry schema.");
  const ids = new Set();
  const extensions = new Set();
  for (const adapter of registry.adapters) {
    const allowed = new Set(["id", "languages", "extensions", "parser", "availability", "requiredToolchain", "capabilities", "resolverCapabilities", "evidenceClass", "limitations"]);
    for (const key of Object.keys(adapter)) if (!allowed.has(key)) throw new Error(`Unknown adapter registry field: ${key}`);
    if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || ids.has(adapter.id)) throw new Error(`Invalid or duplicate adapter ID: ${adapter.id}`);
    ids.add(adapter.id);
    if (!AVAILABILITY.has(adapter.availability)) throw new Error(`Invalid adapter availability: ${adapter.availability}`);
    if (!Array.isArray(adapter.languages) || !adapter.languages.length || !Array.isArray(adapter.extensions) || !adapter.extensions.length) throw new Error(`Adapter ${adapter.id} requires languages and extensions.`);
    for (const extension of adapter.extensions) {
      if (!/^\.[a-z0-9]+$/.test(extension) || extension !== extension.toLowerCase() || extensions.has(extension)) throw new Error(`Invalid extension for ${adapter.id}: ${extension}`);
      extensions.add(extension);
    }
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

function getAdapterRegistry() {
  const registry = { schema: ADAPTER_CAPABILITY_SCHEMA, adapters: adapters.map(normalizeAdapter).sort((left, right) => left.id.localeCompare(right.id)) };
  validateAdapterRegistry(registry);
  return registry;
}

module.exports = { ADAPTER_CAPABILITY_SCHEMA, getAdapterRegistry, validateAdapterRegistry };
