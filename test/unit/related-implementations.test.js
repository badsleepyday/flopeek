"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createContextRef } = require("../../src/context-card");
const { getRelatedImplementations, staticConventionTokens } = require("../../src/related-implementations");
const { scanRepository } = require("../../src/scanner");

function fileNode(id, filePath) {
  return { id, kind: "file", path: filePath, label: path.basename(filePath), type: "file" };
}

test("static convention discovery returns only bounded exact token co-occurrence without source bodies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-related-implementations-"));
  try {
    fs.mkdirSync(path.join(root, "application", "views", "contacts"), { recursive: true });
    fs.writeFileSync(path.join(root, "application", "views", "contacts", "form.php"), '<input class="ha-end-date form-control" data-role="contact-date" onchange="setHaEndDate(this)">');
    fs.writeFileSync(path.join(root, "application", "views", "contacts", "edit.php"), '<input class="ha-end-date form-control" data-role="contact-date" onchange="setHaEndDate(this)">');
    fs.writeFileSync(path.join(root, "application", "views", "contacts", "other.php"), '<input class="form-control" data-role="other-date" onchange="setOtherDate(this)">');
    const subject = fileNode("file:form", "application/views/contacts/form.php");
    const graph = {
      project: { root, projectId: "related-fixture" },
      state: { graphVersion: 3, sourceRevision: "fixture" },
      nodes: [subject, fileNode("file:edit", "application/views/contacts/edit.php"), fileNode("file:other", "application/views/contacts/other.php")],
    };
    const contextRef = createContextRef(graph.project.projectId, "node", subject.id, graph.state.graphVersion);
    const result = getRelatedImplementations(graph, contextRef);
    assert.equal(result.status, "available");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].path, "application/views/contacts/edit.php");
    assert.deepEqual(result.candidates[0].matchedTokens, ["class:ha-end-date", "data:contact-date", "handler:setHaEndDate"]);
    assert.equal(JSON.stringify(result).includes("form-control"), false);
    assert.match(result.limitation, /does not expose source bodies/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("static convention token extraction excludes generic markup tokens", () => {
  assert.deepEqual(staticConventionTokens('<input class="form-control ha-end-date" id="contact-date" onchange="setHaEndDate(this)">'), ["class:ha-end-date", "handler:setHaEndDate", "id:contact-date"]);
});

test("static convention token extraction recognizes CodeIgniter helper attributes", () => {
  assert.deepEqual(staticConventionTokens("<?=form_button(array('class'=>'today orangebutton', 'id'=>'enddate_action'))?>"), ["class:orangebutton", "class:today", "id:enddate_action"]);
});

test("same-directory files are considered before unrelated files when the scan cap applies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-related-priority-"));
  try {
    fs.mkdirSync(path.join(root, "application", "views", "hr"), { recursive: true });
    fs.mkdirSync(path.join(root, "application", "aaa"), { recursive: true });
    fs.writeFileSync(path.join(root, "application", "views", "hr", "contacts.php"), "<?=form_button(array('class'=>'today orangebutton'))?>");
    fs.writeFileSync(path.join(root, "application", "views", "hr", "education.php"), "<?=form_button(array('class'=>'today orangebutton'))?>");
    fs.writeFileSync(path.join(root, "application", "aaa", "unrelated.php"), "<?=form_button(array('class'=>'today orangebutton'))?>");
    const subject = fileNode("file:contacts", "application/views/hr/contacts.php");
    const graph = { project: { root, projectId: "related-priority" }, state: { graphVersion: 1 }, nodes: [subject, fileNode("file:education", "application/views/hr/education.php"), fileNode("file:unrelated", "application/aaa/unrelated.php")] };
    const result = getRelatedImplementations(graph, createContextRef(graph.project.projectId, "node", subject.id, graph.state.graphVersion), { maxCandidateFiles: 1 });
    assert.equal(result.candidates[0].path, "application/views/hr/education.php");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI returns the same bounded convention projection for a file Context Ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flopeek-related-cli-"));
  try {
    fs.mkdirSync(path.join(root, "views"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "related-cli" }));
    fs.writeFileSync(path.join(root, "views", "form.php"), '<input class="ha-end-date" data-role="date" onchange="setHaEndDate(this)">');
    fs.writeFileSync(path.join(root, "views", "edit.php"), '<input class="ha-end-date" data-role="date" onchange="setHaEndDate(this)">');
    const graph = scanRepository(root, { persistIdentity: true });
    const node = graph.nodes.find((candidate) => candidate.kind === "file" && candidate.path === "views/form.php");
    const contextRef = createContextRef(graph.project.projectId, "node", node.id, graph.state.graphVersion);
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "..", "src", "cli.js"), "related-implementations", root, "--context-ref", contextRef, "--format", "json"], { encoding: "utf8" });
    const result = JSON.parse(output);
    assert.equal(result.schemaVersion, "flopeek-related-implementations/v1");
    assert.equal(result.candidates[0].path, "views/edit.php");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
