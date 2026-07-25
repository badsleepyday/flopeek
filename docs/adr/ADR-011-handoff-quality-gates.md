# ADR-011: Reproducible handoff quality gates

## Status

Accepted for Iteration 19.

## Decision

Flopeek evaluates handoff quality from explicit, versioned benchmark cases rather than an opaque product score. The committed legacy fixture combines ambiguous `manager`/`helper` naming, two HTTP handlers in one route file, indirect static calls, a cross-feature notification path, and related tests. Its parser relationships remain part of the existing precision/recall corpus.

`flopeek-handoff-quality/v1` reports, per case:

- deterministic inspection stages needed to reach the declared target;
- observed Context Packet composition time, as non-gating host-specific evidence;
- declared token budget, estimator, characters, estimated tokens, and compliance;
- current/stale/historical Context Ref resolution outcomes;
- expected feature/flow retrieval against a deterministic fixture oracle;
- agent task outcome as supplied human/runtime evidence with a resolvable ref, agent-declared metadata, or unavailable.

## Gate policy

The deterministic gate passes only when every declared target is retrieved, every packet remains within budget, every returned evidence ref resolves, and every supplied stale ref is detected. Wall-clock timing is never a threshold because host performance varies.

Fixture retrieval success is not an AI coding-task result. An agent-declared pass remains audit metadata, not independent proof. Supplied human/runtime evidence requires a resolvable Context Ref, but ref resolution proves evidence identity rather than task correctness. Flopeek does not infer task success from context retrieval, test names, or source topology, and does not claim runtime behavior unless runtime evidence is supplied explicitly.

## Portability and safety

Benchmark definitions contain repository-relative paths and Context Packet inputs only. Reports contain source basis and versioned refs, not source-file bodies, secrets, shell output, private reasoning, or machine-specific absolute paths. The local API evaluates caller-supplied cases without executing repository code.

## Consequences

- Handoff claims can be compared over time with explicit dimensions and trust classes.
- Parser correctness, retrieval quality, and real agent outcomes remain separate measurements.
- Reaching 100% product recommendation still requires opt-in results from real developers and agents, not only the synthetic fixture gate.
