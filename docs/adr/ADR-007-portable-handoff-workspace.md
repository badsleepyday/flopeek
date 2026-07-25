# ADR-007: Portable Handoff Workspace

## Status

Accepted for Iteration 16.

## Decision

Flowpeek stores project handoff knowledge as immutable workspace versions. Creating a new version supersedes the current version without overwriting history. A workspace can contain project purpose, architecture summary, critical flows, owners, risks, important decisions, known limitations, unresolved questions, related tests, and recommended starting points.

Every human statement records author, timestamp, graph version, `human-authored` evidence class, and any supporting Context Refs. Selected flows and tests retain separate `static-parser-fact` records. Runtime evidence remains an unavailable, separately classified section unless a future opt-in sanitized runtime store is attached.

Human notes are stored in a separate append-only log. A note can supersede one active note for the same workspace and subject; it cannot edit the prior body or fork an already superseded note.

## Portability

JSON exports carry a content hash over the complete portable payload. Markdown exports are human-readable and embed the exact hashed JSON packet as Base64 for deterministic re-import. Neither format contains repository roots or source-file bodies.

Every import is stored as a separate artifact and manifest with `read-only`, `foreign-unverified`, and `not-adopted` state. This remains true even when the origin project ID matches the current local project. Import never mutates the local current workspace, graph, source, or verification records.

## Input safety

Human text is bounded and single-line. Flowpeek rejects machine-specific paths, common credential/private-key patterns, code fences, NUL bytes, and clear source-declaration syntax. This is a strict input guard, not a claim that arbitrary text can be proven secret-free; the product itself never reads source bodies into handoff statements.

## Consequences

- `get_handoff_context` includes the current local workspace when it fits the declared budget.
- Local HTTP APIs provide workspace versioning, notes, JSON/Markdown export, and foreign read-only import.
- MCP keeps one preferred read surface, `get_handoff_context`; no overlapping handoff mutation tools are added.
