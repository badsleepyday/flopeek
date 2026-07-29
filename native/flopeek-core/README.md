# Flopeek native-core bootstrap

This crate contains Flopeek's experimental native core. For the promoted JS/TS
subset, Rust owns discovery, parsing, import resolution, structural records,
batch envelope, graph assembly, query authority, persistent SQLite lifecycle,
and the no-cache session lifecycle. JavaScript remains the compatibility oracle
and fallback, not a hidden parser host on the strict source path.

For cache-disabled sessions, Rust retains each queryable `StructuralFactBatch`
inside the owning JSONL process and returns a versioned session-graph handle to
Node. Queries send that handle, never a duplicate full fact batch; the handle
expires when the process closes.
An explicit no-op refresh also returns only a versioned reuse envelope, so the
already-received immutable node, edge, and flow collections are not sent again.
The same transport reduction applies when source identity changes but the
verified structural topology digest remains identical.
For persistent or cache-disabled query-only consumers,
`NativeCoreClient.scan(root, { nativeGraphHandle: true })` selects the explicit
handle-only transport: Rust returns the graph handle, state, refresh metadata,
and aggregate stats, but does not transfer node, edge, or flow collections to
Node. Persistent queries use SQLite and cache-disabled queries use the owning
session-memory handle; neither path creates a duplicate public graph in Node.
Queries such as search, impact, related tests, entry-flow lookup, project
overview, node details, and JSON node Context Cards continue to use that handle.
Flow Lens and JSON Flow Context Cards use a bounded facade containing only the
selected Lens members and transitions, so their local human/audit metadata does
not recreate the repository graph. Application node and flow Context Refs use
the native resolver directly; diagnostic/all-scope refs still require the
materialized compatibility graph. A later ordinary scan requests one explicit
compatibility snapshot instead of silently rebuilding collections in Node. This
is opt-in and does not change the default public graph contract.
Cold parsing uses bounded Rayon worker scheduling per file, followed by a
deterministic path-ordered merge and one SQLite writer transaction.
During native structural assembly, public node IDs, node kinds/types, paths,
edge types, and stable metadata strings are interned once; edges use contiguous
numeric endpoints. Public string IDs and JSON are restored only at the protocol
boundary. Open-ended parser evidence and adapter contracts remain JSON payloads
inside the native graph because their schema is intentionally extensible. This
reduces repeated long ID storage without changing the Flopeek graph contract.

This is not the default product core. Strict Rust source authority now covers
JavaScript/TypeScript, Python, PHP, Rust, Java, Svelte, and C#; Go remains a
separate toolchain-conditional adapter. Platform-package release automation is
available for supported Windows, Linux, and macOS targets. The main npm package
declares every target-locked binary as an exact optional dependency; npm selects
the current OS/CPU package and JavaScript remains the explicit fallback if it is
unavailable or fails verification. What remains incomplete is the full
five-repository rollout evidence packet—especially combined process memory and
large-repository incremental performance. Strict Rust package scans discover
and validate a bounded package subtree, reject limit overflow, verify the plan
before graph assembly, retain only a session-memory graph, and never promote a
partial/package graph to repository SQLite state. Use `native-experimental`
only for explicit dogfooding; `native` remains rollout-gated and reports any
JavaScript fallback in the surface selection record.

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
schema and reports its diagnostic state. The store contains no target source
bodies. This direct command does not select a product core: use
`--core-mode native-experimental` to select the strict Rust source, graph,
query, and SQLite authority through the JavaScript CLI surface. `native`
remains rollout-gated while the broader evidence packet is incomplete.

`--native-inventory` is a diagnostic projection. It walks the same bounded registered
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

`--native-js-facts` is a diagnostic view of the Rust-owned source-fact session.
Its versioned Tree-sitter facts
carry ordered evidence, symbols/methods, supported direct calls, HTTP/request
facts, Next route handlers, node-cron schedules, internal/external resolution,
public-compatible SHA-256 source hashes, source scope, and file metadata. The
mandatory `npm run verify:native-js-parser-parity` gate currently proves exact
parser, resolver, and record projection output for all 22 JS/TS files in the
eleven-case baseline. Strict native source authority additionally promotes
Python, PHP, Rust, Java, Svelte, and C# through the Rust graph/session path;
Go is deliberately excluded from that path. This command itself returns facts,
not a public graph. BLAKE3 remains only the native inventory/cache identity.
Each semantic parser change bumps its adapter version so stale cached facts
cannot be compared as new evidence.

