# ADR-017: Explicit workspace contract references

Status: accepted and implemented for local human-authored declarations.

## Decision

The central workspace hub may store an explicit `http-contract` reference between two Flow Lenses from different active projects. Creation requires each project's current graph version and Flow Context Ref. The stored snapshot includes only project/flow identity, versioned Context Ref, title, optional endpoint method/route, concise declared relationship, author, and timestamp.

References are machine-local workspace metadata outside scanned repositories. They are idempotent by operation ID, append-only, strictly schema-validated, and never contain source bodies, logs, credentials, or machine paths. Human text is rejected before whitespace normalization when it contains line breaks, source-like declarations, credential-like values, or machine paths, so multiline fragments cannot be transformed into apparently safe metadata. A reference is `current` only while both snapshots still match their current Flow Lenses; otherwise it is `stale` or `unavailable`.

## Boundaries

- A reference is human-authored metadata, not a parser fact, graph edge, runtime trace, verification, or automatic multi-project flow.
- Equal names, routes, and symbols never create a reference.
- The hub keeps project graphs, graph versions, watchers, and `.flowpeek` caches isolated.
- The viewer can declare and inspect a reference from one Flow Lens to another active project; it does not execute calls or tests.
- Target Flow Lenses are exposed through deterministic catalog pages with total, returned, omitted IDs, and previous/next offsets, so a large target project never silently hides a selectable flow.

## Consequences

Microservice handoff can record an auditable intended service boundary without pretending that static scanning proved an inter-process request. Future work may compose only explicitly declared/current references after a separate cross-service evidence and runtime-validation design.
