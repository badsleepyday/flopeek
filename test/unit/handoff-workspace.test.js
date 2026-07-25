"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { exportHandoffWorkspace, importHandoffWorkspace, listHandoffNotes, listHandoffWorkspaces, listImportedHandoffs, saveHandoffNote, saveHandoffWorkspace } = require("../../src/handoff-workspace");
const { scanRepository } = require("../../src/scanner");

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(root, name) {
  write(root, "package.json", JSON.stringify({ name }));
  write(root, "src/payment/payment.routes.ts", "import { PaymentService } from './payment.service';\nrouter.post('/payments/approve', () => PaymentService.approve());");
  write(root, "src/payment/payment.service.ts", "const SOURCE_BODY_SENTINEL = 'never export me';\nexport class PaymentService { static approve() {} }");
  write(root, "src/payment/payment.service.spec.ts", "import { PaymentService } from './payment.service';\ntest('approve', () => PaymentService.approve());");
  return scanRepository(root);
}

test("handoff workspaces and human notes are append-only, versioned, attributed, and superseded explicitly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-workspace-"));
  try {
    const graph = fixture(root, "handoff-workspace-fixture");
    const flow = graph.flows.find((item) => item.title === "POST /payments/approve");
    const testNode = graph.nodes.find((node) => node.path === "src/payment/payment.service.spec.ts" && (node.type === "test" || node.kind === "test"));
    const service = graph.nodes.find((node) => node.id === "file:src/payment/payment.service.ts");
    const startingRef = createContextRef(graph.project.projectId, "node", service.id, graph.state.graphVersion);
    const input = {
      operationId: "handoff-v1",
      author: "Delivery team",
      purpose: "Maintain payment authorization and settlement safely.",
      architectureSummary: "HTTP routes call domain services and tests exercise the service boundary.",
      criticalFlowIds: [flow.id],
      owners: ["Payments team owns approval behavior."],
      risks: ["Authorization changes can affect settlement correctness."],
      decisions: ["Keep approval logic behind the payment service."],
      knownLimitations: ["Runtime payment-provider behavior is not captured."],
      unresolvedQuestions: ["Who approves emergency settlement changes?"],
      relatedTestIds: [testNode.id],
      recommendedStartingPointRefs: [startingRef],
    };
    const first = saveHandoffWorkspace(root, graph, input, { now: "2026-07-14T01:00:00.000Z" });
    assert.equal(first.created, true);
    assert.equal(saveHandoffWorkspace(root, graph, input, { now: "2026-07-14T02:00:00.000Z" }).created, false);
    assert.equal(first.workspace.content.purpose.evidenceClass, "human-authored");
    assert.equal(first.workspace.content.purpose.graphVersion, graph.state.graphVersion);
    assert.equal(first.workspace.content.criticalFlows[0].flow.evidenceClass, "static-parser-fact");
    assert.equal(first.workspace.content.runtimeEvidence.status, "unavailable");

    const second = saveHandoffWorkspace(root, graph, { ...input, operationId: "handoff-v2", risks: [...input.risks, "Manual reconciliation remains a fallback."] }, { now: "2026-07-14T03:00:00.000Z" });
    assert.equal(second.workspace.supersedes, first.workspace.id);
    const listed = listHandoffWorkspaces(root, graph);
    assert.equal(listed.total, 2);
    assert.equal(listed.current.id, second.workspace.id);
    assert.equal(listed.records.find((item) => item.id === first.workspace.id).lifecycleStatus, "superseded");

    const noteOne = saveHandoffNote(root, graph, { operationId: "note-1", workspaceId: second.workspace.id, subjectKind: "project", body: "Reconciliation ownership still needs confirmation.", author: "Delivery team" }, { now: "2026-07-14T04:00:00.000Z" });
    const noteTwo = saveHandoffNote(root, graph, { operationId: "note-2", workspaceId: second.workspace.id, subjectKind: "project", body: "Reconciliation ownership belongs to the finance platform team.", author: "Receiving team", supersedesNoteId: noteOne.note.id }, { now: "2026-07-14T05:00:00.000Z" });
    assert.equal(noteTwo.note.supersedes, noteOne.note.id);
    const notes = listHandoffNotes(root, graph, second.workspace.id);
    assert.equal(notes.records.find((item) => item.id === noteOne.note.id).lifecycleStatus, "superseded");
    assert.equal(notes.records.find((item) => item.id === noteTwo.note.id).lifecycleStatus, "active");
    assert.throws(() => saveHandoffWorkspace(root, graph, { ...input, operationId: "unsafe", purpose: "Read C:\\Users\\person\\secret.txt" }), /machine path/);
    assert.throws(() => saveHandoffNote(root, graph, { operationId: "unsafe-note", subjectKind: "general", body: "const leaked = true;\nexport default leaked;", author: "Unsafe" }), /single-line statement/);
    assert.throws(() => saveHandoffNote(root, graph, { operationId: "note-fork", workspaceId: second.workspace.id, subjectKind: "project", body: "A conflicting replacement.", author: "Receiving team", supersedesNoteId: noteOne.note.id }), /already has a retained successor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("JSON and Markdown handoff exports import as foreign read-only artifacts without source bodies or machine roots", () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-export-"));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-import-"));
  try {
    const sourceGraph = fixture(sourceRoot, "handoff-export-source");
    saveHandoffWorkspace(sourceRoot, sourceGraph, { operationId: "portable-v1", author: "Source team", purpose: "Explain the payment boundary to a receiving team.", unresolvedQuestions: ["Is provider retry behavior documented elsewhere?"] }, { now: "2026-07-14T06:00:00.000Z" });
    const json = exportHandoffWorkspace(sourceRoot, sourceGraph, { format: "json" });
    const markdown = exportHandoffWorkspace(sourceRoot, sourceGraph, { format: "markdown" });
    assert.equal(json.schemaVersion, "flowpeek-handoff-export/v1");
    assert.match(markdown.markdown, /flowpeek-handoff-json-base64:/);
    const serialized = JSON.stringify({ json, markdown });
    assert.equal(serialized.includes(sourceRoot), false);
    assert.equal(serialized.includes("SOURCE_BODY_SENTINEL"), false);
    const sameProjectImport = importHandoffWorkspace(sourceRoot, sourceGraph, json, { now: "2026-07-14T06:30:00.000Z" });
    assert.equal(sameProjectImport.import.projectIdentityMatch, true);
    assert.equal(sameProjectImport.import.access, "read-only");
    assert.equal(sameProjectImport.import.trust, "foreign-unverified");

    const targetGraph = fixture(targetRoot, "handoff-import-target");
    const importedJson = importHandoffWorkspace(targetRoot, targetGraph, json, { now: "2026-07-14T07:00:00.000Z" });
    assert.equal(importedJson.created, true);
    assert.equal(importedJson.import.access, "read-only");
    assert.equal(importedJson.import.trust, "foreign-unverified");
    assert.equal(importedJson.import.verificationStatus, "not-adopted");
    assert.equal(importedJson.import.projectIdentityMatch, false);
    assert.equal(importHandoffWorkspace(targetRoot, targetGraph, markdown, { now: "2026-07-14T08:00:00.000Z" }).created, false);
    const imports = listImportedHandoffs(targetRoot, targetGraph);
    assert.equal(imports.total, 1);
    assert.equal(imports.records[0].artifactStatus, "retained");
    assert.equal(listHandoffWorkspaces(targetRoot, targetGraph).total, 0);

    const corrupted = structuredClone(json);
    corrupted.workspace.author = "Tampered author";
    assert.throws(() => importHandoffWorkspace(targetRoot, targetGraph, corrupted), /hash does not match/);
    const injected = structuredClone(json);
    injected.workspace.sourceBody = "hidden payload";
    assert.throws(() => importHandoffWorkspace(targetRoot, targetGraph, injected), /is not allowed/);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("invalid handoff metadata is reported unavailable and never overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowpeek-handoff-invalid-"));
  try {
    const graph = fixture(root, "handoff-invalid-store");
    const storePath = path.join(root, ".flowpeek", "handoff", "workspaces.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({ schemaVersion: "flowpeek-handoff-workspaces/v1", projectId: graph.project.projectId, records: [{ id: "broken" }] }));
    const before = fs.readFileSync(storePath, "utf8");
    assert.equal(listHandoffWorkspaces(root, graph).status, "unavailable");
    assert.throws(() => saveHandoffWorkspace(root, graph, { operationId: "must-not-overwrite", author: "Test", purpose: "This should fail." }), /does not match/);
    assert.equal(fs.readFileSync(storePath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
