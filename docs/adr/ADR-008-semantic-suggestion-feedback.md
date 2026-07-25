# ADR-008: Immutable semantic suggestion feedback

## Status

Accepted.

## Context

The deterministic semantic suggestion layer can offer conservative titles, technical purpose, role, and grouping, but it cannot establish business truth. Reviewers need a local way to retain whether a specific suggestion was accepted, edited, rejected, or abstained from without changing parser facts, source code, or flow verification.

## Decision

`src/semantic-suggestion-feedback.js` stores append-only `flopeek-semantic-suggestion-feedback/v1` records in `.flopeek/semantic-suggestion-feedback.json`. A record snapshots only the server-calculated suggestion's bounded fields, evidence references, Context Ref, graph version, and fingerprint. It is idempotent by operation ID and supersedes, rather than overwrites, the earlier feedback for the same flow.

`accepted`, `edited`, `rejected`, and `abstained` are allowed only when compatible with the current suggestion status. Edited, rejected, and abstained labels require a concise reason; edited labels require a complete replacement candidate. An optional evidence-trace link is accepted only if its Context Ref exactly matches the suggestion flow Context Ref.

The API, MCP server, Flow Lens, and Flow Context Card expose the resolved feedback lifecycle and bounded history. Feedback has `human-feedback` knowledge class and never creates or upgrades `human-verified` flow verification. A stale label is visible but is never applied to a changed suggestion automatically.

## Consequences

Flopeek can now create an auditable local review loop for deterministic suggestions. The synthetic metric contract verifies storage/reporting arithmetic only. It is not a human dataset, model-training corpus, candidate-quality benchmark, calibration result, or evidence of business-process correctness. Any external evaluation or training requires separately consented, reviewed data with a held-out split.
