# ADR-008: Auditable derived artifact cache

## Status

Accepted for Iteration 17.

## Decision

Flopeek stores derived artifacts separately from the current graph, adjacent deltas, immutable Git-revision snapshots, durable Briefs, semantic feedback, and human handoff metadata. The derived registry currently covers feature summaries, Flow Projections, semantic suggestions, impact indexes, and token-budgeted Context Packets.

Each immutable artifact record carries project identity, source basis, graph version, source fingerprint, logical key hash, dependency paths, value hash, creation time, and a repository-relative artifact locator. The registry retains bounded hit, miss, invalidated, and retained-unaffected events.

## Reuse and invalidation

An artifact is a cache hit only when project identity, graph version, source fingerprint, and artifact integrity all match. A stale artifact is never silently promoted to current. Version-bound Context Refs make this stricter than source compatibility alone.

On refresh, changed paths invalidate only records whose declared dependencies intersect. A graph topology change invalidates derived projections conservatively because a new or removed relationship can affect a result without appearing in the prior dependency set. Unaffected artifacts remain retained and auditable, but version-bound values are recomputed before being served for a newer graph.

Invalid or corrupted registry metadata is reported unavailable and never overwritten. Flopeek computes an uncached fresh result so project inspection remains available without trusting the bad cache.

## Visibility

`GET /api/cache-artifacts`, MCP `get_agent_context`, and the viewer parser-coverage panel expose source basis, graph version, artifact freshness, hit/miss counts, invalidation outcomes, latest reasons, and the no-silent-stale-reuse policy.

## Consequences

- Cache mutation remains local under `.flopeek/cache/` and never writes repository source.
- Cache hits accelerate repeated exact-version requests without changing response evidence.
- Retention may later evict heavy artifacts while preserving minimal registry provenance and explicit `expired` state.