`--native-rust-graph` assembles a deliberately narrow comparable projection:
Rust file/type/function IDs plus `contains`, resolved internal `imports`,
external import, and direct-call edges. Run `cargo build --release` followed by
`npm run benchmark:native-rust-shadow -- --iterations 7` to compare this exact
projection against JavaScript. The benchmark rejects any node-ID or edge mismatch
before reporting timings.

`--native-incremental-scan` is a retained legacy migration diagnostic.
Rust owns the bounded file inventory and BLAKE3 change detection, then SQLite
stores JavaScript parser-record metadata (never source bodies). For a bounded
changed-file set, the same JSONL manifest may carry `sourceBatch` UTF-8 text
once to the JavaScript parser so cold scans do not reread those files. That
batch is in-memory only, is consumed once, has a 32 MiB aggregate ceiling, and
is accepted only when its size and nanosecond modification stamp still match
the file at parser time; otherwise JavaScript rereads the current file. It is
never accepted by `StructuralFactBatch/v1`, SQLite, or the JS record cache.
The JavaScript scanner receives current candidate paths plus valid unchanged
records, parses changed files, and assembles its compatibility graph. Its result exposes a
`flopeek-core-compatibility/v1` digest for exact static-fact comparison. Product
strict-native sessions do not use this legacy mixed path: Rust retains source
facts, reverse import indexes, graph authority, and the persistent SQLite
connection in one JSONL process.
The coordinator opens one `flopeek-native-protocol/v1` JSONL session per scan
and sends the manifest, record-load, and record-store requests through that
single request-ID channel; it does not launch three native processes for those
steps. The session closes after the scan, so this is not a cross-command daemon
or a native-default cutover.

The async scan coordinator exposes the migration mode through
`FLOPEEK_CORE=js|shadow|native|native-experimental`. `js` remains the default. `shadow` is an
explicit cache-enabled, unbounded dogfood path: it uses the one JSONL session
above, reuses that coordinator-owned session across refreshes, and reports the
transport plus changed/reused counts in the scan outcome, but returns the
JavaScript graph. It is deliberately skipped for `--no-cache` and bounded scans
so those modes never create native SQLite state. `native` reports an explicit
JavaScript rollback until the rollout gate passes; it is not an alias for
shadow mode. `native-experimental` is the explicit strict-Rust dogfood path
for unbounded and bounded/package scans.

End-to-end performance measurement uses strict Rust source authority and the
release binary. `profile:native-incremental` reports scan phases, JSONL bytes,
sampled Node/native RSS plus peak working set, SQLite/WAL size, and sampled
query and Context Ref p50/p95/p99 latency. It is diagnostic evidence, not a
rollout proof. The five-repository benchmark packet must still establish median
performance, combined peak memory, and reproducible query/context latency
before native can become the default:

```powershell
cargo build --release --manifest-path native/flopeek-core/Cargo.toml
$env:FLOPEEK_NATIVE_CORE = (Resolve-Path native/flopeek-core/target/release/flopeek-native-core.exe)
npm run benchmark:native-incremental -- --root .\repo-a --root .\repo-b --iterations 3
npm run profile:native-incremental -- .\repo-a
```

Do not use one local result as a speed claim. Retain it only with the declared
repository revision and parity digest; JavaScript remains the CI oracle and
rollback authority until the complete rollout gate passes.

