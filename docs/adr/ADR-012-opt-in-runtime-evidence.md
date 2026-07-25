# ADR-012: Opt-in runtime evidence is separate from the static graph

## Status

Accepted for Iteration 20.

## Decision

Flopeek accepts runtime evidence only as an explicit local observation record bound to a node or flow Context Ref. It does not execute a probe, read an observability backend, capture logs, or infer runtime behavior. Each record declares a narrow kind, outcome, observed timestamp, concise summary, source label, and optional status/duration metadata.

The runtime store is separate from the scanner graph, derived cache, human verification, and handoff note stores. Recording an observation never creates a static edge, changes a parser fact, or promotes an inference/human note to verified knowledge.

## Sanitization and retention

Input is limited to single-line concise fields. It rejects source/log bodies, code-declaration patterns, credential-like strings, machine-specific paths, and invalid/future/foreign Context Refs. The local store retains at most 100 records. When retention evicts a record, Flopeek keeps a minimal immutable manifest containing identity, source fingerprint, graph version, evidence class, content hash, creation time, and `expired` status.

Briefs, agent context, and token-budgeted Handoff Context Packets expose only a bounded availability/freshness summary. They do not copy observation bodies into static graph facts.

## Consequences

- Runtime evidence is auditable but remains an independently classified source of knowledge.
- Old records are explainable after retention without retaining their observation text forever.
- Automatic integrations require a separate privacy, consent, sanitization, and retention decision; this ADR does not authorize them.
