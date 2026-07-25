# ADR-002: monotonic static graph versions and adjacent deltas

## Status

Accepted and implemented.

## Context

`projectId` identifies the local project context, but it cannot tell a person or coding agent whether two reads used the same technical graph. `generatedAt` is only scan timing: it changes during a no-op scan and therefore cannot detect stale context.

Flowpeek needs a local, deterministic state identity that is useful to the viewer, CLI, HTTP API, and MCP without claiming runtime execution, semantic intent, or a full source-history system.

## Decision

1. The serialized graph format is schema v5. Every graph has a `state` object with `graphVersion`, material/source fingerprints, source revision, update time, and state status.
2. `graphVersion` is a non-negative monotonic integer scoped to `projectId`. It is not comparable across projects.
3. A material fingerprint is computed from deterministic static graph evidence, repository identity, source-content fingerprint, source revision, analysis coverage, nodes, edges, flows, and diagnostic flows. Transient refresh/cache fields are excluded.
4. A no-op refresh retains the prior graph version when the material fingerprint is unchanged.
5. A source-content or source-revision change advances the version even when node membership, edges, and flows are unchanged. Its delta must say `sourceChanged: true` and `topologyChanged: false`.
6. A version advance creates an adjacent delta using the exact form `vN -> vN+1`. The delta contains changed paths, incremental-refresh work, node/edge/flow additions-removals-metadata changes, coverage change, affected technical nodes, truncation, and explicit limitations.
7. Adjacent deltas are retained locally until an explicit history-prune operation is requested. The history-prune preview defaults to retaining the newest eight validated deltas within a 16 MiB delta-history budget, always protects the latest adjacent delta, and never selects malformed or unknown files. Applying the preview requires explicit `--apply`; Flowpeek does not silently prune delta history during a scan.
8. `.flowpeek/graph.json` is the authoritative current graph. `.flowpeek/state.json` mirrors the durable version record so a valid graph cache can recover version state after an interrupted companion write. Every file is individually written with the existing same-directory temporary-file and atomic-replace protocol; the set of files is not a cross-file filesystem transaction.
9. Cache consumers that know the active `projectId` must validate it as well as the repository root. A matching root with another project ID is invalid cache state, not a usable graph.
10. Viewer and MCP return both project identity and graph state. MCP clients can request the retained current delta or one exact adjacent pair through `get_graph_delta`.

## Explicit non-claims

- A graph version is not a Git commit, source diff, runtime trace, deployment version, or business-flow version.
- A delta does not prove a function executed, a test passed, or an agent understood the change.
- `affectedNodes` are static technical candidates. Context Cards and changed Context Cards are not implemented by this ADR.
- An old version cannot be resolved to an arbitrary historical graph merely because an adjacent delta was retained; Git snapshots remain a separate feature. A removed Context Ref whose needed history predates retained delta evidence is explicitly `expired`, never silently substituted with current context.

## Failure and recovery behavior

- Invalid input graph payloads are rejected before state or delta persistence.
- A failed cache replacement preserves the prior cache and reports an error.
- If a later companion metadata write is interrupted after `graph.json` is replaced, the next refresh derives the last valid version from the graph cache and repairs state. A missing delta remains explicit rather than fabricated.
- Orphaned, malformed, or unknown delta files are never returned as the current delta and are not selected for pruning.
- A history prune stages selected validated deltas behind an atomic journal. A later explicit prune rolls a prepared interruption back or completes a committed interruption; the current graph and state remain outside that operation.

## Consequences

- The local viewer can identify its displayed graph and explain the latest persisted change without flattening a whole repository into a canvas.
- Coding agents can retain `{ projectId, graphVersion }`, refresh after edits, and request a bounded deterministic delta instead of trusting an in-process timestamp.
- Schema v4 caches migrate to v5 as unversioned evidence (`graphVersion: 0`). The first persisted v5 refresh establishes a material version.
- Future Context Cards, portable references, workflow records, and human verification must reference `projectId` and `graphVersion`; they must not rely on `generatedAt`.
