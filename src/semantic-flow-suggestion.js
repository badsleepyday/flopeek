"use strict";

const SEMANTIC_FLOW_SUGGESTION_SCHEMA = "flopeek-semantic-flow-suggestion/v1";
const SEMANTIC_FLOW_SUGGESTIONS_SCHEMA = "flopeek-semantic-flow-suggestions/v1";
const HTTP_ENTRY = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S*)$/;
const METHOD_ROLES = {
  GET: "read-request",
  HEAD: "read-request",
  POST: "create-request",
  PUT: "update-request",
  PATCH: "update-request",
  DELETE: "delete-request",
  OPTIONS: "capability-request",
};
const ACTION_SEMANTICS = {
  login: { title: "Sign In", role: "authenticate-request" },
  logout: { title: "Sign Out", role: "sign-out-request" },
  "accept-invite": { title: "Accept Invite", role: "accept-invite-request" },
  "invite-lookup": { title: "Look Up Invite", role: "lookup-request" },
  redeem: { verb: "Redeem", role: "redeem-request" },
  approve: { verb: "Approve", role: "approval-request" },
  reject: { verb: "Reject", role: "rejection-request" },
  undo: { verb: "Undo", role: "reversal-request" },
  remind: { title: "Send Reminder", role: "reminder-request" },
  settle: { verb: "Settle", role: "settlement-request" },
  exit: { verb: "Exit", role: "exit-request" },
  verify: { verb: "Verify", role: "verification-request" },
};

