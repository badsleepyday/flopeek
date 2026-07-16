# ADR-013: Portable human concept tags and ambiguous-alias abstention

## Status

Accepted for Iteration 21.

## Decision

Human concept tags are stored inside immutable Handoff Workspace versions as `{ subjectRef, tags }`. The subject must be a current-project node or flow Context Ref. Tags use the existing portable-text safety policy and are exported/imported with the workspace as human-authored knowledge; they do not alter parser facts or Flow Lens semantics.

The deterministic concept index reports every matching term and field. Supported fields are parser label/type, feature/domain, route metadata, repository-relative path, and optional `humanTag`. This lets people and agents audit why a result appeared without reading source bodies.

The taxonomy remains fixed and versioned. A canonical concept query is accepted. An alias that belongs to more than one concept returns `abstained` with the matching concepts and a reason, rather than merging candidate sets or guessing intent.

## Consequences

- Handoff authors can add domain vocabulary without promoting it to parser fact or verification.
- Unknown and ambiguous vocabulary remain explicit limitations.
- New aliases or concepts require fixtures and a compatibility review because they change deterministic retrieval behavior.
