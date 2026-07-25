# ADR-006: Token-budgeted handoff context

## Status

Accepted for Iteration 15.

## Decision

Flopeek exposes one preferred agent composition surface, `get_handoff_context`, over its lower-level graph and Brief APIs. Inputs are task intent, repository-relative changed paths, an optional target feature or flow, a declared budget, and desired evidence depth.

The result is deterministic for the same graph and normalized input. It is ordered as project summary, exact changed-path anchors at the smallest supported graph node boundary, relevance-ranked features, affected flows, tests, evidence refs, and the latest relevant adjacent delta. Exact caller-supplied paths take priority over generic evidence-depth caps; the validated input maximum and declared packet budget remain the bounds. Zero-relevance features and flows are omitted. A same-feature test is included only when it has a direct static edge to the selected flow or positive task-token overlap; feature membership alone is not relevance evidence. Every packet reports confidence, included and omitted counts, omitted IDs when they fit, reasons when ID lists are themselves truncated, risks, and next safe inspection steps.

## Budget estimator

This package does not bundle a model tokenizer. It therefore uses the explicit `flopeek-char4-estimator/v1` fallback: JavaScript string character count divided by four and rounded up. The packet reports the estimator ID, character-count method, character budget, estimated characters, and estimated tokens. It never labels that estimate as an exact model token count.

The minimum accepted budget is 1,024 estimated tokens. Selection and omission metadata are trimmed deterministically until the serialized JSON fits the corresponding character envelope. The project provenance envelope remains mandatory; smaller requests are rejected rather than silently returning unbounded or incomplete metadata.

## Trust and security

The composition surface is source-read-only. It returns repository-relative paths and versioned Context Refs, but no source bodies, secrets, absolute machine paths, credentials, shell access, or private reasoning. Confidence is derived only from exact targets, changed-path matches, deterministic token overlap, handler-specific static evidence, and explicit truncation/contamination signals. Runtime behavior remains unclaimed unless a separate opt-in runtime evidence source is introduced.

## Consequences

- Agents can start with `summary`, expand to `standard`, then request `evidence` without receiving the entire graph.
- Lower-level MCP tools remain available for compatibility and progressive inspection; `get_handoff_context` is the preferred task entry point.
- A future tokenizer adapter may add a model-bound estimator ID, but it must preserve deterministic budget and disclosure semantics.
