# ADR-004: Immutable local human flow verification

## Status

Accepted.

## Context

Flowpeek can derive bounded Flow Lenses and portable Context Cards from supported static-entry parser evidence. A person needs to attach confirmed language to a flow without changing parser facts, silently treating a source edit as approved, or granting write authority to an agent.

The prior `.flowpeek/descriptions.json` mechanism stores mutable, unattributed text for individual nodes. It is useful as a local note, but it does not establish who confirmed a flow, which graph version they reviewed, whether static evidence has changed, or what earlier wording was replaced.

## Decision

1. Flow verification records are stored locally in `.flowpeek/flow-verifications.json` using `flowpeek-flow-verifications/v1`. The store is written with the same validated atomic-write primitive used for graph metadata.
2. Each record uses `flowpeek-flow-verification/v1` and contains a flow ID, versioned Context Ref, verified title and description, optional owner, risk, unresolved questions, verifier, timestamp, source graph version, bounded technical fingerprint, participating source paths, and an optional `supersedes` record ID.
3. Records are immutable. Creating a newer verification appends a new record and sets its `supersedes` field to the active record for that flow. The older record remains readable and has `lifecycleStatus: superseded` in history views.
4. Verification metadata never changes extracted nodes, edges, Flow Lens steps, parser confidence, or derived technical titles. Context Cards expose human metadata separately with `knowledgeClass: human-verified`.
5. The resolver reports one active record as `current`, `compatible`, `stale`, `detached`, `indeterminate`, `unverified`, or `unavailable`:
   - `current`: the record's graph version and technical fingerprint match the current Flow Lens.
   - `compatible`: every retained adjacent delta from the recorded version to the current version exists and proves that neither the flow nor its participating source paths changed.
   - `stale`: a retained delta shows a participating source-path or flow change, or the current technical fingerprint differs.
   - `detached`: the record remains, but the flow is absent from the current graph.
   - `indeterminate`: retained delta history is insufficient to prove compatibility.
   - `unverified`: no active record exists.
   - `unavailable`: the metadata store is malformed or belongs to another project identity.
6. The local viewer may create records through loopback HTTP. MCP remains read-only and exposes `get_flow_verification`; agents cannot create, replace, or approve verification records.
7. Verification records and Context Packets exclude source-file contents, credentials, runtime events, model reasoning, and claims of business-process correctness.

## Consequences

- Flowpeek can distinguish parser-derived static evidence from attributable human context.
- A local rescan cannot silently overwrite or upgrade a verification record.
- A source-only edit in a participating file becomes stale even when the visible topology is unchanged.
- Verification may become `indeterminate` after the bounded delta retention window; a person must review rather than Flowpeek guessing continuity.
- The feature covers bounded supported static-entry flows. A verification remains human-authored evidence and never proves command invocation, runtime behavior, business intent, or a broader SDLC work record. Node notes, issue/ADR synchronization, business-intent inference, and SDLC work records remain separate future work.