function titleCase(value) {
  return String(value).split(/[\s_-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function singular(value) {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/sses$/i.test(value) || /ss$/i.test(value)) return value;
  if (/s$/i.test(value) && !/us$/i.test(value)) return value.slice(0, -1);
  return value;
}

function routeParts(route) {
  return route.split("?")[0].split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

function meaningfulRouteParts(route) {
  return routeParts(route).filter((part) => !part.startsWith(":") && !/^\[.*\]$/.test(part) && !/^(api|v\d+)$/i.test(part));
}

function uniqueEvidence(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${item.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confidence(score) {
  const rounded = Math.round(Math.min(Math.max(score, 0), 1) * 100) / 100;
  return { score: rounded, level: rounded >= 0.85 ? "high" : rounded >= 0.7 ? "medium" : "low" };
}

function baseSuggestion(graph, lens) {
  return {
    schemaVersion: SEMANTIC_FLOW_SUGGESTION_SCHEMA,
    id: `suggestion:${lens.flow.id}@${graph.state.graphVersion}`,
    flow: { id: lens.flow.id, contextRef: lens.flow.contextRef, graphVersion: graph.state.graphVersion },
    knowledgeClass: "derived-suggestion",
    status: "abstained",
    confidence: confidence(0),
    candidate: null,
    reasons: [],
    evidenceRefs: [],
    abstention: null,
    limitations: [
      "This deterministic suggestion describes supported static technical evidence; it is not runtime observation or a business-flow claim.",
      "A suggestion never creates or modifies human verification. A person must review and explicitly save any verification record.",
    ],
  };
}

function abstain(graph, lens, code, reason, missingEvidence) {
  const result = baseSuggestion(graph, lens);
  result.abstention = { code, reason, missingEvidence };
  result.reasons = [{ code, message: reason, evidenceRefs: [] }];
  validateSemanticFlowSuggestion(result);
  return result;
}

function actionCandidate(method, parts) {
  const action = String(parts.at(-1) || "").toLowerCase();
  if (["GET", "HEAD"].includes(method) && action === "me") return { title: "Get Current User", role: "read-current-user" };
  if (action === "auth" && parts.at(-2)?.toLowerCase() === "pusher") return { title: "Authenticate Pusher", role: "authenticate-request" };
  if (action === "cloudinary" && parts.at(-2)?.toLowerCase() === "uploads") return { title: "Upload To Cloudinary", role: "upload-request" };
  const rule = ACTION_SEMANTICS[action];
  if (!rule) return null;
  if (rule.title) return rule;
  const previous = parts.at(-2);
  const subject = previous && !/^(api|v\d+)$/i.test(previous) ? ` ${titleCase(singular(previous))}` : "";
  return { title: `${rule.verb}${subject}`, role: rule.role };
}

function candidateTitle(method, subject, route, action) {
  if (action?.title) return action.title;
  const special = /^(health|healthz|ready|readiness|live|liveness|ping|status)$/i.test(subject);
  if (special && ["GET", "HEAD"].includes(method)) return `Check ${titleCase(subject)}`;
  const parameterized = routeParts(route).some((part) => part.startsWith(":") || /^\[.*\]$/.test(part));
  if (["GET", "HEAD"].includes(method)) return `${parameterized ? "Get" : "List"} ${titleCase(parameterized ? singular(subject) : subject)}`;
  if (method === "POST") return `Create ${titleCase(singular(subject))}`;
  if (["PUT", "PATCH"].includes(method)) return `Update ${titleCase(singular(subject))}`;
  if (method === "DELETE") return `Delete ${titleCase(singular(subject))}`;
  return `Handle ${method} ${titleCase(subject)}`;
}

function createSemanticFlowSuggestion(graph, lens) {
  if (!graph?.state || !Number.isSafeInteger(graph.state.graphVersion) || !lens?.flow || !Array.isArray(lens.steps)) throw new Error("Semantic flow suggestions require a versioned Flow Lens.");
  if (lens.flow.entry?.kind && lens.flow.entry.kind !== "http-request") {
    return abstain(graph, lens, "unsupported-entry-family", "Deterministic semantic naming currently supports literal HTTP/request entries only; this entry family remains static technical evidence without a generated purpose label.", ["literal HTTP method", "literal route path"]);
  }
  const match = String(lens.flow.title || "").match(HTTP_ENTRY);
  if (!match) return abstain(graph, lens, "unsupported-entry", "The flow entry is not a supported literal HTTP method and route.", ["literal HTTP method", "literal route path"]);
  const [, method, route] = match;
  if (/\*|\$\{|\(|\)/.test(route)) return abstain(graph, lens, "dynamic-route", "The route contains a dynamic or wildcard form that is outside deterministic semantic naming.", ["stable literal route segments"]);
  const entryStep = lens.steps.find((step) => step.id === lens.flow.entryId) || lens.steps[0];
  if (!entryStep || entryStep.node?.kind !== "endpoint") return abstain(graph, lens, "missing-endpoint-evidence", "The flow has no displayed endpoint node that can anchor a semantic suggestion.", ["displayed endpoint node"]);
  const parts = meaningfulRouteParts(route);
  if (!parts.length) return abstain(graph, lens, "ambiguous-subject", "The literal route has no stable subject segment after technical prefixes and parameters are removed.", ["stable route subject"]);

  const subject = parts.at(-1);
  const action = actionCandidate(method, parts);
  const groupingKey = parts[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const transitionSteps = lens.steps.slice(1);
  const provenTransitions = transitionSteps.filter((step) => step.transition);
  const transitionCoverage = transitionSteps.length ? provenTransitions.length / transitionSteps.length : 0;
  const handlerEvidence = lens.handlerEvidence || { binding: "unknown", siblingHandlerContamination: false };
  let score = 0.45 + 0.15;
  if (handlerEvidence.binding === "exact-handler") score += 0.15;
  else if (entryStep.confidence === "exact" || entryStep.confidence === "exact-static") score += 0.05;
  score += transitionCoverage * 0.15;
  if (lens.staticBoundaries.length) score += 0.1;
  if (handlerEvidence.binding !== "exact-handler") score -= 0.2;
  if (handlerEvidence.siblingHandlerContamination) score -= 0.25;
  if (lens.truncation?.displayTruncated || lens.truncation?.sourceTraversalMayBeTruncated) score -= 0.15;
  if (!provenTransitions.length) score -= 0.1;
  const evidenceRefs = uniqueEvidence([
    { kind: "node-context", ref: entryStep.contextRef, label: entryStep.node.label },
    ...provenTransitions.map((step) => ({ kind: "edge", ref: step.transition.id, label: `${step.transition.type}: ${step.transition.sourceId} -> ${step.transition.targetId}` })),
    ...lens.staticBoundaries.map((boundary) => ({ kind: "node-context", ref: boundary.contextRef, label: `${boundary.category}: ${boundary.node.label}` })),
  ]);
  const roles = [...new Set(lens.steps.map((step) => step.role))];
  const boundaryKinds = [...new Set(lens.staticBoundaries.map((boundary) => boundary.category))];
  const technicalPurpose = `Handles the statically detected ${method} ${route} request through ${roles.join(", ") || "an endpoint"}${boundaryKinds.length ? ` with ${boundaryKinds.join(", ")} boundaries` : ""}.`;
  const result = {
    ...baseSuggestion(graph, lens),
    status: "suggested",
    confidence: confidence(score),
    candidate: {
      title: candidateTitle(method, subject, route, action),
      technicalPurpose,
      role: action?.role || METHOD_ROLES[method] || "request-handler",
      grouping: { key: groupingKey || "root", label: titleCase(groupingKey || "root") },
    },
    reasons: [
      { code: "literal-http-entry", message: `The parser detected the literal ${method} ${route} entry.`, evidenceRefs: [entryStep.contextRef] },
      { code: "route-subject", message: `The stable route segment '${subject}' supplies the candidate subject and '${groupingKey || "root"}' supplies grouping.`, evidenceRefs: [entryStep.contextRef] },
      { code: "static-flow-shape", message: `${provenTransitions.length}/${transitionSteps.length} displayed non-entry steps have direct transition evidence; roles are ${roles.join(", ")}.`, evidenceRefs: provenTransitions.map((step) => step.transition.id) },
      { code: "handler-specificity", message: handlerEvidence.binding === "exact-handler" ? "The endpoint is bound to its exact exported HTTP handler symbol." : "The endpoint is not bound to an exact exported HTTP handler symbol, so confidence is reduced.", evidenceRefs: handlerEvidence.edge ? [handlerEvidence.edge.id] : [] },
    ],
    evidenceRefs,
    abstention: null,
  };
  validateSemanticFlowSuggestion(result);
  return result;
}

function validateSemanticFlowSuggestion(value) {
  if (!value || value.schemaVersion !== SEMANTIC_FLOW_SUGGESTION_SCHEMA) throw new Error("Invalid semantic flow suggestion schema.");
  if (!new Set(["suggested", "abstained"]).has(value.status)) throw new Error("Invalid semantic flow suggestion status.");
  if (value.knowledgeClass !== "derived-suggestion") throw new Error("Semantic suggestions must remain derived-suggestion knowledge.");
  if (!value.confidence || !new Set(["low", "medium", "high"]).has(value.confidence.level) || typeof value.confidence.score !== "number" || value.confidence.score < 0 || value.confidence.score > 1) throw new Error("Invalid semantic suggestion confidence.");
  if (!Array.isArray(value.reasons) || !Array.isArray(value.evidenceRefs) || !Array.isArray(value.limitations)) throw new Error("Semantic suggestions require reasons, evidence references, and limitations.");
  if (value.status === "suggested" && (!value.candidate?.title || !value.candidate?.technicalPurpose || !value.candidate?.role || !value.candidate?.grouping?.key || value.abstention !== null)) throw new Error("A suggested semantic result requires a complete candidate and no abstention.");
  if (value.status === "abstained" && (value.candidate !== null || !value.abstention?.code || !value.abstention?.reason)) throw new Error("An abstained semantic result requires an explicit abstention and no candidate.");
  return true;
}

function semanticSuggestionPolicy() {
  return {
    schemaVersion: SEMANTIC_FLOW_SUGGESTIONS_SCHEMA,
    mode: "deterministic-static",
    candidateFields: ["title", "technicalPurpose", "role", "grouping"],
    outcomes: ["suggested", "abstained"],
    humanVerificationSeparation: "Suggestions may prefill a verification form but never create human verification.",
    limitation: "Suggestions currently use supported static HTTP route, step-role, transition, and boundary evidence only. Other static entry families explicitly abstain; runtime and business purpose remain unknown.",
  };
}

module.exports = { SEMANTIC_FLOW_SUGGESTION_SCHEMA, SEMANTIC_FLOW_SUGGESTIONS_SCHEMA, createSemanticFlowSuggestion, semanticSuggestionPolicy, validateSemanticFlowSuggestion };
