# ADR-005: Durable layered Briefs

## Status

Accepted for Iteration 14.

## Decision

Flowpeek exposes four versioned Brief kinds: Project, Feature, Flow, and Node. A Brief is a portable derived artifact, not a new source of truth.

Every Brief carries:

- `projectIdentity`;
- `sourceBasis`, using a full clean Git revision only when cleanliness is known, otherwise a working-tree source fingerprint;
- `graphVersion`;
- the Brief-level `evidenceClass`;
- `freshnessStatus`;
- a content hash and versioned Brief reference.

Every Brief keeps five evidence sections separate:

1. static parser facts;
2. deterministic inference;
3. human-authored notes;
4. human verification records;
5. opt-in runtime evidence.

The Brief itself has an evidence ceiling of `deterministic-inference`. Persistence, age, repeated use, human feedback, or inclusion in a handoff never upgrades derived evidence. Verification and runtime evidence retain their own section-level classes.

Free-form bodies from legacy descriptions, feedback reasons, and verification descriptions are not copied into durable Brief artifacts. Until the sanitized append-only note contract exists, the Brief retains only safe attribution and lifecycle metadata for those records.

## Manifest and retention

Materialized Brief artifacts are stored separately from an append-only minimal manifest. A manifest retains identity, source basis, graph version, schemas, hash, evidence class, creation time, and the repository-relative artifact locator.

Artifact retention is allowed to evict heavy JSON. The manifest remains and resolution reports the result explicitly as `current`, `stale`, `expired`, or `unavailable`. Flowpeek never silently substitutes current context for an expired historical Brief.

## Portability and security

Briefs contain repository-relative evidence paths but exclude repository roots, source-file bodies, credentials, secrets, shell access, and private model reasoning. Project roots are used internally only to read local stores.

Cross-project import is deferred to the Handoff Workspace contract. A foreign project identity must never become current or verified automatically.

## Consequences

- Context Cards remain supported, while Briefs become the durable composition layer for later Context Packets and handoff workspaces.
- `get_handoff_context` will compose Briefs in Iteration 15 rather than adding multiple overlapping MCP tools.
- Runtime evidence remains unavailable until a separate opt-in sanitized store and retention policy are implemented.
