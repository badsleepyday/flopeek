"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { adapterContractDigest } = require("../src/adapter-registry");
const {
  createCoreCompatibilityProjection,
  createSourceDigest,
  stableJson,
} = require("../src/core-compatibility");
const { createJsCoreClient } = require("../src/js-core-client");
const { createNativeCoreClient } = require("../src/native-core-client");
const { createNativeIncrementalSession } = require("../src/native-incremental-coordinator");
const {
  MINIMUM_ADAPTER_CASES,
  NATIVE_ADAPTER_PARITY_SCHEMA,
  validateNativeAdapterParity,
} = require("../src/native-rollout-gate");
const { createScanCoordinator } = require("../src/scan-coordinator");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BINARY = path.join(
  ROOT,
  "native",
  "flopeek-core",
  "target",
  "release",
  process.platform === "win32" ? "flopeek-native-core.exe" : "flopeek-native-core",
);

function fixture(adapterId, id, files) {
  return Object.freeze({
    adapterId,
    id: `${adapterId}:${id}`,
    fixtureId: `generated/${adapterId}/${id}`,
    files: Object.freeze({
      "package.json": `${JSON.stringify({ name: `flopeek-parity-${adapterId}-${id}`, private: true })}\n`,
      ...files,
    }),
  });
}

