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

The first working native migration slice is a shadow-mode source inventory. It
uses the JavaScript scanner's registered-file, ignored-directory, and 1 MB file
boundary; BLAKE3 hashes only candidates whose size or modification timestamp has
changed, and records removals in SQLite. Its BLAKE3 inventory fingerprint is
native cache metadata, not the JavaScript graph fingerprint.

The inventory resolves project identity through the same contract as JavaScript:
an explicit `.flopeek/config.json` `projectId` wins; otherwise a generated UUID
is persisted in `.flopeek/project.json`. It also applies the JavaScript scope
contract for `sourceRoots`, test roots, fixture roots, generated-source markers,
and exclusions. The native process never edits a target repository's
`.gitignore`; Flopeek's existing repository policy leaves cache metadata ignored
while allowing an intentionally tracked `.flopeek/config.json`.

The first structural parser promoted into native shadow mode is Rust. It uses
`syn` and stores only a deterministic metadata projection of `use` declarations,
top-level types/functions, trait and implementation methods, and direct
identifier calls. Parser facts are keyed by project, relative path, BLAKE3 source
hash, and adapter version. JavaScript remains the graph and public-output oracle;
the native parser cannot replace it until compatibility tests and corpus evidence
approve that promotion.

Native Rust graph shadow output is compared with a normalized JavaScript graph
projection before a timing sample is accepted. The benchmark uses disposable
identical Rust corpus copies, symmetric unmeasured process warm-up, and reports
only cold command-envelope timings for the currently matched subset. It must not
be presented as a whole-product or warm-cache performance claim.

The next promoted shadow slice is the native incremental coordinator. Rust
creates a complete scoped source manifest and stores BLAKE3 content identities;
SQLite stores JavaScript parser-record metadata keyed to that identity. On a
subsequent process, the coordinator loads only records whose native content hash
still matches, supplies them to the unchanged JavaScript scanner, parses every
other candidate in JavaScript, and writes refreshed records back. Graph
assembly, public node IDs, Context Refs, and semantic parsing remain
JavaScript-owned. The coordinator is accepted only when its full
`flopeek-core-compatibility/v1` digest equals a normal JavaScript scan for each
benchmark state.

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
- Cold, unchanged, and one-file-change benchmarks include native process
  startup, SQLite reads/writes, JavaScript graph assembly, and independent
  disposable source copies. A mismatch rejects the timing sample.
- Native inventory parity compares candidate path sets, configured scope, and
  project-identity precedence with JavaScript in tests; it does not claim parser,
  graph, or runtime parity.
- Parent/child or dependency relationships remain edges in SQLite; they are not
  encoded into mutable hierarchical node IDs.
