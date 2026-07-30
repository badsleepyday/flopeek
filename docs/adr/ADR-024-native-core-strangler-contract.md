# ADR-024: Native core strangler contract

Status: accepted

## Context

ADR-022 establishes the JavaScript static-fact compatibility oracle and ADR-023
establishes a Rust inventory/cache wrapper. The wrapper is intentionally not a
public graph implementation: JavaScript still owns parser semantics, graph
assembly, public node IDs, Context Refs, and every public surface.

The next migration steps must improve the internal implementation without
turning the existing Rust wrapper, SQLite cache, or new protocol into a second
product. In particular, internal BLAKE3 candidates must never leak as a new
public node identifier merely because the native implementation uses them.

## Decision

### Core scope and feature freeze

Until the native core passes its promotion gates, new product breadth is frozen.
The active migration loop is repository discovery, bounded scan, structural
facts, deterministic graph construction, entry flows, graph versions, adjacent
deltas, Context Ref freshness, impact, related tests, and their minimal query
surface. Workflow, planning, semantic, runtime, multi-project, renderer, and
new parser/framework work remain available as legacy extensions but are not
ported or expanded by this migration.

Security fixes, data-integrity fixes, compatibility regressions, and necessary
release/packaging repairs remain allowed. A change to a frozen surface requires
an explicit product and compatibility review; this decision does not silently
remove a current public capability.

### Public identity and compatibility

JavaScript public node IDs, edge IDs, flow IDs, graph schema, Context Ref
syntax, ordering, unsupported classifications, and complete-result-only
semantics remain authoritative until native output exactly matches the relevant
versioned compatibility contract. BLAKE3 values and SQLite integer keys are
internal cache/join identities only.

`flopeek-core-compatibility/v1` and the committed eleven-case JavaScript
baseline remain the first mandatory graph gate. The migration must add
versioned parity fixtures for graph lifecycle and core queries before promoting
those responsibilities. Counts, timing, or an internal identity match do not
substitute for canonical output equality.

### One authority at a time

Before cutover, JavaScript/JSON is authoritative and native/SQLite is a shadow
comparison artifact. After an explicitly gated cutover, native/SQLite may be
authoritative while JavaScript remains a CI and rollback oracle. The two stores
must never both be treated as current truth, and a public surface must not read
SQLite tables directly.

SQLite may promote a graph only in one validated transaction: stage a candidate,
validate schema, references and compatibility data, persist the adjacent delta,
mark the candidate complete, then move the current-version pointer at commit.
Cancelled, failed, corrupt, or building candidates are never served. The prior
complete graph remains the fallback.

Before full compatibility promotion, an opt-in native structural shadow may use
this lifecycle only after the JavaScript-side structural oracle reports an exact
match. Its persisted projection digest and structural-facts fingerprint are
cache evidence, not a public compatibility digest; that cache never changes
CLI, HTTP, MCP, Context Ref, or query output.

### Boundary and protocol

CLI, HTTP, and MCP will converge on a narrow CoreClient boundary for the core
loop. Legacy extensions consume that boundary and do not own graph-version,
freshness, or storage rules.

An authoritative `NativeCoreClient` must not construct or accept a
`JsCoreClient`. During the shadow bridge JavaScript may temporarily be the
`StructuralFactBatch/v1` parser host, but that bridge is explicitly **not** a
native backend and can never enable `FLOPEEK_CORE=native` or a performance
claim. Native promotion additionally requires Rust to own source discovery,
parsing, import/package resolution, and structural-fact generation for every
promoted adapter. JavaScript may then remain only as a CI compatibility oracle,
formatter, and rollback implementation. Rust+SQLite exclusively own graph
assembly, public graph version, promotion/recovery, and application-scope core
queries. Rollout fallback to a complete JavaScript authority lives outside the
native backend and is allowed only before that client has promoted a native
graph. This prevents a native benchmark from measuring a JavaScript core hidden
behind a native facade.

The first persistent native boundary is a versioned JSON Lines stdio protocol
with request IDs, handshake/version negotiation, typed errors, and diagnostics
on stderr. The existing JavaScript parsers initially remain behind a versioned
`StructuralFactBatch/v1` adapter only as a shadow oracle. Parser and resolver
responsibilities must then migrate to Rust before any end-to-end native
performance result is accepted. N-API, FFI, and shared memory remain deferred
until evidence shows that the process protocol itself is the bottleneck.

