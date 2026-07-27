# ADR-023: Rust native-wrapper baseline

Status: accepted

## Context

Flopeek needs a native migration path for large repositories without changing
the behavior of the JavaScript scanner, graph, Context References, MCP, or
published npm binary in one step.

## Decision

`native/flopeek-core` is a Rust binary that delegates ordinary CLI arguments to
the existing `src/cli.js` implementation. It adds two native-only bootstrap
capabilities:

- a deterministic BLAKE3 semantic-node identity candidate; and
- a WAL-backed SQLite store under `.flopeek/native-core.sqlite3` for project,
  scan, node, parser-fact, and alias metadata.

SQLite integer primary keys are internal join keys. The native BLAKE3 ID is not
yet emitted as a graph node ID or Context Reference. Existing JavaScript node
IDs and `flopeek-core-compatibility/v1` remain authoritative. The native crate
is excluded from the npm tarball until cross-platform native binary packaging
and parity promotion are separately approved.

## Consequences

- `main` JavaScript behavior remains unchanged.
- The Rust branch can dogfood a portable binary, storage schema, and identity
  rules on every CI operating system.
- Future native parser/cache work must compare against the JavaScript
  compatibility oracle before it is selected for production output.
- Parent/child or dependency relationships remain edges in SQLite; they are not
  encoded into mutable hierarchical node IDs.
