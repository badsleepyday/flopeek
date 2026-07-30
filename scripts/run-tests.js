"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const lane = process.argv[2];
const lanes = {
  full: ["test/showcase.test.js", "test/supported-language-dogfood.test.js", "test/unit/production-static-evidence.test.js", "test/unit/fixture-cache-hygiene.test.js", "test/unit/adapter-registry.test.js", "test/unit/artifact-cache.test.js", "test/unit/durable-brief.test.js", "test/unit/framework-route.test.js", "test/unit/source-classification.test.js", "test/unit/structural-fact-adapter.test.js", "test/unit/handoff-context.test.js", "test/unit/handoff-quality.test.js", "test/unit/handoff-workspace.test.js", "test/unit/project-home.test.js", "test/unit/related-implementations.test.js", "test/unit/runtime-evidence.test.js", "test/unit/serve-workspace.test.js", "test/unit/workspace-server.test.js", "test/unit/workspace-contract-reference.test.js", "test/unit/agent-semantic-proposal.test.js", "test/unit/test-run-journal.test.js", "test/unit/runner-adapter-integration.test.js", "test/unit/semantic-flow-suggestion.test.js", "test/unit/semantic-suggestion-feedback.test.js", "test/unit/semantic-suggestion-reviewed-evaluation.test.js", "test/unit/agent-evidence-trace.test.js", "test/unit/viewer-empty-flow-state.test.js", "test/unit/viewer-observable-qa.test.js", "test/contracts/adapter-capability-contract.test.js", "test/scanner.test.js", "test/fixture-corpus.test.js", "test/flow-verification.test.js"],
  fast: ["test/supported-language-dogfood.test.js", "test/unit/production-static-evidence.test.js", "test/unit/fixture-cache-hygiene.test.js", "test/unit/adapter-registry.test.js", "test/unit/artifact-cache.test.js", "test/unit/durable-brief.test.js", "test/unit/framework-route.test.js", "test/unit/source-classification.test.js", "test/unit/structural-fact-adapter.test.js", "test/unit/handoff-context.test.js", "test/unit/handoff-quality.test.js", "test/unit/handoff-workspace.test.js", "test/unit/project-home.test.js", "test/unit/related-implementations.test.js", "test/unit/runtime-evidence.test.js", "test/unit/serve-workspace.test.js", "test/unit/workspace-server.test.js", "test/unit/workspace-contract-reference.test.js", "test/unit/agent-semantic-proposal.test.js", "test/unit/test-run-journal.test.js", "test/unit/runner-adapter-integration.test.js", "test/unit/semantic-flow-suggestion.test.js", "test/unit/semantic-suggestion-feedback.test.js", "test/unit/agent-evidence-trace.test.js", "test/unit/viewer-empty-flow-state.test.js", "test/unit/viewer-observable-qa.test.js", "test/contracts/adapter-capability-contract.test.js", "test/fixture-corpus.test.js", "test/flow-verification.test.js"],
  unit: ["test/unit/adapter-registry.test.js", "test/unit/artifact-cache.test.js", "test/unit/durable-brief.test.js", "test/unit/framework-route.test.js", "test/unit/source-classification.test.js", "test/unit/structural-fact-adapter.test.js", "test/unit/handoff-context.test.js", "test/unit/handoff-quality.test.js", "test/unit/handoff-workspace.test.js", "test/unit/project-home.test.js", "test/unit/related-implementations.test.js", "test/unit/runtime-evidence.test.js", "test/unit/serve-workspace.test.js", "test/unit/workspace-server.test.js", "test/unit/workspace-contract-reference.test.js", "test/unit/agent-semantic-proposal.test.js", "test/unit/test-run-journal.test.js", "test/unit/runner-adapter-integration.test.js", "test/unit/semantic-flow-suggestion.test.js", "test/unit/semantic-suggestion-feedback.test.js", "test/unit/agent-evidence-trace.test.js", "test/unit/viewer-empty-flow-state.test.js", "test/unit/viewer-observable-qa.test.js"],
  semantic: ["test/unit/semantic-flow-suggestion.test.js"],
  feedback: ["test/unit/semantic-suggestion-feedback.test.js"],
  "reviewed-evaluation": ["test/unit/semantic-suggestion-reviewed-evaluation.test.js"],
  trace: ["test/unit/agent-evidence-trace.test.js"],
  contracts: ["test/contracts/adapter-capability-contract.test.js", "test/contracts/core-compatibility-contract.test.js", "test/flow-verification.test.js"],
  adapters: ["test/scanner.test.js"],
  viewer: ["test/scanner.test.js", "test/unit/viewer-empty-flow-state.test.js", "test/unit/viewer-observable-qa.test.js"],
  showcase: ["test/showcase.test.js"],
  "agent-comparison": ["test/unit/agent-comparison.test.js"],
  package: ["test/unit/package-policy.test.js", "test/unit/clean-room-package.test.js", "test/unit/native-platform-package.test.js"],
  docs: ["test/unit/documentation-assets.test.js"],
};
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/documentation-assets.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/delivery-graph.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/continuation-checkpoint.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/continuation-surfaces.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/continuation-comparison.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/continuation-divergence.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/active-branch-git-evidence.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/git-context-continuity.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/continuation-context.test.js");
for (const name of ["full", "fast"]) lanes[name].unshift("test/work-continuation-journey.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/planned-overlay.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/planned-overlay-surfaces.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/plan-reconciliation.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/plan-reconciliation-surfaces.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/workflow-engine.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/delivery-surfaces.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/clean-room-package.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/repository-discovery.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/bounded-scan.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/session-graph-state.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/scan-coordinator.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/git-metadata.test.js", "test/unit/agent-comparison.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/mcp-startup.test.js", "test/unit/agent-bootstrap.test.js", "test/unit/agent-integration.test.js", "test/unit/product-proof.test.js", "test/unit/trust-analytics.test.js");
for (const name of ["full", "unit"]) lanes[name].unshift("test/unit/orientation-benchmark.test.js");
for (const name of ["full", "fast", "contracts"]) lanes[name].unshift("test/contracts/agent-skills-contract.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/child-process-cleanup.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/monorepo-package-benchmark.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/framework-command-flow.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/public-core-ci.test.js");
for (const name of ["full", "fast", "unit", "package"]) lanes[name].unshift("test/unit/native-release-controls.test.js");
for (const name of ["full", "fast", "unit", "package"]) lanes[name].unshift(
  "test/unit/native-database-open-evidence.test.js",
  "test/unit/native-release-manifest.test.js",
  "test/unit/github-release-approval.test.js",
);
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/branch-name-policy.test.js");
for (const name of ["full", "fast", "unit"]) lanes[name].unshift("test/unit/native-activation-surfaces.test.js");
for (const name of ["full", "fast", "unit", "package"]) lanes[name].unshift("test/unit/go-stdlib-catalog.test.js");
lanes.full.unshift("test/unit/native-mcp-handle.test.js", "test/unit/native-server-handle.test.js", "test/unit/native-surface-contract.test.js");
for (const name of ["full", "fast", "contracts"]) lanes[name].unshift("test/contracts/flopeek-skill-contract.test.js");
for (const name of ["full", "fast"]) lanes[name].unshift("test/contracts/core-compatibility-contract.test.js");
lanes["public-source"] = lanes.full.filter((file) => !["test/contracts/agent-skills-contract.test.js", "test/unit/fixture-cache-hygiene.test.js"].includes(file));
lanes["public-source"].unshift("test/unit/native-inventory-parity.test.js");
lanes["public-source"].unshift("test/unit/native-rust-shadow.test.js");
lanes["public-source"].unshift("test/unit/native-incremental-coordinator.test.js");
if (!lanes[lane]) throw new Error(`Unknown test lane: ${lane}`);
if (lane === "fast") {
  const support = spawnSync(process.execPath, ["scripts/generate-support.js", "--check"], { cwd: root, stdio: "inherit" });
  if (support.status !== 0) process.exit(support.status || 1);
  const documents = spawnSync(process.execPath, ["scripts/check-document-contracts.js"], { cwd: root, stdio: "inherit" });
  if (documents.status !== 0) process.exit(documents.status || 1);
}
const patterns = {
  viewer: "local server|serve watches|serve reports|serve exposes|SvelteKit aliases|benchmark endpoint",
};
const args = ["--test", "--test-concurrency=4"];
if (patterns[lane]) args.push(`--test-name-pattern=${patterns[lane]}`);
if (lane === "public-source") {
  const isolated = ["test/scanner.test.js", "test/unit/native-incremental-coordinator.test.js"];
  const shared = lanes[lane].filter((file) => !isolated.includes(file));
  for (const batch of [
    ["--test", "--test-concurrency=4", ...shared],
    ["--test", "--test-concurrency=1", "test/scanner.test.js"],
    ["--test", "--test-concurrency=1", "test/unit/native-incremental-coordinator.test.js"],
  ]) {
    const result = spawnSync(process.execPath, batch, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  process.exit(0);
}
args.push(...lanes[lane]);
const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
process.exit(result.status || 0);
