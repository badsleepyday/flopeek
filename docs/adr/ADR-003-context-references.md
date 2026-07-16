# ADR-003: local Context References and node/flow Context Cards

## Status

Accepted and implemented for raw graph nodes and bounded HTTP/request flows.

## Context

Flowpeek can now identify a project and a material static graph version, but a person or agent still needs a compact artifact that can be copied, interpreted, and checked for staleness. A graph node ID by itself is only a current-state key; it does not say which project or graph version supplied the evidence.

The first Context Card must remain local-first, bounded, and parser-evidence based. It must not turn a static graph into a runtime or business-intent claim.

## Decision

1. A Context Reference uses one of these local URI forms:

   ```text
   fp://local/<percent-encoded-project-id>/node/<percent-encoded-node-id>@<graph-version>
   fp://local/<percent-encoded-project-id>/flow/<percent-encoded-flow-id>@<graph-version>
   ```

2. The URI is an identifier, not a network location. Resolving it never makes a network request.
3. Current context kinds are raw `node` and bounded HTTP/request `flow`. Aggregate feature summaries, work records, and human-verification records use future kinds and schemas.
4. A node Context Card uses `flowpeek-context/v1`. It includes project/graph identity, extracted technical responsibility, bounded parser evidence, direct incoming/outgoing relations, related static flows/tests, limitations, human-description state, and safe navigation/recommendation actions.
5. A Context Packet uses `flowpeek-context-packet/v1` and is available as JSON or Markdown. It excludes source-file bodies, secrets, shell commands, credentials, deployment actions, and hidden model state.
6. A flow Context Card uses `flowpeek-context/v1` with `kind: flow`. It packages one bounded `flowpeek-flow-lens/v1` projection, direct related-test evidence, truncation, limitations, unresolved questions, and safe actions. Its title and technical summary are derived static descriptions, not business purpose.
7. Resolver states are explicit:

   - `current`: same project/version and referenced context exists;
   - `stale`: the referenced node or flow still exists but the ref version is older;
   - `historical`: a retained adjacent delta proves that the node or flow was removed, but no full old card is reconstructed;
   - `successor-candidate`: an adjacent delta removed a node and added exactly one node with the same source path, kind, and type; this node-only result is a suggestion;
   - `unresolved`: malformed, wrong-project, future-version, unsupported-kind, missing-node, or insufficient retained history.

8. A resolver never silently redirects a `successor-candidate` to the candidate. Flow refs do not infer successors. Viewer navigation opens only `current` or `stale` cards.
9. Viewer and MCP use the same graph-service card and resolver functions. The viewer can copy node/flow refs and JSON/Markdown packets, then paste either ref for resolution. MCP exposes `get_context_card`, `get_flow_context_card`, and `resolve_context_ref` as read-only tools.

## Explicit limits

- Retained adjacent deltas are not full historical graph snapshots. `historical` establishes removal evidence, not a reconstructed old Context Card.
- A removed flow may return the bounded Flow Lens snapshot already captured in its adjacent comparison. That snapshot is not a full historical Flow Context Card.
- Successor candidates are a conservative path/type heuristic, not refactor proof or verified continuity.
- Existing local node descriptions have no verifier, timestamp, owner, risk, or supersession lifecycle. Bounded HTTP/request flow cards may expose a separate immutable local verification record defined by ADR-004; node descriptions remain unattributed notes.
- Context Cards are static technical evidence. They do not prove runtime execution, test success, business purpose, or approval.

## Consequences

- A human and an agent can hand off a bounded, graph-versioned node or flow context without sending source contents through Flowpeek.
- Agents can detect stale context before relying on a prior node or flow reference.
- Verified-card lifecycle, broader continuity policy, and Delivery Graph records remain separate roadmap work.
