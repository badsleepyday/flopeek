# ADR-025: Canonical node and edge identity v2

Status: accepted

## Context

The v1 public graph deliberately uses readable JavaScript-compatible IDs such
as `file:src/orders.ts` and
`symbol:src/orders.ts:function:submit`. Native graph assembly interns those IDs
and uses dense `u32` endpoints, while SQLite uses integer primary keys for local
joins. A separate BLAKE3 `node:v1` candidate currently covers only
`kind/path/symbol/signature` and is written only for file inventory rows.

Those mechanisms serve compatibility, memory layout, and cache lookup, but they
do not provide one persistent source-entity identity. A path or symbol rename
changes the v1 public ID. Duplicate declaration spellings can collapse into one
node. An edge is keyed only by source, target, and relation, so multiple parser
evidence occurrences can collapse into one relationship.

ADR-024 keeps the v1 public graph and `flopeek-core-compatibility/v1`
authoritative during native rollout. Identity v2 therefore cannot replace v1
IDs in place.

## Decision

### Identity roles

Flopeek uses separate typed identities:

- `NodePk(i64)` is a database-local join key. It is never a durable Context Ref.
- `NodeUid(UUIDv7)` is a persistent entity identity inside one project identity
  store. Its SQLite representation is the 16 canonical UUID bytes.
- `SemanticHash([u8; 32])` is BLAKE3-256 over a versioned canonical semantic
  record. It is a deterministic reconciliation and collision-check candidate,
  not rename continuity by itself.
- `RevisionHash([u8; 32])` is SHA-256 over a versioned canonical node revision.
- `EdgeUid([u8; 32])` is BLAKE3-256 over project, source UID, relation, target
  UID, and a versioned qualifier.
- `EvidenceUid([u8; 32])` is BLAKE3-256 over an edge UID and one canonical parser
  evidence occurrence.

UUIDv7 continuity is local-store continuity. A fresh clone without the same
`.flopeek` identity store does not claim the same `node_uid`. Cross-clone
continuity requires a future explicit import/export manifest and user consent;
it is not inferred from matching repository content. This matches the local
scope of `fp://local`.

### Canonical encoding

Identity records use `flopeek-identity-canonical/v1`, encoded as bytes with:

1. an ASCII schema tag;
2. fields in a fixed contract order;
3. a length-prefixed field name;
4. an explicit missing/present marker;
5. a length-prefixed UTF-8 or binary value.

Text is Unicode NFC. Repository paths use `/`, preserve case, must be relative,
must not contain empty, `.` or `..` segments, and must not contain NUL. Canonical
records have bounded field sizes. Hash matches are never sufficient to merge:
the stored canonical bytes must also compare byte-for-byte. A digest match with
different canonical bytes is a fatal identity collision.

### Ownership and relationships

A source entity has at most one canonical lexical owner at one revision. Owner
changes are revision history. General incoming relationships (`calls`, `uses`,
`handles`, `schedules`, and similar) remain edges and may have zero, one, or
many sources.

Parent sets are never encoded into `node_uid`. Display lineages such as `1/9`
are derived placement addresses only. Semantic hierarchy summaries remain
versioned projections and are not source entities.

### Revision history

Node revisions are change-only immutable records. An unchanged node does not
receive a row for every graph version. Open validity intervals are closed only
when the revision changes or the node becomes a tombstone. Lexical owner is
stored with the revision so owner moves remain auditable.

### Edge occurrences

One relationship row represents the semantic source/relation/target tuple.
Every distinct parser callsite or declaration occurrence is stored separately
as edge evidence. Public graph v1 may continue to expose one compatibility edge
while v2 retains occurrence multiplicity.

### Aliases

Legacy/public IDs are versioned external identifiers. A confirmed rename that
retains the same `node_uid` adds an external-ID history row; it does not add a
UID alias. UID aliases are reserved for explicit merge/reconciliation between
different entity UIDs. Automatic low-confidence redirects, alias cycles, and
multi-hop chains are forbidden.

### Compatibility and rollout

Schema v11 is additive and dual-written in the same graph-promotion transaction.
The v1 public graph, ordering, IDs, Context Refs, and compatibility digest remain
unchanged. Context Ref v2 and identity-aware query surfaces require separate
versioned contracts and parity fixtures before activation.

The first v11 slice may reconcile exact legacy IDs, exact semantic records, and
unique exact file-content moves. Symbol rename continuity requires parser-owned
qualified owners, signatures, and structural fingerprints and must abstain when
ambiguous.

## Consequences

- Fast SQLite and dense in-memory lookup no longer masquerade as durable
  identity.
- Renames can retain a local entity UID when evidence is unique and explicit.
- Multiple callsites can be retained without duplicating the relationship.
- v1 compatibility remains available throughout native rollout.
- The v11 store is larger, but change-only intervals avoid `nodes × versions`
  revision growth.
- Cross-clone identity remains explicitly unsupported until a consented
  identity manifest exists.

## Rejected alternatives

- Parent-derived IDs such as `1-2/9`: mutable parent sets would invalidate the
  child identity and create ordering, fan-in, and cycle problems.
- Unix timestamps as IDs: timestamps alone are not collision-safe.
- BLAKE3 semantic hashes as persistent entity IDs: rename and move inputs are
  intentionally mutable.
- Silent fuzzy rename matching: false continuity is worse than an explicit
  ambiguous successor.
- Replacing v1 public IDs during native rollout: this would invalidate the
  compatibility oracle that currently gates the migration.
