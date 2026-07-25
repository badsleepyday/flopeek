# ADR-015: Agent semantic proposals and verification-backed memory

Status: accepted and implemented for bounded local metadata.

## Decision

An AI provider or agent may append an immutable semantic proposal only for a current Flow Context Ref. The proposal has knowledge class `agent-proposed`; it can prefill human review or verification drafts but never replaces parser facts, deterministic suggestions, human feedback, or human verification.

Human verification requests carry the graph version and Flow Context Ref that were reviewed. Flopeek rejects stale drafts with a conflict. Reusable semantic memory is a bounded read index over `.flopeek/flow-verifications.json`; only current or compatible verification is reusable by default.

## Boundaries

- `.flopeek` stores metadata, not an LLM runtime or model weights.
- Provider rationale is concise declared metadata, not private reasoning or proof.
- A memory hit may prefill another draft but cannot auto-verify another flow.
- Stale proposals and verification remain visible for audit but are not applied automatically.
