# Flopeek native-core bootstrap

This crate is the first native boundary for Flopeek. It is intentionally a Rust
wrapper around the existing JavaScript CLI, so normal commands retain the
JavaScript scanner, graph, Context Ref, and compatibility semantics.

```powershell
cargo test --manifest-path native/flopeek-core/Cargo.toml --locked
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --version
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-status .
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-inventory .
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-facts .
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-js-facts .
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-graph .
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-incremental-scan .
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-serve
```

`--native-status` initializes `.flopeek/native-core.sqlite3` with a WAL-backed
schema for future project, scan, node, parser-fact, and alias metadata. The
store contains no target source bodies. Native BLAKE3 node IDs are internal
candidate identities only; public graph IDs and Context Refs remain JavaScript
compatible until the core-compatibility oracle promotes a native projection.

`--native-inventory` is shadow-mode only. It walks the same bounded registered
source-file candidate set as the JavaScript scanner, hashes changed files with
BLAKE3, and reuses unchanged SQLite entries when byte size and modification time
match. It does not emit parser facts, graph nodes, or Context Refs publicly.
`--native-inventory-paths` is a test/debug variant that additionally emits its
candidate paths for exact parity comparison.
The normal output also reports deterministic counts for application, test,
fixture, generated, and excluded registered source files.

The native inventory uses `.flopeek/config.json` with the same scope and
identity precedence as the JavaScript implementation. A configured `projectId`
wins; otherwise it creates and reuses `.flopeek/project.json`. Cache data stays
under `.flopeek/native-core.sqlite3`. The binary does not change a target
repository's `.gitignore`: commit configuration only when the project chooses
to share it, and keep generated identity/cache data local under Flopeek's
standard ignore policy.

For an existing Git repository that has no Flopeek policy yet, add this exact
rule to its `.gitignore`; it keeps generated identity and SQLite cache local
while leaving deliberate scope configuration trackable:

```gitignore
.flopeek/*
!.flopeek/
!.flopeek/config.json
```

`--native-rust-facts` is the first real native parser, still in shadow mode. It
uses `syn` to cache Rust `use` declarations, top-level types/functions, impl and
trait methods, and direct identifier calls. The cache key is the file's BLAKE3
content hash plus `native-rust-syn/v1`; only metadata projections are persisted,
never source bodies. Its output is explicitly not a public graph projection.

`--native-js-facts` is now a Rust-owned JavaScript/TypeScript parser, resolver,
and per-record `StructuralFactBatch` candidate. Its versioned Tree-sitter facts
carry ordered evidence, symbols/methods, supported direct calls, HTTP/request
facts, Next route handlers, node-cron schedules, internal/external resolution,
public-compatible SHA-256 source hashes, source scope, and file metadata. The
mandatory `npm run verify:native-js-parser-parity` gate currently proves exact
parser, resolver, and record projection output for all 22 JS/TS files in the
eleven-case baseline. This remains a bounded corpus result: full framework
capability coverage, the complete batch envelope/digest, other adapters, and
end-to-end native authority are not yet proven. BLAKE3 remains only the native
inventory/cache identity. Each semantic parser change bumps its adapter version
so stale cached facts cannot be compared as new evidence.

`--native-rust-graph` assembles a deliberately narrow comparable projection:
Rust file/type/function IDs plus `contains`, resolved internal `imports`,
external import, and direct-call edges. Run `cargo build --release` followed by
`npm run benchmark:native-rust-shadow -- --iterations 7` to compare this exact
projection against JavaScript. The benchmark rejects any node-ID or edge mismatch
before reporting timings.

`--native-incremental-scan` is the first cross-language native migration path.
Rust owns the bounded file inventory and BLAKE3 change detection, then SQLite
stores JavaScript parser-record metadata (never source bodies). For a bounded
changed-file set, the same JSONL manifest may carry `sourceBatch` UTF-8 text
once to the JavaScript parser so cold scans do not reread those files. That
batch is in-memory only, is consumed once, has a 32 MiB aggregate ceiling, and
is accepted only when its size and nanosecond modification stamp still match
the file at parser time; otherwise JavaScript rereads the current file. It is
never accepted by `StructuralFactBatch/v1`, SQLite, or the JS record cache.
The JavaScript scanner receives current candidate paths plus valid unchanged
records, parses changed files, and still assembles the public graph. Its result exposes a
`flopeek-core-compatibility/v1` digest for exact static-fact comparison.
The coordinator opens one `flopeek-native-protocol/v1` JSONL session per scan
and sends the manifest, record-load, and record-store requests through that
single request-ID channel; it does not launch three native processes for those
steps. The session closes after the scan, so this is not a cross-command daemon
or a native-default cutover.

