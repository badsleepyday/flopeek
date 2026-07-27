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
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-rust-graph .
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

`--native-rust-graph` assembles a deliberately narrow comparable projection:
Rust file/type/function IDs plus `contains`, resolved internal `imports`,
external import, and direct-call edges. Run `cargo build --release` followed by
`npm run benchmark:native-rust-shadow -- --iterations 7` to compare this exact
projection against JavaScript. The benchmark rejects any node-ID or edge mismatch
before reporting timings.
