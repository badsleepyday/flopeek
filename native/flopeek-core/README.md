# Flopeek native-core bootstrap

This crate is the first native boundary for Flopeek. It is intentionally a Rust
wrapper around the existing JavaScript CLI, so normal commands retain the
JavaScript scanner, graph, Context Ref, and compatibility semantics.

```powershell
cargo test --manifest-path native/flopeek-core/Cargo.toml --locked
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --version
cargo run --manifest-path native/flopeek-core/Cargo.toml -- --native-status .
```

`--native-status` initializes `.flopeek/native-core.sqlite3` with a WAL-backed
schema for future project, scan, node, parser-fact, and alias metadata. The
store contains no target source bodies. Native BLAKE3 node IDs are internal
candidate identities only; public graph IDs and Context Refs remain JavaScript
compatible until the core-compatibility oracle promotes a native projection.
