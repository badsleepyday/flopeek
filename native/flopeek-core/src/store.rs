use crate::identity_store::{sync_identity_v2, sync_identity_v2_changed_records};
use rusqlite::{Connection, OptionalExtension};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

pub const NATIVE_STORE_SCHEMA_VERSION: i64 = 12;
pub const NATIVE_STORE_RELATIVE_PATH: &str = ".flopeek/native-core.sqlite3";
pub const DEFAULT_NATIVE_DELTA_HISTORY_LIMIT: usize = 8;
pub const DEFAULT_NATIVE_DELTA_HISTORY_MAX_BYTES: usize = 16 * 1024 * 1024;

// Deliberately process-fatal integration-test hook. Production code cannot
// recover from an operating-system termination, so the recovery contract must
// be exercised at the real SQLite transaction boundary rather than mocked.
// The exact environment value is never inferred or enabled by normal runtime
// configuration.
fn crash_at_test_boundary(boundary: &str) {
    if std::env::var("FLOPEEK_NATIVE_TEST_CRASH_POINT").as_deref() == Ok(boundary) {
        std::process::abort();
    }
}

// Deliberately test-only timing boundary for exercising process termination on
// both sides of the durable SQLite commit. The exact environment variables are
// never inferred from product configuration, and the bounded duration prevents
// a malformed test invocation from hanging a worker indefinitely.
pub(crate) fn delay_at_test_boundary(boundary: &str) {
    if std::env::var("FLOPEEK_NATIVE_TEST_DELAY_POINT").as_deref() != Ok(boundary) {
        return;
    }
    let milliseconds = std::env::var("FLOPEEK_NATIVE_TEST_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=60_000).contains(value))
        .expect("FLOPEEK_NATIVE_TEST_DELAY_MS must be between 1 and 60000");
    thread::sleep(Duration::from_millis(milliseconds));
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeStoreStatus {
    pub path: PathBuf,
    pub schema_version: i64,
    pub journal_mode: String,
    pub foreign_keys_enabled: bool,
    pub synchronous_mode: i64,
    pub busy_timeout_ms: i64,
    pub quick_check: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeGraphVersion {
    pub graph_version: i64,
    pub public_graph_version: Option<i64>,
    pub material_fingerprint: String,
    pub source_fingerprint: String,
    pub compatibility_digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeGraphPromotionTiming {
    pub public_cache_ms: u64,
    pub public_cache_write_ms: u64,
    pub delta_write_ms: u64,
    pub structural_fact_cache_ms: u64,
    pub project_pointer_ms: u64,
    pub transaction_ms: u64,
    pub total_ms: u64,
}

/// All inputs that must be atomically promoted with a completed graph build.
/// A typed request keeps the durable SQLite boundary coherent as the native
/// lifecycle grows, instead of relying on positional optional arguments.
#[derive(Debug, Clone, Copy)]
pub struct NativeGraphPromotionRequest<'a> {
    pub project_id: &'a str,
    pub graph_version: i64,
    pub public_graph_version: i64,
    pub payload: &'a serde_json::Value,
    pub compatibility_digest: &'a str,
    pub adjacent_delta: Option<&'a serde_json::Value>,
    pub facts_digest: Option<&'a str>,
    pub structural_batch: Option<&'a serde_json::Value>,
    pub changed_record_paths: Option<&'a BTreeSet<String>>,
    pub reuse_public_components: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeCompleteGraphPayload {
    pub graph_version: i64,
    pub public_graph_version: i64,
    pub payload: serde_json::Value,
    pub compatibility_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeDeltaHistoryEntry {
    pub from_graph_version: i64,
    pub to_graph_version: i64,
    pub from_public_graph_version: i64,
    pub to_public_graph_version: i64,
    pub bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeDeltaRetentionPlan {
    pub keep_deltas: usize,
    pub max_bytes: usize,
    pub total_deltas: usize,
    pub total_bytes: usize,
    pub retained: Vec<NativeDeltaHistoryEntry>,
    pub prunable: Vec<NativeDeltaHistoryEntry>,
    pub retention_exceeded_by_protected_latest: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeDeltaPruneResult {
    pub dry_run: bool,
    pub pruned: Vec<NativeDeltaHistoryEntry>,
    pub retained: Vec<NativeDeltaHistoryEntry>,
    pub reclaimed_bytes: usize,
    pub retention_exceeded_by_protected_latest: bool,
}

// A graph version keeps only a small envelope plus ordered component
// references. Component payloads are content-addressed internally; these
// BLAKE3 identities never leave SQLite and never replace public JavaScript
// node, edge, or flow IDs.
struct NativePublicGraphCache {
    envelope_json: String,
}

const NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS: [(&str, &str); 4] = [
    ("nodes", "node"),
    ("edges", "edge"),
    ("flows", "flow"),
    ("diagnosticFlows", "diagnostic-flow"),
];

mod delta_history;
mod open;
mod promotion;
mod public_graph;
mod structural_facts;

use promotion::project_pk;

pub use delta_history::{
    complete_graph_delta, complete_graph_delta_by_public_versions, native_delta_retention_plan,
    prune_native_graph_deltas, retained_public_delta_range,
};
pub use open::{initialize_native_store, open_native_store};
pub use promotion::{
    begin_graph_build, promote_graph_build, promote_graph_build_with_changed_records,
};
pub use public_graph::{
    complete_graph_payload, complete_graph_payload_by_public_version, current_complete_graph,
    recover_incomplete_graph_builds,
};
pub use structural_facts::current_structural_batch;
#[cfg(test)]
mod tests;
