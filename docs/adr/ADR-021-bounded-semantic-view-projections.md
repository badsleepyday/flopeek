# ADR-021: Bounded semantic view projections

**Status:** Accepted  
**Date:** 2026-07-22

## Context

An unbounded repository graph is not a readable Viewer surface or a safe agent
context. Earlier projections could slice a dependency neighborhood without
reporting what was omitted. That makes a partial technical map look complete.

## Decision

- Every Viewer, HTTP, CLI, and MCP map response uses
  `flopeek-view-projection/v2`.
- A projection is bound to one project identity, graph version, and source
  fingerprint. It is static evidence, not runtime order or business intent.
- The default display ceiling is 40 nodes and 80 edges. Callers can request a
  smaller limit; hard ceilings are 100 nodes and 200 edges.
- Each response reports total, eligible, returned, and omitted node/edge
  counts, bounded omission samples, and an explicit truncation warning.
- A focused dependency map prioritizes its selected factual node. Edges whose
  endpoints were omitted are reported separately rather than silently drawn.
- Context Refs and Flow Lens remain separate artifacts. A view projection is
  not a Context Card and cannot be used as proof that all repository evidence
  was inspected.
- Semantic hierarchy is added only through deterministic grouping and is
  separately versioned in later work; this decision establishes the shared
  bounded contract first.

## Consequences

People and agents can tell whether a map is complete for its selected bounded
scope. Larger repositories require focus, scope, Flow Lens, or later semantic
zoom rather than a larger unbounded canvas. The contract preserves factual
evidence boundaries while giving every surface the same omission semantics.