`--native-serve` is the persistent `flopeek-native-protocol/v1` JSON Lines
bootstrap. Each request has a request ID and emits one typed response on stdout;
diagnostics remain on stderr. The protocol includes `health`, `initialize`,
`nativeIncrementalManifest`, `nativeBoundedDiscovery`, `refreshNativeProject`,
`refreshNativePersistentProject`, `nativeJsRecordCache`, `submitStructuralFacts`,
`assembleStructuralGraph`, the shadow query methods, `persistStructuralGraph`,
and `shutdown`.
`submitStructuralFacts` accepts only
`flopeek-structural-fact-batch/v1` records from the JavaScript adapter host. It
rejects source-body fields, invalid paths, invalid SHA-256 file hashes, and a
batch whose SHA-256 digest does not equal its canonical payload. It is validated
transport input (`stored: false`), not public graph promotion or output.
`refreshNativePersistentProject` is the strict Rust JS/TS durable path: Rust
keeps source-session facts, graph promotion, and the SQLite connection in one
JSONL process and returns a versioned graph handle rather than a full fact
batch for Node to send back. Cached native core queries reuse that same
connection. A current last-complete recovery also returns a graph handle rather
than a batch, so its retry stays inside the verified SQLite cache. A full batch
is reserved for an explicit historical compatibility request whose exact
version is no longer current. Its optional `returnPublicGraph: false` protocol
parameter is the backing contract for the client-level handle-only transport;
the response carries `publicGraphEnvelope` and `publicGraphTransport` but never
the public collections. Client shutdown waits for process exit so
session-owned SQLite handles are released before temporary repositories are
removed on Windows.
`assembleStructuralGraph` is an equally non-authoritative shadow subset
for file/symbol/endpoint/runtime IDs and local structural edges (including
resolved internal imports, imported direct calls, external dependencies, and
supported command/schedule entries). `ShadowCoreClient` compares that topology
and edge/node metadata exactly against JavaScript and reports its first
deterministic mismatch; it is not a claim of the full compatibility projection.
Its node and edge canonical order is produced by Rust from the assembled IDs and
edge keys; the adapter does not send a JavaScript graph topology order. The
audited ordering contract retains the portable ASCII punctuation rules and uses
compiled ICU collation for non-ASCII public IDs and paths. JavaScript pins the
same `en` collation contract rather than inheriting the host locale. The strict
native suite includes accented, decomposed Unicode, and emoji file-name and
query-order parity; broader locale/version corpus evidence remains required
before native becomes the default.
Native Flow, Flow Lens, Context Card, related-test, and impact queries derive
their traversal sequence from `StructuralFactBatch/v1` construction phases
(integrations/symbols, imports/endpoints, calls/runtime, requests, then entry
facts). The adapter sends neither topology nor a JavaScript traversal-order
list. `native-experimental` uses those Rust query paths; JavaScript remains the
exact CI oracle and the default stays gated on broader corpus and non-ASCII
evidence.
`persistStructuralGraph` is a dogfood-only opt-in used after that exact shadow
comparison. It writes only the native structural projection through the
recoverable SQLite building/complete lifecycle and reuses an unchanged
structural-facts fingerprint. It neither changes public output nor proves full
core-query or Context Ref parity.
`getRelatedTests` is a native query: it calculates direct parser
relationships to test files from the native structural projection and is checked
against JavaScript's JSON-serializable query contract across the compatibility
corpus. It is used by the experimental native CoreClient while JavaScript
remains the default and rollback authority.
`getChangeImpact` is a native query. It matches JavaScript's
current-graph static dependent/dependency traversal, endpoint/test selection,
ordering, bounds, and optional-field serialization on the same corpus. It also
matches deleted-file recovery when an explicit preceding StructuralFactBatch is
provided, or when a complete preceding native SQLite graph version is selected.
The latter re-verifies the persisted projection digest before treating it as a
historical baseline. The native authority now has exact compatibility fixtures for Flow
Lens, node and flow Context Cards, current/stale/historical/expired Context Ref
resolution, public graph snapshot/delta retrieval, and changed-context queries.
These paths are selected by `native-experimental`, not by default `js` mode.
JavaScript remains the public compatibility oracle and rollback authority until
every query, persistence, fallback, and performance cutover gate is measured.
Native delta retention is explicit and dry-run-first; it preserves the current
graph and the latest adjacent delta. Public IDs remain JavaScript-compatible.
