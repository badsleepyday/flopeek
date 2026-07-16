# ADR-007: Append-only agent evidence traces

## Status

Accepted.

## Context

Flowpeek can give an agent a versioned Context Ref, but reviewers also need a compact record of which context the agent used, what action it declared, which files it changed, and how it says the work was verified. Storing prompts, hidden model state, chain-of-thought, source contents, or raw command logs would expand the trust and privacy boundary without making the graph evidence more reliable.

## Decision

Flowpeek stores `flowpeek-agent-evidence-trace/v1` records in `.flowpeek/agent-evidence-traces.json`. Each append-only record contains:

- a caller-supplied `operationId` for idempotent retries;
- one valid current, stale, or retained historical node/flow Context Ref;
- the evidence graph version and graph version at recording time;
- an agent-declared action type and short summary;
- normalized repository-relative changed paths;
- an agent-declared verification status and summary;
- an actor and timestamp.

Reusing an `operationId` with identical declared input returns the existing record. Reusing it with different input fails instead of overwriting history. Invalid stores are reported and preserved. Absolute paths, traversal paths, unresolved references, unsupported context kinds, and future graph versions are rejected.

`get_agent_evidence_traces` is read-only. `record_agent_evidence_trace` is the only MCP metadata mutation introduced by this decision. It can write only the trace store through the same atomic local JSON mechanism as other Flowpeek metadata; it cannot write repository source, execute commands, or create human verification. Flowpeek does not request or automatically capture prompts, reasoning, source contents, credentials, or command logs. Because the two summaries are caller-supplied text, the contract explicitly requires concise outcomes and prohibits submitting that sensitive material. The local HTTP API exposes the same query and append operations to trusted local clients. Agent context advertises the policy and a bounded five-record summary window.

## Consequences

The trace improves auditability without claiming correctness. Action and verification fields remain `agent-declared`; they are not parser facts, human approval, runtime proof, or a substitute for test output retained by CI. The current viewer does not display trace history; that remains an opt-in presentation layer. A future storage abstraction may move records into an embedded database without changing the public schemas.
