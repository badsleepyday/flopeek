"use strict";

const FLOW_ENTRY_SCHEMA = "flowpeek-static-flow-entry/v1";

function entryBase(input) {
  return {
    schemaVersion: FLOW_ENTRY_SCHEMA,
    kind: input.kind,
    family: input.family,
    nodeId: input.nodeId,
    label: input.label,
    declaration: input.declaration || {},
    evidence: input.evidence || null,
    limitations: input.limitations || [],
  };
}

function createHttpFlowEntry(node) {
  const [method = null, route = null] = String(node?.label || "").split(" ", 2);
  return entryBase({
    kind: "http-request",
    family: "http",
    nodeId: node?.id || null,
    label: node?.label || "HTTP request",
    declaration: { method, route },
    evidence: node?.evidence || null,
    limitations: [
      "The literal HTTP entry is static parser evidence. It does not prove a request was received, handler execution, runtime order, or business behavior.",
    ],
  });
}

function createPackageScriptFlowEntry(node) {
  return entryBase({
    kind: "package-script",
    family: "command",
    nodeId: node?.id || null,
    label: node?.label || "Package script",
    declaration: {
      manifest: node?.manifest || null,
      scriptName: node?.scriptName || null,
      runner: node?.runner || null,
      targetPath: node?.targetPath || null,
    },
    evidence: node?.evidence || null,
    limitations: [
      "The literal package script is static manifest evidence. It does not prove that a shell invoked it, that the runner exists, or that its target executed successfully.",
      "Only the declared direct runner-to-source-file target is projected; shell composition, environment expansion, package-manager indirection, and runtime module loading are outside this entry contract.",
    ],
  });
}

function createDjangoManagementCommandFlowEntry(node) {
  return entryBase({
    kind: "framework-command",
    family: "command",
    nodeId: node?.id || null,
    label: node?.label || "Django management command",
    declaration: {
      adapter: "django",
      commandName: node?.commandName || null,
      targetPath: node?.targetPath || node?.path || null,
      targetId: node?.targetId || null,
    },
    evidence: node?.evidence || null,
    limitations: [
      "The Django management command is an exact static declaration subset. It does not prove app registration, settings loading, command invocation, handle execution, or successful behavior.",
      "Only a non-private management/commands module with a top-level Command class directly extending the imported django.core.management.base.BaseCommand binding and defining a direct handle method is projected.",
    ],
  });
}

function createNodeCronScheduleFlowEntry(node) {
  return entryBase({
    kind: "scheduled-task",
    family: "scheduler",
    nodeId: node?.id || null,
    label: node?.label || "Scheduled task",
    declaration: {
      adapter: "node-cron",
      expression: node?.scheduleExpression || null,
      taskName: node?.taskName || null,
      targetPath: node?.targetPath || node?.path || null,
    },
    evidence: node?.evidence || null,
    limitations: [
      "The node-cron registration is static syntax evidence. It does not prove scheduler initialization, registration execution, schedule timing, task execution, or successful behavior.",
      "Only a module-scope literal cron expression and one exact local top-level function identifier are projected; inline callbacks, imported callbacks, dynamic expressions, nested registration, and other scheduler APIs are outside this entry contract.",
    ],
  });
}

function isSupportedFlowEntryNode(node) {
  return Boolean(node && (
    node.kind === "endpoint"
    || (node.kind === "command" && node.entryKind === "package-script")
    || (node.kind === "command" && node.entryKind === "django-management-command")
    || (node.kind === "schedule" && node.entryKind === "node-cron-schedule")
  ));
}

function createUnknownFlowEntry(node) {
  return entryBase({
    kind: "unknown-static-entry",
    family: "unknown",
    nodeId: node?.id || null,
    label: node?.label || "Static entry",
    declaration: {},
    evidence: node?.evidence || null,
    limitations: ["This entry family predates the generalized Flow Entry contract. Inspect raw node evidence before interpreting the projection."],
  });
}

function inferFlowEntry(flow, node) {
  if (flow?.entry?.schemaVersion === FLOW_ENTRY_SCHEMA) return flow.entry;
  if (node?.kind === "endpoint") return createHttpFlowEntry(node);
  if (node?.kind === "command" && node?.entryKind === "package-script") return createPackageScriptFlowEntry(node);
  if (node?.kind === "command" && node?.entryKind === "django-management-command") return createDjangoManagementCommandFlowEntry(node);
  if (node?.kind === "schedule" && node?.entryKind === "node-cron-schedule") return createNodeCronScheduleFlowEntry(node);
  return createUnknownFlowEntry(node);
}

module.exports = {
  FLOW_ENTRY_SCHEMA,
  createDjangoManagementCommandFlowEntry,
  createHttpFlowEntry,
  createNodeCronScheduleFlowEntry,
  createPackageScriptFlowEntry,
  inferFlowEntry,
  isSupportedFlowEntryNode,
};
