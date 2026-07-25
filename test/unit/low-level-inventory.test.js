"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { findNodes } = require("../../src/graph-service");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

test("unsupported Makefile and NASM paths remain typed inventory anchors without inferred relationships", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-low-level-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "Makefile", "all:\n\t@echo static-only\n");
  write(root, "kernel/longmode_boot.asm", "BITS 64\nstart:\n  hlt\n");
  write(root, "scripts/build_longmode_image.sh", "#!/usr/bin/env sh\necho static-only\n");

  const graph = scanRepository(root, { persistIdentity: false });
  const makefile = graph.nodes.find((node) => node.kind === "file" && node.path === "Makefile");
  const assembly = graph.nodes.find((node) => node.kind === "file" && node.path === "kernel/longmode_boot.asm");
  assert.ok(makefile);
  assert.ok(assembly);
  assert.equal(makefile.language, "makefile");
  assert.equal(assembly.language, "assembly");
  assert.equal(makefile.detectedResponsibility, "Known static file retained as inventory only; no structural relationship is inferred.");
  assert.deepEqual(makefile.analysis, {
    parser: "inventory",
    status: "inventory-only",
    confidence: "not-analyzed",
    reason: "No structural adapter registered for Makefile build-control files.",
  });
  assert.deepEqual(assembly.analysis, {
    parser: "inventory",
    status: "inventory-only",
    confidence: "not-analyzed",
    reason: "No structural adapter registered for assembly source files.",
  });
  assert.equal(graph.edges.some((edge) => edge.source === makefile.id || edge.target === makefile.id || edge.source === assembly.id || edge.target === assembly.id), false);
  assert.deepEqual(findNodes(graph, { query: "kernel/longmode_boot.asm", scope: "all" }).results.map((node) => node.path), ["kernel/longmode_boot.asm"]);
});