The async scan coordinator exposes the migration mode through
`FLOPEEK_CORE=js|shadow|native`. `js` remains the default. `shadow` is an
explicit cache-enabled, unbounded dogfood path: it uses the one JSONL session
above, reuses that coordinator-owned session across refreshes, and reports the
transport plus changed/reused counts in the scan outcome, but returns the
JavaScript graph. It is deliberately skipped for `--no-cache` and bounded scans
so those modes never create native SQLite state. `native` currently reports an
explicit JavaScript rollback until the rollout gate passes and a native public
core exists; it is not an alias for shadow mode.

End-to-end performance measurement is intentionally blocked while JavaScript
remains anywhere on the production parser/resolver/fact path. The command below
is retained for the later post-parity gate only; current wrapper timings cannot
qualify native rollout:

```powershell
cargo build --release --manifest-path native/flopeek-core/Cargo.toml
$env:FLOPEEK_NATIVE_CORE = (Resolve-Path native/flopeek-core/target/release/flopeek-native-core.exe)
npm run benchmark:native-incremental -- --root .\repo-a --root .\repo-b --iterations 3
```

Do not use that result until `flopeek-native-backend-parity/v1` proves Rust owns
discovery, every promoted parser and resolver, `StructuralFactBatch`, graph, and
core queries, with JavaScript restricted to CI oracle and rollback.

`--native-serve` is the persistent `flopeek-native-protocol/v1` JSON Lines
bootstrap. Each request has a request ID and emits one typed response on stdout;
diagnostics remain on stderr. The protocol includes `health`, `initialize`,
`nativeIncrementalManifest`, `nativeJsRecordCache`, `submitStructuralFacts`,
`assembleStructuralGraph`, the shadow query methods, `persistStructuralGraph`,
and `shutdown`.
`submitStructuralFacts` accepts only
`flopeek-structural-fact-batch/v1` records from the JavaScript adapter host. It
rejects source-body fields, invalid paths, invalid SHA-256 file hashes, and a
batch whose SHA-256 digest does not equal its canonical payload. It is validated
transport input (`stored: false`), not public graph promotion or output.
`assembleStructuralGraph` is an equally non-authoritative shadow subset
for file/symbol/endpoint/runtime IDs and local structural edges (including
resolved internal imports, imported direct calls, external dependencies, and
supported command/schedule entries). `ShadowCoreClient` compares that topology
and edge/node metadata exactly against JavaScript and reports its first
deterministic mismatch; it is not a claim of the full compatibility projection.
Its node and edge canonical order is produced by Rust from the assembled IDs and
edge keys; the adapter does not send a JavaScript graph topology order. The
audited ordering subset is portable ASCII public IDs and paths. Non-ASCII
`localeCompare` parity requires an explicit ICU-backed contract and fixtures
before it can be promoted.
Native Flow, Flow Lens, Context Card, related-test, and impact shadows derive
their traversal sequence from `StructuralFactBatch/v1` construction phases
(integrations/symbols, imports/endpoints, calls/runtime, requests, then entry
facts). The adapter sends neither topology nor a JavaScript traversal-order
list. JavaScript remains the exact CI oracle; native default stays gated on
broader corpus and non-ASCII evidence.
`persistStructuralGraph` is a dogfood-only opt-in used after that exact shadow
comparison. It writes only the native structural projection through the
recoverable SQLite building/complete lifecycle and reuses an unchanged
structural-facts fingerprint. It neither changes public output nor proves full
core-query or Context Ref parity.
`getRelatedTests` is the first native query shadow: it calculates direct parser
relationships to test files from the native structural projection and is checked
against JavaScript's JSON-serializable query contract across the compatibility
corpus. It is available only through the explicit shadow client helper and does
not yet replace the synchronous public CoreClient query.
`getChangeImpact` is the second query shadow. It matches JavaScript's
current-graph static dependent/dependency traversal, endpoint/test selection,
ordering, bounds, and optional-field serialization on the same corpus. It also
matches deleted-file recovery when an explicit preceding StructuralFactBatch is
provided, or when a complete preceding native SQLite graph version is selected.
The latter re-verifies the persisted projection digest before treating it as a
historical baseline; it remains shadow-only until the CoreClient promotion gate.
The same shadow boundary now has exact compatibility fixtures for native Flow
Lens, node and flow Context Cards, current/stale/historical/expired Context Ref
resolution, public graph snapshot/delta retrieval, and changed-context queries.
These paths are deliberately not public CoreClient defaults: JavaScript remains
the authoritative public projection until every query, persistence, fallback,
and performance cutover gate is measured. Native delta retention is explicit
and dry-run-first; it preserves the current graph and the latest adjacent delta.
JavaScript public IDs and full graph assembly remain authoritative.