`StructuralFactBatch/v1` categorically rejects source bodies. A separate
manifest-only `flopeek-native-ephemeral-source-batch/v1` may carry bounded,
current changed-file UTF-8 text once from Rust inventory to the JavaScript
parser to avoid a duplicate cold-read. It is consumed in memory, has an
explicit aggregate ceiling, is rejected when its size/modification stamp no
longer matches the file, and is prohibited from SQLite, record-cache, graph,
Context Ref, diagnostic, and fact-batch persistence. It is a transport
optimization, not parser evidence or a public API surface.

### Promotion and rollback

Promotion is explicit through `FLOPEEK_CORE=js`, `shadow`, `native`, or
`native-experimental`; a beta
cannot silently mix outputs or stores. Native initialization, migration, or
validation failure reports the selected mode and uses the JavaScript path only
when its pre-existing cache is valid. Rollback never rewrites source or
silently converts a native building graph into a JavaScript current graph.

The current coordinator implements this selection contract as
`flopeek-core-mode/v1`. `js` is the default. `shadow` is explicit and, for an
unbounded cache-enabled scan, runs the Rust inventory/SQLite path through one
persistent JSONL session while JavaScript remains the returned public graph.
That session is owned by the coordinator and reused across its unbounded
refreshes, then closed explicitly with the coordinator. Its reuse state,
protocol-request count, and changed/reused file counts are reported in the
terminal scan outcome. `shadow` is skipped for cache-disabled or bounded scans:
those modes must not create native SQLite state. A `native` request is visibly
rolled back to JavaScript until both the rollout gate and an actual native
public-core implementation exist; it never silently aliases `shadow`.
`native-experimental` is the explicit dogfood selection: it bypasses the
default-rollout gate but remains wrapped in visible JavaScript fallback and is
reported as experimental in every surface selection record.

The migration order is:

1. contract, fixture, and rollback gates;
2. narrow CoreClient boundary;
3. persistent JSONL protocol and JavaScript structural-fact bridge;
4. Rust-native discovery, parser, resolver, and `StructuralFactBatch`
   generation parity for every promoted adapter;
5. native graph assembly and canonical shadow parity;
6. SQLite lifecycle, promotion, recovery, and delta parity;
7. core query parity; JavaScript becomes CI/rollback oracle only;
8. only then, comparable end-to-end benchmark evidence, explicitly observable
   native-default beta, historical-cache migration, and packaging.

The current stage-7 slice promotes Rust inventory, tree-sitter JS/TS parsing,
import resolution, source hashes, public envelope/entry metadata, graph
assembly, persistent SQLite lifecycle, and native graph-handle queries behind
`NativeCoreClient({ sourceAuthority: "rust" })`. It rejects repositories with
an unpromoted source adapter before public graph promotion. JavaScript remains
the compatibility and extension oracle for unpromoted adapters and selected
presentation projections; therefore this slice is not yet eligible for the
native-default rollout.

## Consequences

- Rust is adopted one responsibility at a time; this is not a rewrite of the
  viewer, MCP, server, or all parsers.
- Existing current extensions remain compatible but cannot force changes into
  the native core store or protocol.
- The current one-shot native coordinator is transitional. Its process and JSON
  overhead must be measured against the persistent protocol before lower-level
  bridging technology is considered.
- A native performance result is accepted only with compatible output and a
  reproducible corpus/machine protocol. Performance targets are engineering
  gates, not public claims.
- Native may become the product default only through
  `flopeek-native-rollout-gate/v1`: public-ID parity, audited structural
  fixtures, Rust backend authority for discovery/parser/resolver/fact generation,
  named core-query parity, SQLite promotion/recovery, explicit JavaScript
  fallback, and strict performance evidence are all required.
  Performance evidence covers at least five compatible repositories; cold,
  unchanged, and one-file median speedups must each be no lower than `0.90` on
  every repository, while one-file change speedup must reach at least `2.0` on
  four repositories. Every named query operation must retain 101 raw samples
  for every repository and state. The gate uses the maximum per-cell p95 for
  each operation, requires each core query below 50 ms and Context Ref
  resolution below 20 ms, and rejects aggregates that do not equal those
  maxima. Database-open behavior is accepted only from a byte-hashed,
  release-binary/source-bound native observation that reads the current graph
  metadata without graph payload rows or payload deserialization. Memory peak
  must be no worse than the JavaScript baseline. The gate reports eligibility
  but does not activate native; when blocked, JavaScript remains selected.
- A tagged release is approved only after its exact release manifest exists.
  The manifest binds the main package tarball, rollout evidence, every platform
  tarball, and every native binary digest. The owner approval record carries
  the exact manifest SHA-256; any rebuilt or changed artifact invalidates the
  approval before publication.
