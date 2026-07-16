# ADR-009: Private human-review recommendation gate

## Status

Accepted.

## Context

Immutable semantic feedback makes individual local labels auditable, but it does not establish whether suggestions are useful across repositories. A recommendation claim needs a held-out human-review cohort while keeping repository content and private reviewer discussion outside Flowpeek's metadata boundary.

## Decision

`src/semantic-suggestion-reviewed-evaluation.js` accepts only a separately supplied `flowpeek-semantic-suggestion-reviewed-dataset/v1` file. The dataset must declare consent, must be explicitly marked non-template, and can contain only opaque identifiers, split, suggestion status, decision, abstention verdict, and optional trace verification status. Unknown fields are rejected. Paths, URLs, source content, prompts, credentials, raw logs, candidate prose, and reviewer discussion are not schema fields.

The gate evaluates held-out cases only. It requires at least 20 cases across three repository aliases and two reviewer pseudonyms, plus minimum suggestion/abstention sample sizes and explicit usefulness, rejection, abstention, trace-link, and passed-trace thresholds. The command exits non-zero with `--require-gate` when any condition fails.

## Consequences

Flowpeek has a reproducible way to decide whether a real local review cohort is strong enough to support a limited recommendation claim. The checked-in JSON template and in-test data cannot qualify as human evidence. The evaluator cannot prove that a pseudonym identifies a human, that a test is complete, or that the result generalizes outside the cohort; those remain review-process responsibilities documented in `docs/human-review-and-verification.md`.
