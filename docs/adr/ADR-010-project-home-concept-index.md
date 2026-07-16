# ADR-010: Human-first Project Home and deterministic concept index

## Status

Accepted for Iteration 18.

## Decision

Flowpeek provides one versioned Project Home projection for a person inheriting a repository. It composes Handoff Workspace knowledge with current graph facts and the latest retained adjacent delta. The projection keeps human-authored statements, parser facts, deterministic inference, verification, runtime evidence, stale state, and unavailable knowledge visibly distinct.

Project purpose, architecture, critical-flow selection, unresolved questions, and preferred starting points are human knowledge. When they have not been recorded, Flowpeek reports them as unavailable. It may provide a deterministic evidence-linked feature fallback for orientation, but it must not relabel that fallback as human advice or business intent.

Documentation readiness measures the completeness and freshness of recorded handoff fields. It is not code quality, delivery readiness, runtime correctness, or project health.

## Bounded navigation

Feature cards, recently changed flows, starting points, and concept results carry current Context Refs. Viewer navigation resolves those refs through the same resolver used by copied Context Cards. Every bounded list reports its full count, returned count, omitted IDs, and truncation reason rather than silently hiding entries.

## Concept index

The first concept vocabulary is deliberately fixed to authentication, payments, invitation, reconciliation, and notifications. Matching is deterministic, token-based, and limited to application-scoped node metadata and current flow metadata. Every result identifies the matched normalized term and field. It is semantic retrieval over known labels, features, domains, paths, and titles—not a source-body search, trained model, business-process claim, or runtime observation.

Adding concepts or synonyms changes a public deterministic contract and requires fixtures. Unknown concepts return an explicit unavailable result rather than fuzzy guesses.

## Consequences

- A new developer receives one bounded entry point instead of an unprioritized graph.
- Missing project knowledge becomes an actionable handoff gap instead of synthetic prose.
- Human statements remain portable through the Handoff Workspace and are never overwritten by graph refresh.
- Exact evidence remains one navigation action away without exposing source-file bodies through the Project Home API.