const CASES = Object.freeze([
  fixture("typescript", "named-import-call", {
    "src/main.ts": "import { normalize } from './normalize';\nexport function run(value: string) { return normalize(value); }\n",
    "src/normalize.ts": "export function normalize(value: string) { return value.trim(); }\n",
  }),
  fixture("typescript", "commonjs-require", {
    "src/main.cjs": "const { load } = require('./store');\nfunction run() { return load(); }\nmodule.exports = { run };\n",
    "src/store.js": "function load() { return 1; }\nmodule.exports = { load };\n",
  }),
  fixture("typescript", "tsx-component", {
    "src/Card.tsx": "export function Card() { return <section>card</section>; }\n",
    "src/page.tsx": "import { Card } from './Card';\nexport function Page() { return <Card />; }\n",
  }),
  fixture("typescript", "path-alias", {
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }, null, 2)}\n`,
    "src/main.ts": "import { parse } from '@lib/parse';\nexport function run() { return parse('1'); }\n",
    "src/lib/parse.ts": "export function parse(value: string) { return Number(value); }\n",
  }),
  fixture("typescript", "package-exports", {
    "packages/core/package.json": `${JSON.stringify({ name: "@parity/core", exports: { ".": "./src/index.ts" } })}\n`,
    "packages/core/src/index.ts": "export function ping() { return 'pong'; }\n",
    "apps/api/src/main.ts": "import { ping } from '@parity/core';\nexport function main() { return ping(); }\n",
    "package.json": `${JSON.stringify({ name: "flopeek-parity-typescript-package-exports", private: true, workspaces: ["packages/*", "apps/*"] })}\n`,
  }),

  fixture("python", "relative-import", {
    "src/payments/__init__.py": "",
    "src/payments/main.py": "from .service import submit\n\ndef run():\n    return submit()\n",
    "src/payments/service.py": "def submit():\n    return True\n",
  }),
  fixture("python", "src-package-import", {
    "src/acme/__init__.py": "",
    "src/acme/main.py": "from acme.helpers import normalize\n\ndef run(value):\n    return normalize(value)\n",
    "src/acme/helpers.py": "def normalize(value):\n    return value.strip()\n",
  }),
  fixture("python", "decorated-route", {
    "src/app.py": "from flask import Flask\napp = Flask(__name__)\n\n@app.get('/health')\ndef health():\n    return {'ok': True}\n",
  }),

  fixture("go", "module-package-call", {
    "go.mod": "module example.test/parity/basic\n\ngo 1.26\n",
    "cmd/main.go": "package main\nimport \"example.test/parity/basic/helper\"\nfunc main() { helper.Ping() }\n",
    "helper/helper.go": "package helper\nfunc Ping() {}\n",
  }),
  fixture("go", "aliased-package-call", {
    "go.mod": "module example.test/parity/alias\n\ngo 1.26\n",
    "cmd/main.go": "package main\nimport util \"example.test/parity/alias/helper\"\nfunc main() { util.Ping() }\n",
    "helper/helper.go": "package helper\nfunc Ping() {}\n",
  }),
  fixture("go", "multi-file-package", {
    "go.mod": "module example.test/parity/multi\n\ngo 1.26\n",
    "cmd/main.go": "package main\nimport \"example.test/parity/multi/helper\"\nfunc main() { helper.Ping(); helper.Pong() }\n",
    "helper/ping.go": "package helper\nfunc Ping() {}\n",
    "helper/pong.go": "package helper\nfunc Pong() {}\n",
  }),
  fixture("go", "standard-library-exclusion", {
    "go.mod": "module example.test/parity/stdlib\n\ngo 1.26\n",
    "main.go": "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"ok\") }\n",
  }),
  fixture("go", "malformed-source", {
    "go.mod": "module example.test/parity/malformed\n\ngo 1.26\n",
    "main.go": "package main\nfunc main( {\n",
  }),

  fixture("csharp", "declarations", {
    "src/Declarations.cs": "namespace Acme.Core {\npublic interface IService { void Run(); }\npublic struct Point { public int X; }\npublic record Receipt(string Id);\npublic class Box<T> { public T Echo<U>(T value) => value; }\n}\n",
  }),
  fixture("csharp", "namespace-usings", {
    "src/NamespaceUsings.cs": "global using System;\nusing IO = System.IO;\nusing static System.Math;\nnamespace Acme.Core;\npublic class Outer { public class Nested { public double Size() => Abs(-1); } }\n",
  }),
  fixture("csharp", "partial-multi-file", {
    "src/Ledger.PartA.cs": "namespace Acme { public partial class Ledger { public void Add() {} } }\n",
    "src/Ledger.PartB.cs": "namespace Acme { public partial class Ledger { public void Delete() {} } }\n",
  }),
  fixture("csharp", "incremental-add-delete-state", {
    "src/Ledger.PartA.cs": "namespace Acme { public partial class Ledger { public void Add() {} } }\n",
    "src/Added.cs": "namespace Acme { public class Added { public void Apply() {} } }\n",
  }),
  fixture("csharp", "renamed-and-malformed", {
    "src/RenamedLedger.cs": "namespace Acme;\npublic class RenamedLedger { public int Count() => 1; }\n",
    "src/Broken.cs": "namespace Acme;\npublic class Broken { public void Submit( {\n",
  }),

  fixture("java", "local-static-call", {
    "src/Main.java": "class Main { static void run() { validate(); } static void validate() {} }\n",
  }),
  fixture("java", "imports", {
    "src/Orders.java": "import java.util.List;\nimport com.acme.Audit;\nclass Orders { static void submit() {} }\n",
  }),
  fixture("java", "multiple-types", {
    "src/Service.java": "interface Service { void run(); }\nclass DefaultService { static void execute() { helper(); } static void helper() {} }\n",
  }),

  fixture("rust", "crate-import", {
    "Cargo.toml": "[package]\nname = \"parity_crate_import\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    "src/lib.rs": "mod helper;\nuse crate::helper::ping;\npub fn run() { ping(); }\n",
    "src/helper.rs": "pub fn ping() {}\n",
  }),
  fixture("rust", "self-super-modules", {
    "Cargo.toml": "[package]\nname = \"parity_self_super\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    "src/lib.rs": "mod area;\n",
    "src/area/mod.rs": "pub mod child;\npub fn shared() {}\n",
    "src/area/child.rs": "use super::shared;\npub fn run() { shared(); }\n",
  }),
  fixture("rust", "external-crate", {
    "Cargo.toml": "[package]\nname = \"parity_external\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    "src/lib.rs": "use serde::Serialize;\npub struct Report { pub value: String }\npub fn run() {}\n",
  }),

  fixture("php", "include-and-function", {
    "src/main.php": "<?php\nrequire_once './helper.php';\nfunction run() { return helper(); }\n",
    "src/helper.php": "<?php\nfunction helper() { return true; }\n",
  }),
  fixture("php", "namespace-use", {
    "src/Service.php": "<?php\nnamespace Acme\\Orders;\nuse Acme\\Shared\\Clock;\nfunction submit() { return true; }\n",
  }),
  fixture("php", "class-and-method", {
    "src/Ledger.php": "<?php\nclass Ledger { public function add() { return 1; } }\nfunction bootstrap() { return true; }\n",
  }),

  fixture("svelte", "component-import", {
    "src/routes/+page.svelte": "<script lang=\"ts\">\nimport Card from '../lib/Card.svelte';\nfunction loadCard() {}\n</script>\n<Card />\n",
    "src/lib/Card.svelte": "<h1>Card</h1>\n",
  }),
  fixture("svelte", "module-and-instance-scripts", {
    "src/routes/+layout.svelte": "<script context=\"module\">\nimport meta from '../lib/meta.js';\n</script>\n<script>\nfunction initialize() {}\n</script>\n<slot />\n",
    "src/lib/meta.js": "export default { title: 'Parity' };\n",
  }),
]);

function parseArguments(argv) {
  const options = {
    binary: DEFAULT_BINARY,
    expectedBinarySha256: null,
    sourceRevision: null,
    output: null,
    allowDirty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    const key = {
      "--binary": "binary",
      "--expected-binary-sha256": "expectedBinarySha256",
      "--source-revision": "sourceRevision",
      "--output": "output",
    }[argument];
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = argv[index + 1];
    index += 1;
  }
  options.binary = path.resolve(options.binary);
  if (options.output) options.output = path.resolve(options.output);
  return options;
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitText(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function compatibilityProjection(graph, _adapterId, _implementation) {
  // Execution identity is retained separately in every evidence record.  The
  // product compatibility projection itself is compared byte-for-byte without
  // deleting or rewriting parser facts, diagnostics, ranges, nodes, or edges.
  return createCoreCompatibilityProjection(graph);
}

function compatibilityDigest(graph, adapterId, implementation) {
  return `sha256:${crypto.createHash("sha256")
    .update(stableJson(compatibilityProjection(graph, adapterId, implementation))).digest("hex")}`;
}

function writeFixture(root, selected) {
  for (const [relativePath, contents] of Object.entries(selected.files)) {
    assert.equal(path.isAbsolute(relativePath), false);
    assert.equal(relativePath.split(/[\\/]/u).includes(".."), false);
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function inventory(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort();
}

async function executeCase(selected, native, javascript, binding) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flopeek-adapter-parity-${selected.adapterId}-`));
  try {
    writeFixture(root, selected);
    const beforeInventory = inventory(root);
    const beforeDigest = createSourceDigest(root);
    const javascriptCoordinator = createScanCoordinator(root, { cache: false, coreClient: javascript });
    const nativeCoordinator = createScanCoordinator(root, { cache: false, coreClient: native });
    const javascriptResult = await javascriptCoordinator.refresh(null, `adapter-parity-js-${selected.id}`);
    const nativeResult = await nativeCoordinator.refresh(null, `adapter-parity-native-${selected.id}`);
    assert.equal(javascriptResult.outcome.status, "complete", `${selected.id}: JavaScript oracle scan failed`);
    assert.equal(nativeResult.outcome.status, "complete", `${selected.id}: native scan failed`);
    assert.equal(native.sourceAuthority, "rust", `${selected.id}: native source authority was not Rust`);
    assert.equal(native.parserHost, "rust-tree-sitter-source/v19", `${selected.id}: native parser host was not Rust`);
    assert.equal(native.factEnvelopeHost, "rust-native-structural-batch/v1", `${selected.id}: fact envelope came from JavaScript`);
    assert.equal(native.backendAuthority, "rust-sqlite", `${selected.id}: native backend authority was not SQLite`);
    assert.equal(nativeResult.graph.analysis.graphState.persistence, "session-memory", `${selected.id}: cache-disabled parity did not remain session-owned`);
    if (stableJson(nativeResult.graph.stats) !== stableJson(javascriptResult.graph.stats)) {
      process.stderr.write(`${selected.id} native nodes: ${stableJson(nativeResult.graph.nodes.map((node) => ({ id: node.id, analysis: node.analysis, evidence: node.evidence, methods: node.methods })))}\n`);
      process.stderr.write(`${selected.id} JavaScript nodes: ${stableJson(javascriptResult.graph.nodes.map((node) => ({ id: node.id, analysis: node.analysis, evidence: node.evidence, methods: node.methods })))}\n`);
    }
    assert.deepEqual(nativeResult.graph.stats, javascriptResult.graph.stats, `${selected.id}: graph statistics diverged`);
    const javascriptCompatibilityDigest = compatibilityDigest(javascriptResult.graph, selected.adapterId, "javascript");
    const nativeCompatibilityDigest = compatibilityDigest(nativeResult.graph, selected.adapterId, "native");
    if (nativeCompatibilityDigest !== javascriptCompatibilityDigest) {
      assert.deepEqual(
        compatibilityProjection(nativeResult.graph, selected.adapterId, "native"),
        compatibilityProjection(javascriptResult.graph, selected.adapterId, "javascript"),
        `${selected.id}: compatibility projection diverged`,
      );
    }
    assert.equal(nativeCompatibilityDigest, javascriptCompatibilityDigest, `${selected.id}: compatibility projection diverged`);
    assert.equal(createSourceDigest(root), beforeDigest, `${selected.id}: fixture source digest changed during verification`);
    assert.deepEqual(inventory(root), beforeInventory, `${selected.id}: verification wrote to the fixture`);
    assert.equal(fs.existsSync(path.join(root, ".flopeek")), false, `${selected.id}: native parity created .flopeek`);
    const executionAdapterCapability = nativeResult.graph.analysis.executionAdapterCapabilities.adapters
      .find((adapter) => adapter.id === selected.adapterId);
    assert.ok(executionAdapterCapability, `${selected.id}: missing execution adapter capability`);
    assert.equal(executionAdapterCapability.availability, "bundled", `${selected.id}: native adapter was not bundled`);
    assert.equal(executionAdapterCapability.requiredToolchain, null, `${selected.id}: native adapter used an external toolchain`);
    return {
      adapterId: selected.adapterId,
      caseId: selected.id,
      fixtureId: selected.fixtureId,
      sourceDigest: beforeDigest,
      javascriptCompatibilityDigest,
      nativeCompatibilityDigest,
      exact: true,
      nativeParserHost: native.parserHost,
      executionAdapterCapability,
      binarySha256: binding.sha256,
      sourceRevision: binding.sourceRevision,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function generateEvidence(options) {
  if (!fs.existsSync(options.binary) || !fs.statSync(options.binary).isFile()) {
    throw new Error(`Native release binary is missing: ${options.binary}`);
  }
  const head = gitText(["rev-parse", "HEAD"]);
  if (!options.allowDirty && gitText(["status", "--porcelain"])) {
    throw new Error("Native adapter parity requires a clean source checkout.");
  }
  if (options.sourceRevision && options.sourceRevision !== head) {
    throw new Error(`Requested source revision ${options.sourceRevision} does not match checked-out HEAD ${head}.`);
  }
  const binding = { sha256: hashFile(options.binary), sourceRevision: options.sourceRevision || head };
  if (options.expectedBinarySha256 && options.expectedBinarySha256 !== binding.sha256) {
    throw new Error(`Native binary SHA-256 ${binding.sha256} does not match expected ${options.expectedBinarySha256}.`);
  }
  const native = createNativeCoreClient({
    native: createNativeIncrementalSession(
      { command: options.binary, args: [] },
      { cwd: ROOT },
    ),
    sourceAuthority: "rust",
  });
  const javascript = createJsCoreClient();
  const records = [];
  try {
    for (const selected of CASES) records.push(await executeCase(selected, native, javascript, binding));
  } finally {
    await native.close();
  }
  const adapters = {};
  for (const adapterId of Object.keys(MINIMUM_ADAPTER_CASES).sort()) {
    const adapterRecords = records.filter((record) => record.adapterId === adapterId);
    adapters[adapterId] = {
      cases: adapterRecords.length,
      exactCases: adapterRecords.filter((record) => record.exact).length,
      caseIds: adapterRecords.map((record) => record.caseId),
      sourceDigests: adapterRecords.map((record) => record.sourceDigest),
      compatibilityDigests: adapterRecords.map((record) => record.nativeCompatibilityDigest),
      records: adapterRecords,
    };
  }
  const evidence = {
    schemaVersion: NATIVE_ADAPTER_PARITY_SCHEMA,
    adapterContractDigest: adapterContractDigest(),
    generatedAt: new Date().toISOString(),
    binary: binding,
    summary: {
      adapters: Object.keys(adapters).length,
      cases: records.length,
      exactCases: records.filter((record) => record.exact).length,
    },
    adapters,
  };
  validateNativeAdapterParity(evidence);
  return evidence;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const evidence = await generateEvidence(options);
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, output);
  }
  process.stdout.write(output);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CASES,
  compatibilityDigest,
  compatibilityProjection,
  generateEvidence,
  parseArguments,
};
