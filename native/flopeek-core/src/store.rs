use crate::identity_store::sync_identity_v2;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;

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
struct NativePublicGraphComponent {
    kind: &'static str,
    id: String,
    ordinal: i64,
    digest: String,
    payload_json: String,
}

struct NativePublicGraphCache {
    envelope_json: String,
    components: Vec<NativePublicGraphComponent>,
}

const NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS: [(&str, &str); 4] = [
    ("nodes", "node"),
    ("edges", "edge"),
    ("flows", "flow"),
    ("diagnosticFlows", "diagnostic-flow"),
];

fn invalid_store(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(io::Error::new(
        io::ErrorKind::InvalidData,
        message.into(),
    )))
}

fn native_store_path(root: &Path) -> rusqlite::Result<PathBuf> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let metadata_directory = root.join(".flopeek");
    if metadata_directory.exists() {
        let metadata = fs::symlink_metadata(&metadata_directory)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid_store(
                ".flopeek must be a real directory inside the project root, not a symlink, junction, or file",
            ));
        }
    } else {
        fs::create_dir(&metadata_directory)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    }
    let canonical_metadata = fs::canonicalize(&metadata_directory)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    if canonical_metadata.parent() != Some(canonical_root.as_path()) {
        return Err(invalid_store(
            ".flopeek resolves outside the canonical project root",
        ));
    }
    let database_path = metadata_directory.join("native-core.sqlite3");
    if database_path.exists()
        && fs::symlink_metadata(&database_path)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
            .file_type()
            .is_symlink()
    {
        return Err(invalid_store(
            "native-core.sqlite3 must not be a symlink or junction",
        ));
    }
    Ok(database_path)
}

fn sqlite_object_exists(
    connection: &Connection,
    object_type: &str,
    name: &str,
) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)",
        rusqlite::params![object_type, name],
        |row| row.get(0),
    )
}

fn validate_native_store_schema(connection: &Connection) -> rusqlite::Result<()> {
    for table in [
        "metadata",
        "projects",
        "graph_versions",
        "projects_v2",
        "nodes_v2",
        "node_revisions_v2",
        "node_placements_v2",
        "edges_v2",
        "edge_evidence_v2",
        "node_external_ids_v2",
        "node_identity_aliases_v2",
        "edge_presence_v2",
        "placement_presence_v2",
    ] {
        if !sqlite_object_exists(connection, "table", table)? {
            return Err(invalid_store(format!(
                "native store schema v{NATIVE_STORE_SCHEMA_VERSION} is missing required table {table}"
            )));
        }
    }
    for index in ["edge_presence_v2_open", "placement_presence_v2_open"] {
        if !sqlite_object_exists(connection, "index", index)? {
            return Err(invalid_store(format!(
                "native store schema v{NATIVE_STORE_SCHEMA_VERSION} is missing required index {index}"
            )));
        }
    }
    if !sqlite_object_exists(
        connection,
        "trigger",
        "node_identity_aliases_v2_validate_insert",
    )? {
        return Err(invalid_store(format!(
            "native store schema v{NATIVE_STORE_SCHEMA_VERSION} is missing its identity alias validation trigger"
        )));
    }
    Ok(())
}

fn preflight_native_store(connection: &Connection) -> rusqlite::Result<i64> {
    let user_version =
        connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if user_version > NATIVE_STORE_SCHEMA_VERSION {
        return Err(invalid_store(format!(
            "native store schema v{user_version} is newer than supported v{NATIVE_STORE_SCHEMA_VERSION}; refusing to modify it"
        )));
    }
    let metadata_version = if sqlite_object_exists(connection, "table", "metadata")? {
        connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| {
                value.parse::<i64>().map_err(|_| {
                    invalid_store(format!("invalid metadata schema_version value {value:?}"))
                })
            })
            .transpose()?
    } else {
        None
    };
    match (user_version, metadata_version) {
        (0, None | Some(0)) => {}
        (0, Some(metadata)) => {
            return Err(invalid_store(format!(
                "native store schema metadata v{metadata} disagrees with PRAGMA user_version 0"
            )));
        }
        (_, Some(metadata)) if metadata == user_version => {}
        (_, Some(metadata)) => {
            return Err(invalid_store(format!(
                "native store schema metadata v{metadata} disagrees with PRAGMA user_version {user_version}"
            )));
        }
        (_, None) => {
            return Err(invalid_store(format!(
                "native store schema v{user_version} has no matching metadata schema_version"
            )));
        }
    }
    if user_version == NATIVE_STORE_SCHEMA_VERSION {
        validate_native_store_schema(connection)?;
    }
    Ok(user_version)
}

pub fn open_native_store(root: &Path) -> rusqlite::Result<Connection> {
    let database_path = native_store_path(root)?;
    let mut connection = Connection::open(&database_path)?;
    let on_disk_version = preflight_native_store(&connection)?;
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        ",
    )?;
    if on_disk_version == NATIVE_STORE_SCHEMA_VERSION {
        return Ok(connection);
    }
    let migration = connection.transaction()?;
    migration.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          project_pk INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL UNIQUE,
          current_graph_version INTEGER,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scan_runs (
          scan_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          source_fingerprint TEXT NOT NULL,
          compatibility_digest TEXT,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nodes (
          node_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          node_id TEXT NOT NULL,
          semantic_key TEXT NOT NULL,
          content_hash TEXT,
          kind TEXT NOT NULL,
          path TEXT,
          symbol TEXT,
          signature TEXT,
          UNIQUE(project_pk, node_id),
          UNIQUE(project_pk, semantic_key)
        );
        CREATE TABLE IF NOT EXISTS parser_facts (
          fact_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          path TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          adapter_version TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(project_pk, path, source_hash, adapter_version)
        );
        CREATE TABLE IF NOT EXISTS node_aliases (
          alias_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          UNIQUE(project_pk, from_node_id, to_node_id)
        );
        CREATE TABLE IF NOT EXISTS inventory_files (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          modified_at_ns INTEGER NOT NULL,
          source_scope TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          last_seen_scan_pk INTEGER NOT NULL REFERENCES scan_runs(scan_pk),
          PRIMARY KEY(project_pk, path)
        );
        CREATE INDEX IF NOT EXISTS inventory_files_project_seen
          ON inventory_files(project_pk, last_seen_scan_pk);
        CREATE TABLE IF NOT EXISTS js_file_records (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          path TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY(project_pk, path)
        );
        CREATE INDEX IF NOT EXISTS js_file_records_project_hash
          ON js_file_records(project_pk, source_hash);
        CREATE TABLE IF NOT EXISTS graph_versions (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          graph_version INTEGER NOT NULL,
          public_graph_version INTEGER,
          status TEXT NOT NULL CHECK(status IN ('building', 'complete')),
          material_fingerprint TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          compatibility_digest TEXT,
          payload_json TEXT,
          created_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          PRIMARY KEY(project_pk, graph_version)
        );
        CREATE TABLE IF NOT EXISTS graph_deltas (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          from_graph_version INTEGER NOT NULL,
          to_graph_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(project_pk, from_graph_version, to_graph_version)
        );
        -- v9 stores a public graph as an envelope and content-addressed
        -- components. A version still records its exact public ordering, but
        -- unchanged component JSON is never re-written for a one-file refresh.
        CREATE TABLE IF NOT EXISTS native_public_graph_envelopes (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          graph_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(project_pk, graph_version),
          FOREIGN KEY(project_pk, graph_version)
            REFERENCES graph_versions(project_pk, graph_version)
        );
        CREATE TABLE IF NOT EXISTS native_public_graph_components (
          component_digest TEXT PRIMARY KEY,
          component_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS native_public_graph_memberships (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          graph_version INTEGER NOT NULL,
          component_kind TEXT NOT NULL,
          component_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          component_digest TEXT NOT NULL REFERENCES native_public_graph_components(component_digest),
          PRIMARY KEY(project_pk, graph_version, component_kind, component_id),
          UNIQUE(project_pk, graph_version, component_kind, ordinal),
          FOREIGN KEY(project_pk, graph_version)
            REFERENCES graph_versions(project_pk, graph_version)
        );
        CREATE INDEX IF NOT EXISTS native_public_graph_memberships_load
          ON native_public_graph_memberships(project_pk, graph_version, component_kind, ordinal);
        -- v10 removes the remaining per-version membership rewrite. An open
        -- interval represents a component unchanged across consecutive graph
        -- versions; a changed or removed component closes only its prior row.
        CREATE TABLE IF NOT EXISTS native_public_graph_component_history (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          component_kind TEXT NOT NULL,
          component_id TEXT NOT NULL,
          first_graph_version INTEGER NOT NULL,
          last_graph_version INTEGER,
          ordinal INTEGER NOT NULL,
          component_digest TEXT NOT NULL REFERENCES native_public_graph_components(component_digest),
          PRIMARY KEY(project_pk, component_kind, component_id, first_graph_version)
        );
        CREATE INDEX IF NOT EXISTS native_public_graph_component_history_load
          ON native_public_graph_component_history(project_pk, first_graph_version, last_graph_version, component_kind, ordinal);
        -- This is a derived transport cache, never a second graph authority.
        -- It is retained only for the complete graph currently selected by the
        -- project pointer, and is promoted in the same transaction as that
        -- pointer.  Incremental fact patches must reconstruct and validate a
        -- complete StructuralFactBatch from this row before use.
        CREATE TABLE IF NOT EXISTS native_structural_batches (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          graph_version INTEGER NOT NULL,
          facts_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(project_pk, graph_version),
          FOREIGN KEY(project_pk, graph_version)
            REFERENCES graph_versions(project_pk, graph_version)
        );
        -- v8 replaces the monolithic transport-cache JSON write on every
        -- promotion. The current complete batch is represented by one small
        -- envelope plus individually upserted parser records, so unchanged
        -- records are not rewritten into the WAL for a one-file refresh.
        CREATE TABLE IF NOT EXISTS native_structural_batch_cache (
          project_pk INTEGER PRIMARY KEY REFERENCES projects(project_pk),
          graph_version INTEGER NOT NULL,
          facts_digest TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          FOREIGN KEY(project_pk, graph_version)
            REFERENCES graph_versions(project_pk, graph_version)
        );
        CREATE TABLE IF NOT EXISTS native_structural_batch_records (
          project_pk INTEGER NOT NULL REFERENCES projects(project_pk),
          path TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          record_order INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(project_pk, path)
        );
        CREATE INDEX IF NOT EXISTS native_structural_batch_records_order
          ON native_structural_batch_records(project_pk, record_order, path);
        ",
    )?;
    let has_source_scope = {
        let mut statement = migration.prepare("PRAGMA table_info(inventory_files)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "source_scope")
    };
    if !has_source_scope {
        migration.execute("ALTER TABLE inventory_files ADD COLUMN source_scope TEXT NOT NULL DEFAULT 'application'", [])?;
    }
    let has_current_graph_version = {
        let mut statement = migration.prepare("PRAGMA table_info(projects)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "current_graph_version")
    };
    if !has_current_graph_version {
        migration.execute(
            "ALTER TABLE projects ADD COLUMN current_graph_version INTEGER",
            [],
        )?;
    }
    let has_compatibility_digest = {
        let mut statement = migration.prepare("PRAGMA table_info(graph_versions)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "compatibility_digest")
    };
    if !has_compatibility_digest {
        migration.execute(
            "ALTER TABLE graph_versions ADD COLUMN compatibility_digest TEXT",
            [],
        )?;
    }
    let has_public_graph_version = {
        let mut statement = migration.prepare("PRAGMA table_info(graph_versions)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "public_graph_version")
    };
    if !has_public_graph_version {
        migration.execute(
            "ALTER TABLE graph_versions ADD COLUMN public_graph_version INTEGER",
            [],
        )?;
    }
    migration.execute_batch(
        "CREATE INDEX IF NOT EXISTS graph_versions_project_public_version
           ON graph_versions(project_pk, public_graph_version);",
    )?;
    // v11 is an additive identity store. Public graph v1 and
    // its component cache remain authoritative compatibility projections.
    // The complete upgrade is one transaction, so an older database is either
    // wholly upgraded or left at its original declared version after a crash.
    migration.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects_v2 (
          project_pk INTEGER PRIMARY KEY REFERENCES projects(project_pk) ON DELETE CASCADE,
          project_uid BLOB NOT NULL UNIQUE CHECK(length(project_uid) = 16),
          public_project_id TEXT NOT NULL UNIQUE,
          identity_status TEXT NOT NULL CHECK(identity_status IN ('local', 'imported', 'ambiguous')),
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nodes_v2 (
          node_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects_v2(project_pk) ON DELETE CASCADE,
          node_uid BLOB NOT NULL CHECK(length(node_uid) = 16),
          kind TEXT NOT NULL,
          language TEXT,
          ecosystem TEXT,
          lexical_owner_pk INTEGER REFERENCES nodes_v2(node_pk),
          current_semantic_hash BLOB NOT NULL CHECK(length(current_semantic_hash) = 32),
          current_canonical_identity BLOB NOT NULL,
          first_seen_graph_version INTEGER NOT NULL CHECK(first_seen_graph_version >= 0),
          last_seen_graph_version INTEGER CHECK(last_seen_graph_version >= first_seen_graph_version),
          status TEXT NOT NULL CHECK(status IN ('active', 'tombstone', 'ambiguous')),
          UNIQUE(project_pk, node_uid)
        );
        CREATE TABLE IF NOT EXISTS node_revisions_v2 (
          node_revision_pk INTEGER PRIMARY KEY,
          node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          semantic_hash BLOB NOT NULL CHECK(length(semantic_hash) = 32),
          canonical_identity BLOB NOT NULL,
          revision_hash BLOB NOT NULL CHECK(length(revision_hash) = 32),
          source_sha256 BLOB CHECK(source_sha256 IS NULL OR length(source_sha256) = 32),
          content_blake3 BLOB CHECK(content_blake3 IS NULL OR length(content_blake3) = 32),
          path TEXT,
          qualified_name TEXT,
          display_name TEXT,
          signature TEXT,
          lexical_owner_pk INTEGER REFERENCES nodes_v2(node_pk),
          start_line INTEGER,
          start_column INTEGER,
          end_line INTEGER,
          end_column INTEGER,
          metadata_json TEXT,
          UNIQUE(node_pk, first_graph_version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS node_revisions_v2_open
          ON node_revisions_v2(node_pk) WHERE last_graph_version IS NULL;
        CREATE INDEX IF NOT EXISTS nodes_v2_project_kind
          ON nodes_v2(project_pk, kind, status);
        CREATE INDEX IF NOT EXISTS nodes_v2_semantic
          ON nodes_v2(project_pk, current_semantic_hash);
        CREATE INDEX IF NOT EXISTS node_revisions_v2_semantic
          ON node_revisions_v2(semantic_hash);
        CREATE INDEX IF NOT EXISTS node_revisions_v2_path
          ON node_revisions_v2(path);
        CREATE INDEX IF NOT EXISTS node_revisions_v2_revision
          ON node_revisions_v2(revision_hash);
        CREATE TABLE IF NOT EXISTS node_placements_v2 (
          placement_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects_v2(project_pk) ON DELETE CASCADE,
          parent_node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          child_node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          ordinal INTEGER,
          placement_hash BLOB NOT NULL CHECK(length(placement_hash) = 32),
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          UNIQUE(project_pk, placement_hash),
          CHECK(parent_node_pk != child_node_pk)
        );
        CREATE INDEX IF NOT EXISTS node_placements_v2_parent
          ON node_placements_v2(parent_node_pk, relation, last_graph_version);
        CREATE INDEX IF NOT EXISTS node_placements_v2_child
          ON node_placements_v2(child_node_pk, relation, last_graph_version);
        CREATE TABLE IF NOT EXISTS edges_v2 (
          edge_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects_v2(project_pk) ON DELETE CASCADE,
          edge_uid BLOB NOT NULL CHECK(length(edge_uid) = 32),
          source_node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          target_node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          qualifier_hash BLOB NOT NULL CHECK(length(qualifier_hash) = 32),
          canonical_qualifier BLOB NOT NULL,
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          UNIQUE(project_pk, edge_uid)
        );
        CREATE INDEX IF NOT EXISTS edges_v2_source_relation
          ON edges_v2(source_node_pk, relation, last_graph_version);
        CREATE INDEX IF NOT EXISTS edges_v2_target_relation
          ON edges_v2(target_node_pk, relation, last_graph_version);
        CREATE TABLE IF NOT EXISTS edge_evidence_v2 (
          evidence_pk INTEGER PRIMARY KEY,
          edge_pk INTEGER NOT NULL REFERENCES edges_v2(edge_pk) ON DELETE CASCADE,
          evidence_uid BLOB NOT NULL CHECK(length(evidence_uid) = 32),
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          path TEXT,
          start_line INTEGER,
          start_column INTEGER,
          end_line INTEGER,
          end_column INTEGER,
          parser TEXT NOT NULL,
          parser_version TEXT,
          confidence TEXT NOT NULL,
          evidence_json TEXT,
          UNIQUE(edge_pk, evidence_uid, first_graph_version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS edge_evidence_v2_open
          ON edge_evidence_v2(edge_pk, evidence_uid) WHERE last_graph_version IS NULL;
        CREATE TABLE IF NOT EXISTS node_external_ids_v2 (
          external_id_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects_v2(project_pk) ON DELETE CASCADE,
          node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          scheme TEXT NOT NULL,
          external_id TEXT NOT NULL,
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          UNIQUE(project_pk, scheme, external_id, first_graph_version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS node_external_ids_v2_open
          ON node_external_ids_v2(project_pk, scheme, external_id)
          WHERE last_graph_version IS NULL;
        CREATE TABLE IF NOT EXISTS node_identity_aliases_v2 (
          alias_pk INTEGER PRIMARY KEY,
          project_pk INTEGER NOT NULL REFERENCES projects_v2(project_pk) ON DELETE CASCADE,
          old_node_uid BLOB NOT NULL CHECK(length(old_node_uid) = 16),
          current_node_pk INTEGER NOT NULL REFERENCES nodes_v2(node_pk) ON DELETE CASCADE,
          reason TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK(confidence IN ('high', 'human-confirmed')),
          evidence_json TEXT,
          created_graph_version INTEGER NOT NULL CHECK(created_graph_version >= 0),
          confirmed_by TEXT,
          UNIQUE(project_pk, old_node_uid)
        );
        CREATE TRIGGER IF NOT EXISTS node_identity_aliases_v2_validate_insert
        BEFORE INSERT ON node_identity_aliases_v2
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM nodes_v2 AS target
            WHERE target.node_pk = NEW.current_node_pk AND target.project_pk = NEW.project_pk
          ) THEN RAISE(ABORT, 'identity alias target belongs to another project') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM nodes_v2 AS target
            WHERE target.node_pk = NEW.current_node_pk AND target.node_uid = NEW.old_node_uid
          ) THEN RAISE(ABORT, 'identity alias cannot target itself') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM node_identity_aliases_v2 AS existing
            JOIN nodes_v2 AS target ON target.node_pk = NEW.current_node_pk
            WHERE existing.project_pk = NEW.project_pk
              AND existing.old_node_uid = target.node_uid
          ) THEN RAISE(ABORT, 'identity alias chains are forbidden') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM node_identity_aliases_v2 AS existing
            JOIN nodes_v2 AS existing_target ON existing_target.node_pk = existing.current_node_pk
            WHERE existing.project_pk = NEW.project_pk
              AND existing_target.node_uid = NEW.old_node_uid
          ) THEN RAISE(ABORT, 'identity alias chains are forbidden') END;
        END;

        -- v12 separates durable relationship identity from presence history.
        -- The v11 last_graph_version columns remain a compatibility projection
        -- for current-state queries; these interval tables are authoritative
        -- for historical presence and retain every absent/reappeared gap.
        CREATE TABLE IF NOT EXISTS edge_presence_v2 (
          edge_pk INTEGER NOT NULL REFERENCES edges_v2(edge_pk) ON DELETE CASCADE,
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          PRIMARY KEY(edge_pk, first_graph_version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS edge_presence_v2_open
          ON edge_presence_v2(edge_pk) WHERE last_graph_version IS NULL;
        CREATE INDEX IF NOT EXISTS edge_presence_v2_history
          ON edge_presence_v2(first_graph_version, last_graph_version, edge_pk);
        CREATE TABLE IF NOT EXISTS placement_presence_v2 (
          placement_pk INTEGER NOT NULL REFERENCES node_placements_v2(placement_pk) ON DELETE CASCADE,
          first_graph_version INTEGER NOT NULL CHECK(first_graph_version >= 0),
          last_graph_version INTEGER CHECK(last_graph_version >= first_graph_version),
          PRIMARY KEY(placement_pk, first_graph_version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS placement_presence_v2_open
          ON placement_presence_v2(placement_pk) WHERE last_graph_version IS NULL;
        CREATE INDEX IF NOT EXISTS placement_presence_v2_history
          ON placement_presence_v2(first_graph_version, last_graph_version, placement_pk);

        -- v11 stored only one possibly-reopened interval. Preserve exactly the
        -- recoverable history during migration; future promotions append new
        -- intervals instead of rewriting this imported interval.
        INSERT OR IGNORE INTO edge_presence_v2(
          edge_pk, first_graph_version, last_graph_version
        )
        SELECT edge_pk, first_graph_version, last_graph_version FROM edges_v2;
        INSERT OR IGNORE INTO placement_presence_v2(
          placement_pk, first_graph_version, last_graph_version
        )
        SELECT placement_pk, first_graph_version, last_graph_version FROM node_placements_v2;
        ",
    )?;
    migration.execute(
        "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [NATIVE_STORE_SCHEMA_VERSION.to_string()],
    )?;
    migration.pragma_update(None, "user_version", NATIVE_STORE_SCHEMA_VERSION)?;
    validate_native_store_schema(&migration)?;
    migration.commit()?;
    Ok(connection)
}

fn now_ms() -> rusqlite::Result<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn project_pk(transaction: &rusqlite::Transaction<'_>, project_id: &str) -> rusqlite::Result<i64> {
    transaction.execute(
        "INSERT INTO projects(project_id, created_at_ms) VALUES (?1, ?2) ON CONFLICT(project_id) DO NOTHING",
        rusqlite::params![project_id, now_ms()?],
    )?;
    transaction.query_row(
        "SELECT project_pk FROM projects WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )
}

fn contains_source_body(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter().any(contains_source_body),
        serde_json::Value::Object(entries) => entries.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "content" | "contents" | "rawsource" | "sourcebody" | "sourcetext" | "text"
            ) || contains_source_body(value)
        }),
        _ => false,
    }
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn native_public_graph_cache(
    payload: &serde_json::Value,
    reuse_public_components: bool,
) -> rusqlite::Result<NativePublicGraphCache> {
    let payload = payload.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
    // Do not clone every public collection merely to remove it moments later.
    // On a large graph, cloning the full payload and then cloning node/edge/
    // flow arrays again made SQLite promotion do proportional allocation work
    // even when the component rows were unchanged.  Components are serialized
    // directly from the immutable projection below; only the envelope owns
    // clones of its non-component fields.
    let mut envelope = payload
        .iter()
        .filter(|(field, _)| {
            !NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS
                .iter()
                .any(|(component_field, _)| field == component_field)
        })
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    let mut components = Vec::new();
    for (field, kind) in NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS {
        let Some(values) = payload.get(field) else {
            continue;
        };
        let values = values.as_array().ok_or(rusqlite::Error::InvalidQuery)?;
        // Keeping empty arrays in the envelope preserves both an explicitly
        // empty public field and legacy payloads that omit the field entirely.
        // Only non-empty arrays are split into content-addressed components.
        if values.is_empty() {
            envelope.insert(field.to_string(), serde_json::Value::Array(Vec::new()));
            continue;
        }
        // A verified source-only refresh preserves every public collection
        // byte-for-byte.  Its next graph version still needs a new envelope
        // for source/version metadata, but the open component-history rows
        // already cover that version.  Avoid hashing and serializing every
        // public component again; callers may select this only after the
        // protocol has reused the preceding complete public projection.
        if reuse_public_components {
            continue;
        }
        let mut ids = BTreeSet::new();
        for (ordinal, value) in values.iter().enumerate() {
            let payload_json = serde_json::to_string(value)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let digest = format!(
                "blake3:{}",
                blake3::hash(format!("{kind}\0{payload_json}").as_bytes()).to_hex()
            );
            // Public edge objects intentionally have no `id`. Membership IDs
            // are therefore internal keys; use a public id where available,
            // otherwise the internal component digest. A duplicate gets an
            // ordinal suffix without altering the serialized array.
            let base_id = value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| digest.clone());
            let id = if ids.insert(base_id.clone()) {
                base_id
            } else {
                format!("{base_id}@{ordinal}")
            };
            components.push(NativePublicGraphComponent {
                kind,
                id,
                ordinal: i64::try_from(ordinal).map_err(|_| rusqlite::Error::InvalidQuery)?,
                digest,
                payload_json,
            });
        }
    }
    let envelope_json = serde_json::to_string(&serde_json::Value::Object(envelope))
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    Ok(NativePublicGraphCache {
        envelope_json,
        components,
    })
}

fn promote_native_public_graph_cache(
    transaction: &rusqlite::Transaction<'_>,
    project_pk: i64,
    graph_version: i64,
    previous_graph_version: Option<i64>,
    cache: &NativePublicGraphCache,
    reuse_public_components: bool,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO native_public_graph_envelopes(project_pk, graph_version, payload_json)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![project_pk, graph_version, cache.envelope_json],
    )?;
    // The component-history intervals from the previously complete graph are
    // deliberately left open.  Their version predicate reconstructs the same
    // public arrays for this new envelope without a full history SELECT or
    // any component/history writes.  Reject an impossible first-version reuse
    // rather than silently creating an envelope with no public collections.
    if reuse_public_components {
        if previous_graph_version.is_none() || !cache.components.is_empty() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        return Ok(());
    }
    // These maps are only a private membership-diff work set. Canonical public
    // ordering was established before persistence, so a hash index avoids
    // repeated lexical comparisons for thousands of internal component IDs.
    let mut active = HashMap::new();
    if previous_graph_version.is_some() {
        let mut statement = transaction.prepare(
            "SELECT component_kind, component_id, ordinal, component_digest
             FROM native_public_graph_component_history
             WHERE project_pk = ?1 AND last_graph_version IS NULL",
        )?;
        for row in statement.query_map([project_pk], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })? {
            let (kind, id, ordinal, digest) = row?;
            active.insert((kind, id), (ordinal, digest));
        }
    }
    let incoming = cache
        .components
        .iter()
        .map(|entry| {
            (
                (entry.kind.to_string(), entry.id.clone()),
                (entry.ordinal, entry.digest.clone()),
            )
        })
        .collect::<HashMap<_, _>>();
    // The interval table is the current-version membership index.  Do not
    // issue a no-op INSERT OR IGNORE for every unchanged component on an
    // incremental refresh: a large graph can otherwise turn one local edit
    // into thousands of SQLite statements despite content-addressed storage.
    // Components absent from the active set may be new or merely historical;
    // the SQL conflict clause preserves both cases without changing public
    // graph IDs or history semantics.
    let active_digests = active
        .values()
        .map(|(_, digest)| digest.as_str())
        .collect::<HashSet<_>>();
    let mut inserted_digests = HashSet::new();
    let mut component = transaction.prepare(
        "INSERT INTO native_public_graph_components(component_digest, component_kind, payload_json)
         VALUES (?1, ?2, ?3) ON CONFLICT(component_digest) DO NOTHING",
    )?;
    for entry in &cache.components {
        if active_digests.contains(entry.digest.as_str())
            || !inserted_digests.insert(entry.digest.as_str())
        {
            continue;
        }
        component.execute(rusqlite::params![
            entry.digest,
            entry.kind,
            entry.payload_json
        ])?;
    }
    drop(component);
    let previous_graph_version = previous_graph_version.unwrap_or(graph_version.saturating_sub(1));
    let mut close = transaction.prepare(
        "UPDATE native_public_graph_component_history
         SET last_graph_version = ?1
         WHERE project_pk = ?2 AND component_kind = ?3 AND component_id = ?4
           AND last_graph_version IS NULL",
    )?;
    let mut open = transaction.prepare(
        "INSERT INTO native_public_graph_component_history(project_pk, component_kind, component_id, first_graph_version, last_graph_version, ordinal, component_digest)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)",
    )?;
    for (key, (ordinal, digest)) in &incoming {
        if active
            .get(key)
            .is_some_and(|(active_ordinal, active_digest)| {
                active_ordinal == ordinal && active_digest == digest
            })
        {
            continue;
        }
        if active.contains_key(key) {
            close.execute(rusqlite::params![
                previous_graph_version,
                project_pk,
                key.0,
                key.1
            ])?;
        }
        open.execute(rusqlite::params![
            project_pk,
            key.0,
            key.1,
            graph_version,
            ordinal,
            digest
        ])?;
    }
    for key in active.keys().filter(|key| !incoming.contains_key(*key)) {
        close.execute(rusqlite::params![
            previous_graph_version,
            project_pk,
            key.0,
            key.1
        ])?;
    }
    Ok(())
}

fn promote_native_structural_batch_cache(
    transaction: &rusqlite::Transaction<'_>,
    project_pk: i64,
    graph_version: i64,
    batch: &serde_json::Value,
    facts_digest: &str,
    changed_record_paths: Option<&BTreeSet<String>>,
) -> rusqlite::Result<()> {
    let object = batch.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
    if object
        .get("factsDigest")
        .and_then(serde_json::Value::as_str)
        != Some(facts_digest)
        || !is_sha256_digest(facts_digest)
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let records = object
        .get("records")
        .and_then(serde_json::Value::as_array)
        .ok_or(rusqlite::Error::InvalidQuery)?;
    // The records array is the dominant part of a fact batch.  Cloning the
    // whole object only to immediately remove it duplicates every parser fact
    // on each incremental promotion.  Build the persisted envelope directly
    // so the record payloads stay borrowed until the selective cache write.
    let envelope = object
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "records" | "factsDigest" | "projectRoot"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let envelope_json = serde_json::to_string(&serde_json::Value::Object(envelope))
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let mut parsed_records = Vec::with_capacity(records.len());
    let mut next_paths = BTreeSet::new();
    for record in records {
        let item = record.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
        let path = item
            .get("relativePath")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let source_hash = item
            .get("sourceHash")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
            })
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let record_order = item
            .get("recordOrder")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value >= 0)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        if !next_paths.insert(path.to_string()) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        parsed_records.push((path, source_hash, record_order, record));
    }
    let existing = {
        let mut statement = transaction
            .prepare("SELECT path FROM native_structural_batch_records WHERE project_pk = ?1")?;
        statement
            .query_map([project_pk], |row| row.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?
    };
    for path in existing.difference(&next_paths) {
        transaction.execute(
            "DELETE FROM native_structural_batch_records WHERE project_pk = ?1 AND path = ?2",
            rusqlite::params![project_pk, path],
        )?;
    }
    let mut upsert = transaction.prepare(
        "INSERT INTO native_structural_batch_records(project_pk, path, source_hash, record_order, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_pk, path) DO UPDATE SET
           source_hash = excluded.source_hash,
           record_order = excluded.record_order,
           payload_json = excluded.payload_json
         WHERE native_structural_batch_records.source_hash <> excluded.source_hash
            OR native_structural_batch_records.record_order <> excluded.record_order
            OR native_structural_batch_records.payload_json <> excluded.payload_json",
    )?;
    for (path, source_hash, record_order, record) in parsed_records {
        // A verified StructuralFactPatch explicitly identifies every record
        // whose header or payload may differ.  Avoid serializing and issuing
        // a guarded UPSERT for all of the other records; a full batch keeps
        // the conservative whole-record behavior.
        if changed_record_paths.is_some_and(|paths| !paths.contains(path)) {
            continue;
        }
        let payload_json = serde_json::to_string(record)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        upsert.execute(rusqlite::params![
            project_pk,
            path,
            source_hash,
            record_order,
            payload_json,
        ])?;
    }
    drop(upsert);
    transaction.execute(
        "INSERT INTO native_structural_batch_cache(project_pk, graph_version, facts_digest, envelope_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_pk) DO UPDATE SET
           graph_version = excluded.graph_version,
           facts_digest = excluded.facts_digest,
           envelope_json = excluded.envelope_json",
        rusqlite::params![project_pk, graph_version, facts_digest, envelope_json],
    )?;
    // The v7 monolithic cache remains readable for upgrades, but once v8 has
    // atomically promoted a record cache it is intentionally discarded.
    transaction.execute(
        "DELETE FROM native_structural_batches WHERE project_pk = ?1",
        [project_pk],
    )?;
    Ok(())
}

pub fn begin_graph_build(
    connection: &mut Connection,
    project_id: &str,
    material_fingerprint: &str,
    source_fingerprint: &str,
) -> rusqlite::Result<NativeGraphVersion> {
    let transaction = connection.transaction()?;
    let project_pk = project_pk(&transaction, project_id)?;
    let graph_version = transaction.query_row(
        "SELECT COALESCE(MAX(graph_version), 0) + 1 FROM graph_versions WHERE project_pk = ?1",
        [project_pk],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO graph_versions(project_pk, graph_version, status, material_fingerprint, source_fingerprint, created_at_ms)
         VALUES (?1, ?2, 'building', ?3, ?4, ?5)",
        rusqlite::params![project_pk, graph_version, material_fingerprint, source_fingerprint, now_ms()?],
    )?;
    transaction.commit()?;
    crash_at_test_boundary("after-begin-build");
    Ok(NativeGraphVersion {
        graph_version,
        public_graph_version: None,
        material_fingerprint: material_fingerprint.to_string(),
        source_fingerprint: source_fingerprint.to_string(),
        compatibility_digest: None,
    })
}

pub fn promote_graph_build(
    connection: &mut Connection,
    request: NativeGraphPromotionRequest<'_>,
) -> rusqlite::Result<()> {
    promote_graph_build_with_changed_records(connection, request).map(|_| ())
}

pub fn promote_graph_build_with_changed_records(
    connection: &mut Connection,
    request: NativeGraphPromotionRequest<'_>,
) -> rusqlite::Result<NativeGraphPromotionTiming> {
    let started = Instant::now();
    if contains_source_body(request.payload)
        || request.adjacent_delta.is_some_and(contains_source_body)
        || request.structural_batch.is_some_and(contains_source_body)
        || !request
            .payload
            .get("schemaVersion")
            .is_some_and(|value| value.is_string())
        || !is_sha256_digest(request.compatibility_digest)
        || request.public_graph_version < 0
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let public_cache_started = Instant::now();
    let public_graph_cache =
        native_public_graph_cache(request.payload, request.reuse_public_components)?;
    let public_cache_ms = public_cache_started.elapsed().as_millis() as u64;
    if let Some(batch) = request.structural_batch {
        let facts_digest = request.facts_digest.ok_or(rusqlite::Error::InvalidQuery)?;
        if batch.get("factsDigest").and_then(serde_json::Value::as_str) != Some(facts_digest) {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    let transaction_started = Instant::now();
    let transaction = connection.transaction()?;
    let project_pk = project_pk(&transaction, request.project_id)?;
    let previous_graph_version: Option<i64> = transaction.query_row(
        "SELECT current_graph_version FROM projects WHERE project_pk = ?1",
        [project_pk],
        |row| row.get(0),
    )?;
    let changed = transaction.execute(
        "UPDATE graph_versions SET status = 'complete', compatibility_digest = ?1, public_graph_version = ?2, completed_at_ms = ?3
         WHERE project_pk = ?4 AND graph_version = ?5 AND status = 'building'",
        rusqlite::params![request.compatibility_digest, request.public_graph_version, now_ms()?, project_pk, request.graph_version],
    )?;
    if changed != 1 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let public_cache_write_started = Instant::now();
    promote_native_public_graph_cache(
        &transaction,
        project_pk,
        request.graph_version,
        previous_graph_version,
        &public_graph_cache,
        request.reuse_public_components,
    )?;
    crash_at_test_boundary("after-graph-payload-write");
    let public_cache_write_ms = public_cache_write_started.elapsed().as_millis() as u64;
    let delta_write_started = Instant::now();
    if let (Some(from_graph_version), Some(delta)) =
        (previous_graph_version, request.adjacent_delta)
    {
        let delta_json = serde_json::to_string(delta)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        transaction.execute(
            "INSERT INTO graph_deltas(project_pk, from_graph_version, to_graph_version, payload_json)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![project_pk, from_graph_version, request.graph_version, delta_json],
        )?;
    }
    let delta_write_ms = delta_write_started.elapsed().as_millis() as u64;
    let structural_fact_cache_started = Instant::now();
    if let Some(batch) = request.structural_batch {
        // The old cache remains live until this transaction commits.  A
        // cancellation, validation failure, or crash therefore leaves the
        // previous complete graph and its matching batch untouched.
        promote_native_structural_batch_cache(
            &transaction,
            project_pk,
            request.graph_version,
            batch,
            request
                .facts_digest
                .expect("validated with structural batch"),
            request.changed_record_paths,
        )?;
    } else {
        transaction.execute(
            "DELETE FROM native_structural_batch_cache WHERE project_pk = ?1",
            [project_pk],
        )?;
        transaction.execute(
            "DELETE FROM native_structural_batch_records WHERE project_pk = ?1",
            [project_pk],
        )?;
        transaction.execute(
            "DELETE FROM native_structural_batches WHERE project_pk = ?1",
            [project_pk],
        )?;
    }
    let structural_fact_cache_ms = structural_fact_cache_started.elapsed().as_millis() as u64;
    // Identity v2 is an additive dual-write in schema v11. It participates in
    // the same transaction as the compatibility graph, so invalid canonical
    // identity input can never advance the project pointer independently.
    sync_identity_v2(
        &transaction,
        project_pk,
        request.project_id,
        request.graph_version,
        request.payload,
        request.structural_batch,
    )?;
    crash_at_test_boundary("after-fact-storage");
    let project_pointer_started = Instant::now();
    crash_at_test_boundary("before-current-pointer-promotion");
    transaction.execute(
        "UPDATE projects SET current_graph_version = ?1 WHERE project_pk = ?2",
        rusqlite::params![request.graph_version, project_pk],
    )?;
    let project_pointer_ms = project_pointer_started.elapsed().as_millis() as u64;
    transaction.commit()?;
    Ok(NativeGraphPromotionTiming {
        public_cache_ms,
        public_cache_write_ms,
        delta_write_ms,
        structural_fact_cache_ms,
        project_pointer_ms,
        transaction_ms: transaction_started.elapsed().as_millis() as u64,
        total_ms: started.elapsed().as_millis() as u64,
    })
}

/// Returns only the fact cache attached to the SQLite-selected complete graph.
/// A missing or mismatched row is an expected cache miss; callers must submit a
/// full batch instead of attempting partial reconstruction.
pub fn current_structural_batch(
    connection: &Connection,
    project_id: &str,
    facts_digest: &str,
) -> rusqlite::Result<Option<serde_json::Value>> {
    let current_cache: Option<(i64, String)> = connection
        .query_row(
            "SELECT projects.project_pk, cache.envelope_json
             FROM projects
             INNER JOIN graph_versions versions
               ON versions.project_pk = projects.project_pk
              AND versions.graph_version = projects.current_graph_version
              AND versions.status = 'complete'
             INNER JOIN native_structural_batch_cache cache
               ON cache.project_pk = versions.project_pk
              AND cache.graph_version = versions.graph_version
              AND cache.facts_digest = versions.material_fingerprint
             WHERE projects.project_id = ?1 AND cache.facts_digest = ?2",
            rusqlite::params![project_id, facts_digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((project_pk, envelope_json)) = current_cache {
        let mut batch: serde_json::Value =
            serde_json::from_str(&envelope_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
        let object = batch.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
        let mut statement = connection.prepare(
            "SELECT payload_json FROM native_structural_batch_records
             WHERE project_pk = ?1 ORDER BY record_order, path",
        )?;
        let records = statement
            .query_map([project_pk], |row| row.get::<_, String>(0))?
            .map(|row| {
                let raw = row?;
                serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .collect::<Result<Vec<serde_json::Value>, _>>()?;
        object.insert("records".to_string(), serde_json::Value::Array(records));
        object.insert(
            "factsDigest".to_string(),
            serde_json::Value::String(facts_digest.to_string()),
        );
        return Ok(Some(batch));
    }
    // v7 fallback for a database upgraded before the next complete v8 graph
    // promotion. It is intentionally read-only and disappears on promotion.
    connection
        .query_row(
            "SELECT cache.payload_json
             FROM projects
             INNER JOIN graph_versions versions
               ON versions.project_pk = projects.project_pk
              AND versions.graph_version = projects.current_graph_version
              AND versions.status = 'complete'
             INNER JOIN native_structural_batches cache
               ON cache.project_pk = versions.project_pk
              AND cache.graph_version = versions.graph_version
              AND cache.facts_digest = versions.material_fingerprint
             WHERE projects.project_id = ?1 AND cache.facts_digest = ?2",
            rusqlite::params![project_id, facts_digest],
            |row| {
                let raw: String = row.get(0)?;
                serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            },
        )
        .optional()
}

pub fn recover_incomplete_graph_builds(
    connection: &mut Connection,
    project_id: &str,
) -> rusqlite::Result<usize> {
    let transaction = connection.transaction()?;
    let project_pk = project_pk(&transaction, project_id)?;
    let removed = transaction.execute(
        "DELETE FROM graph_versions WHERE project_pk = ?1 AND status = 'building'",
        [project_pk],
    )?;
    transaction.commit()?;
    Ok(removed)
}

pub fn current_complete_graph(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Option<NativeGraphVersion>> {
    connection
        .query_row(
            "SELECT versions.graph_version, versions.public_graph_version, versions.material_fingerprint, versions.source_fingerprint, versions.compatibility_digest
             FROM projects JOIN graph_versions AS versions
               ON versions.project_pk = projects.project_pk AND versions.graph_version = projects.current_graph_version
             WHERE projects.project_id = ?1 AND versions.status = 'complete'",
            [project_id],
            |row| {
                Ok(NativeGraphVersion {
                    graph_version: row.get(0)?,
                    public_graph_version: row.get(1)?,
                    material_fingerprint: row.get(2)?,
                    source_fingerprint: row.get(3)?,
                    compatibility_digest: row.get(4)?,
                })
            },
        )
        .optional()
}

fn stored_public_graph_payload(
    connection: &Connection,
    project_pk: i64,
    graph_version: i64,
    legacy_payload_json: Option<String>,
) -> rusqlite::Result<serde_json::Value> {
    if let Some(raw) = legacy_payload_json {
        return serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        });
    }
    let envelope_json: String = connection.query_row(
        "SELECT payload_json FROM native_public_graph_envelopes
         WHERE project_pk = ?1 AND graph_version = ?2",
        rusqlite::params![project_pk, graph_version],
        |row| row.get(0),
    )?;
    let mut payload: serde_json::Value = serde_json::from_str(&envelope_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let object = payload
        .as_object_mut()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let uses_history: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM native_public_graph_component_history
           WHERE project_pk = ?1 AND first_graph_version <= ?2
             AND (last_graph_version IS NULL OR last_graph_version >= ?2)
         )",
        rusqlite::params![project_pk, graph_version],
        |row| row.get(0),
    )?;
    for (field, kind) in NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS {
        let query = if uses_history {
            "SELECT components.payload_json
             FROM native_public_graph_component_history history
             JOIN native_public_graph_components components
               ON components.component_digest = history.component_digest
             WHERE history.project_pk = ?1
               AND history.component_kind = ?3
               AND history.first_graph_version <= ?2
               AND (history.last_graph_version IS NULL OR history.last_graph_version >= ?2)
             ORDER BY history.ordinal"
        } else {
            "SELECT components.payload_json
             FROM native_public_graph_memberships memberships
             JOIN native_public_graph_components components
               ON components.component_digest = memberships.component_digest
             WHERE memberships.project_pk = ?1
               AND memberships.graph_version = ?2
               AND memberships.component_kind = ?3
             ORDER BY memberships.ordinal"
        };
        let mut statement = connection.prepare(query)?;
        let values = statement
            .query_map(rusqlite::params![project_pk, graph_version, kind], |row| {
                row.get::<_, String>(0)
            })?
            .map(|row| {
                let raw = row?;
                serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .collect::<Result<Vec<serde_json::Value>, _>>()?;
        if !values.is_empty() {
            object.insert(field.to_string(), serde_json::Value::Array(values));
        }
    }
    Ok(payload)
}

pub fn complete_graph_payload(
    connection: &Connection,
    project_id: &str,
    graph_version: i64,
) -> rusqlite::Result<Option<NativeCompleteGraphPayload>> {
    let row = connection
        .query_row(
            "SELECT projects.project_pk, versions.graph_version, versions.public_graph_version, versions.payload_json, versions.compatibility_digest
             FROM projects JOIN graph_versions AS versions
               ON versions.project_pk = projects.project_pk
             WHERE projects.project_id = ?1 AND versions.graph_version = ?2 AND versions.status = 'complete'",
            rusqlite::params![project_id, graph_version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    row.map(
        |(project_pk, graph_version, public_graph_version, payload_json, compatibility_digest)| {
            Ok(NativeCompleteGraphPayload {
                graph_version,
                public_graph_version,
                payload: stored_public_graph_payload(
                    connection,
                    project_pk,
                    graph_version,
                    payload_json,
                )?,
                compatibility_digest,
            })
        },
    )
    .transpose()
}

pub fn complete_graph_payload_by_public_version(
    connection: &Connection,
    project_id: &str,
    public_graph_version: i64,
) -> rusqlite::Result<Option<NativeCompleteGraphPayload>> {
    let row = connection
        .query_row(
            "SELECT projects.project_pk, versions.graph_version, versions.public_graph_version, versions.payload_json, versions.compatibility_digest
             FROM projects JOIN graph_versions AS versions
               ON versions.project_pk = projects.project_pk
             WHERE projects.project_id = ?1 AND versions.public_graph_version = ?2 AND versions.status = 'complete'
             ORDER BY versions.graph_version DESC LIMIT 1",
            rusqlite::params![project_id, public_graph_version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    row.map(
        |(project_pk, graph_version, public_graph_version, payload_json, compatibility_digest)| {
            Ok(NativeCompleteGraphPayload {
                graph_version,
                public_graph_version,
                payload: stored_public_graph_payload(
                    connection,
                    project_pk,
                    graph_version,
                    payload_json,
                )?,
                compatibility_digest,
            })
        },
    )
    .transpose()
}

pub fn complete_graph_delta_by_public_versions(
    connection: &Connection,
    project_id: &str,
    from_public_graph_version: i64,
    to_public_graph_version: i64,
) -> rusqlite::Result<Option<serde_json::Value>> {
    connection
        .query_row(
            "SELECT deltas.payload_json
             FROM projects
             JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
             JOIN graph_versions AS source ON source.project_pk = projects.project_pk AND source.graph_version = deltas.from_graph_version
             JOIN graph_versions AS target ON target.project_pk = projects.project_pk AND target.graph_version = deltas.to_graph_version
             WHERE projects.project_id = ?1
               AND source.status = 'complete' AND target.status = 'complete'
               AND source.public_graph_version = ?2 AND target.public_graph_version = ?3",
            rusqlite::params![project_id, from_public_graph_version, to_public_graph_version],
            |row| {
                let payload_json: String = row.get(0)?;
                serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            },
        )
        .optional()
}

pub fn retained_public_delta_range(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Option<(i64, i64)>> {
    connection
        .query_row(
            "SELECT MIN(source.public_graph_version), MAX(target.public_graph_version)
             FROM projects
             JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
             JOIN graph_versions AS source ON source.project_pk = projects.project_pk AND source.graph_version = deltas.from_graph_version
             JOIN graph_versions AS target ON target.project_pk = projects.project_pk AND target.graph_version = deltas.to_graph_version
             WHERE projects.project_id = ?1
               AND source.status = 'complete' AND target.status = 'complete'",
            [project_id],
            |row| {
                let oldest: Option<i64> = row.get(0)?;
                let newest: Option<i64> = row.get(1)?;
                Ok(oldest.zip(newest))
            },
        )
        .optional()
        .map(|range| range.flatten())
}

fn native_delta_history_entries(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<NativeDeltaHistoryEntry>> {
    let mut statement = connection.prepare(
        "SELECT deltas.from_graph_version, deltas.to_graph_version,
                source.public_graph_version, target.public_graph_version,
                LENGTH(deltas.payload_json)
         FROM projects
         JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
         JOIN graph_versions AS source ON source.project_pk = projects.project_pk AND source.graph_version = deltas.from_graph_version
         JOIN graph_versions AS target ON target.project_pk = projects.project_pk AND target.graph_version = deltas.to_graph_version
         WHERE projects.project_id = ?1
           AND source.status = 'complete' AND target.status = 'complete'
         ORDER BY deltas.to_graph_version DESC, deltas.from_graph_version DESC",
    )?;
    statement
        .query_map([project_id], |row| {
            Ok(NativeDeltaHistoryEntry {
                from_graph_version: row.get(0)?,
                to_graph_version: row.get(1)?,
                from_public_graph_version: row.get(2)?,
                to_public_graph_version: row.get(3)?,
                bytes: row.get::<_, i64>(4)?.max(0) as usize,
            })
        })?
        .collect()
}

pub fn native_delta_retention_plan(
    connection: &Connection,
    project_id: &str,
    keep_deltas: usize,
    max_bytes: usize,
) -> rusqlite::Result<NativeDeltaRetentionPlan> {
    let keep_deltas = keep_deltas.max(1);
    let max_bytes = max_bytes.max(1);
    let entries = native_delta_history_entries(connection, project_id)?;
    let total_bytes = entries.iter().map(|entry| entry.bytes).sum();
    let mut retained = Vec::new();
    let mut prunable = Vec::new();
    let mut retained_bytes = 0;
    for entry in entries {
        let is_latest = retained.is_empty();
        let within_count = retained.len() < keep_deltas;
        let within_bytes = retained_bytes + entry.bytes <= max_bytes;
        if is_latest || (within_count && within_bytes) {
            retained_bytes += entry.bytes;
            retained.push(entry);
        } else {
            prunable.push(entry);
        }
    }
    let retention_exceeded_by_protected_latest = retained
        .first()
        .is_some_and(|entry| entry.bytes > max_bytes);
    Ok(NativeDeltaRetentionPlan {
        keep_deltas,
        max_bytes,
        total_deltas: retained.len() + prunable.len(),
        total_bytes,
        retained,
        prunable,
        retention_exceeded_by_protected_latest,
    })
}

pub fn prune_native_graph_deltas(
    connection: &mut Connection,
    project_id: &str,
    keep_deltas: usize,
    max_bytes: usize,
    dry_run: bool,
) -> rusqlite::Result<NativeDeltaPruneResult> {
    let plan = native_delta_retention_plan(connection, project_id, keep_deltas, max_bytes)?;
    let reclaimed_bytes = plan.prunable.iter().map(|entry| entry.bytes).sum();
    if !dry_run && !plan.prunable.is_empty() {
        let transaction = connection.transaction()?;
        let project_pk = project_pk(&transaction, project_id)?;
        for entry in &plan.prunable {
            transaction.execute(
                "DELETE FROM graph_deltas
                 WHERE project_pk = ?1 AND from_graph_version = ?2 AND to_graph_version = ?3",
                rusqlite::params![project_pk, entry.from_graph_version, entry.to_graph_version],
            )?;
        }
        transaction.commit()?;
    }
    Ok(NativeDeltaPruneResult {
        dry_run,
        pruned: plan.prunable,
        retained: plan.retained,
        reclaimed_bytes,
        retention_exceeded_by_protected_latest: plan.retention_exceeded_by_protected_latest,
    })
}

pub fn complete_graph_delta(
    connection: &Connection,
    project_id: &str,
    from_graph_version: i64,
    to_graph_version: i64,
) -> rusqlite::Result<Option<serde_json::Value>> {
    connection
        .query_row(
            "SELECT deltas.payload_json
             FROM projects JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
             WHERE projects.project_id = ?1 AND deltas.from_graph_version = ?2 AND deltas.to_graph_version = ?3",
            rusqlite::params![project_id, from_graph_version, to_graph_version],
            |row| {
                let payload_json: String = row.get(0)?;
                serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            },
        )
        .optional()
}

pub fn initialize_native_store(root: &Path) -> rusqlite::Result<NativeStoreStatus> {
    let database_path = root.join(NATIVE_STORE_RELATIVE_PATH);
    let connection = open_native_store(root)?;
    let journal_mode =
        connection.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?;
    let foreign_keys =
        connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?;
    let synchronous_mode =
        connection.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?;
    let busy_timeout_ms =
        connection.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))?;
    let quick_check =
        connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))?;
    if !quick_check.eq_ignore_ascii_case("ok") {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other(format!("SQLite quick_check failed: {quick_check}")),
        )));
    }
    Ok(NativeStoreStatus {
        path: database_path,
        schema_version: NATIVE_STORE_SCHEMA_VERSION,
        journal_mode,
        foreign_keys_enabled: foreign_keys == 1,
        synchronous_mode,
        busy_timeout_ms,
        quick_check,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        NATIVE_STORE_RELATIVE_PATH, NATIVE_STORE_SCHEMA_VERSION, NativeGraphPromotionRequest,
        NativeGraphVersion, begin_graph_build, complete_graph_delta, complete_graph_payload,
        current_complete_graph, current_structural_batch, initialize_native_store,
        native_delta_retention_plan, open_native_store, promote_graph_build,
        promote_graph_build_with_changed_records, prune_native_graph_deltas,
        recover_incomplete_graph_builds,
    };
    use crate::identity_store::{node_identity_by_external_id, node_identity_by_uid};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn initializes_a_wal_backed_store_outside_source_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let status = initialize_native_store(&root).unwrap();
        assert_eq!(status.schema_version, NATIVE_STORE_SCHEMA_VERSION);
        assert_eq!(status.journal_mode.to_lowercase(), "wal");
        assert!(status.foreign_keys_enabled);
        assert_eq!(
            status.synchronous_mode, 1,
            "SQLite NORMAL is pragma value 1"
        );
        assert_eq!(status.busy_timeout_ms, 5_000);
        assert_eq!(status.quick_check.to_lowercase(), "ok");
        assert!(status.path.ends_with(".flopeek/native-core.sqlite3"));
        let connection = open_native_store(&root).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            NATIVE_STORE_SCHEMA_VERSION
        );
        for table in [
            "projects_v2",
            "nodes_v2",
            "node_revisions_v2",
            "node_placements_v2",
            "edges_v2",
            "edge_evidence_v2",
            "node_external_ids_v2",
            "node_identity_aliases_v2",
            "edge_presence_v2",
            "placement_presence_v2",
        ] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                        [table],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1,
                "missing current schema table {table}"
            );
        }
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_future_schema_without_modifying_the_database() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-future-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(".flopeek")).unwrap();
        let path = root.join(NATIVE_STORE_RELATIVE_PATH);
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO metadata(key, value) VALUES ('schema_version', '999');
                 PRAGMA user_version = 999;",
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();
        let error = open_native_store(&root).unwrap_err();
        assert!(error.to_string().contains("newer than supported"));
        assert_eq!(fs::read(&path).unwrap(), before);
        let connection = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            999
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'projects'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_schema_metadata_disagreement_and_does_not_repair_current_schema() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-metadata-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let connection = open_native_store(&root).unwrap();
        connection
            .execute("DROP TABLE edge_presence_v2", [])
            .unwrap();
        drop(connection);
        let error = open_native_store(&root).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("missing required table edge_presence_v2")
        );
        let connection = rusqlite::Connection::open(root.join(NATIVE_STORE_RELATIVE_PATH)).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'edge_presence_v2'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "a declared-current but incomplete schema must not be silently repaired"
        );
        connection
            .execute(
                "UPDATE metadata SET value = '11' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        drop(connection);
        let error = open_native_store(&root).unwrap_err();
        assert!(error.to_string().contains("disagrees"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrates_v11_relationship_state_to_v12_presence_intervals_atomically() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-v11-migration-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let connection = open_native_store(&root).unwrap();
        connection
            .execute(
                "INSERT INTO projects(project_id, created_at_ms) VALUES ('project:migration', 1)",
                [],
            )
            .unwrap();
        let project_pk = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO projects_v2(project_pk, project_uid, public_project_id,
                   identity_status, created_at_ms)
                 VALUES (?1, ?2, 'project:migration', 'local', 1)",
                rusqlite::params![project_pk, [1_u8; 16].as_slice()],
            )
            .unwrap();
        for (uid, hash, identity) in [
            ([2_u8; 16], [3_u8; 32], [4_u8]),
            ([5_u8; 16], [6_u8; 32], [7_u8]),
        ] {
            connection
                .execute(
                    "INSERT INTO nodes_v2(project_pk, node_uid, kind, current_semantic_hash,
                       current_canonical_identity, first_seen_graph_version, status)
                     VALUES (?1, ?2, 'file', ?3, ?4, 1, 'active')",
                    rusqlite::params![
                        project_pk,
                        uid.as_slice(),
                        hash.as_slice(),
                        identity.as_slice()
                    ],
                )
                .unwrap();
        }
        let source_pk = connection
            .query_row(
                "SELECT MIN(node_pk) FROM nodes_v2 WHERE project_pk = ?1",
                [project_pk],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let target_pk = connection
            .query_row(
                "SELECT MAX(node_pk) FROM nodes_v2 WHERE project_pk = ?1",
                [project_pk],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO edges_v2(project_pk, edge_uid, source_node_pk, target_node_pk,
                   relation, qualifier_hash, canonical_qualifier, first_graph_version,
                   last_graph_version)
                 VALUES (?1, ?2, ?3, ?4, 'calls', ?5, X'', 1, NULL)",
                rusqlite::params![
                    project_pk,
                    [8_u8; 32].as_slice(),
                    source_pk,
                    target_pk,
                    [9_u8; 32].as_slice()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO node_placements_v2(project_pk, parent_node_pk, child_node_pk,
                   relation, placement_hash, first_graph_version, last_graph_version)
                 VALUES (?1, ?2, ?3, 'contains', ?4, 1, NULL)",
                rusqlite::params![project_pk, source_pk, target_pk, [10_u8; 32].as_slice()],
            )
            .unwrap();
        connection
            .execute("DROP TABLE edge_presence_v2", [])
            .unwrap();
        connection
            .execute("DROP TABLE placement_presence_v2", [])
            .unwrap();
        connection
            .execute(
                "UPDATE metadata SET value = '11' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 11).unwrap();
        drop(connection);

        let connection = open_native_store(&root).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            12
        );
        for table in ["edge_presence_v2", "placement_presence_v2"] {
            assert_eq!(
                connection
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE first_graph_version = 1 AND last_graph_version IS NULL"),
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1,
                "v11 current relationship must be preserved in {table}"
            );
        }
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_metadata_directory_symlink_escape() {
        use std::os::unix::fs::symlink;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-link-{}-{unique}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "flopeek-native-store-outside-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".flopeek")).unwrap();
        assert!(open_native_store(&root).is_err());
        assert!(!outside.join("native-core.sqlite3").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn refuses_metadata_directory_junction_escape() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-junction-{}-{unique}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "flopeek-native-store-junction-outside-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let junction = root.join(".flopeek");
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:FLOPEEK_TEST_JUNCTION -Target $env:FLOPEEK_TEST_JUNCTION_TARGET | Out-Null",
            ])
            .env("FLOPEEK_TEST_JUNCTION", &junction)
            .env("FLOPEEK_TEST_JUNCTION_TARGET", &outside)
            .status()
            .unwrap();
        assert!(status.success(), "test fixture junction must be created");
        assert!(open_native_store(&root).is_err());
        assert!(!outside.join("native-core.sqlite3").exists());
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn rejects_a_corrupt_database_before_reporting_store_ready() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-store-corrupt-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(".flopeek")).unwrap();
        fs::write(
            root.join(NATIVE_STORE_RELATIVE_PATH),
            b"this is not a SQLite database",
        )
        .unwrap();
        assert!(initialize_native_store(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn promotes_only_complete_graphs_and_recovers_building_candidates() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-lifecycle-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let digest_one = format!("sha256:{}", "1".repeat(64));
        let digest_two = format!("sha256:{}", "2".repeat(64));
        let first = begin_graph_build(&mut connection, "project:fixture", "material:1", "source:1")
            .unwrap();
        assert_eq!(
            current_complete_graph(&connection, "project:fixture").unwrap(),
            None
        );
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: "project:fixture",
                graph_version: first.graph_version,
                public_graph_version: 0,
                payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [] }),
                compatibility_digest: &digest_one,
                adjacent_delta: None,
                facts_digest: None,
                structural_batch: None,
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        let first_complete = NativeGraphVersion {
            public_graph_version: Some(0),
            compatibility_digest: Some(digest_one.clone()),
            ..first.clone()
        };
        assert_eq!(
            current_complete_graph(&connection, "project:fixture").unwrap(),
            Some(first_complete.clone())
        );
        let invalid = begin_graph_build(
            &mut connection,
            "project:fixture",
            "material:invalid",
            "source:invalid",
        )
        .unwrap();
        assert!(
            promote_graph_build(
                &mut connection,
                NativeGraphPromotionRequest {
                    project_id: "project:fixture",
                    graph_version: invalid.graph_version,
                    public_graph_version: 1,
                    payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [] }),
                    compatibility_digest: "not-a-sha256-digest",
                    adjacent_delta: None,
                    facts_digest: None,
                    structural_batch: None,
                    changed_record_paths: None,
                    reuse_public_components: false
                },
            )
            .is_err()
        );
        assert_eq!(
            current_complete_graph(&connection, "project:fixture").unwrap(),
            Some(first_complete.clone())
        );
        assert_eq!(
            recover_incomplete_graph_builds(&mut connection, "project:fixture").unwrap(),
            1
        );
        let interrupted =
            begin_graph_build(&mut connection, "project:fixture", "material:2", "source:2")
                .unwrap();
        assert_eq!(
            recover_incomplete_graph_builds(&mut connection, "project:fixture").unwrap(),
            1
        );
        assert_eq!(
            current_complete_graph(&connection, "project:fixture").unwrap(),
            Some(first_complete)
        );
        assert!(
            promote_graph_build(
                &mut connection,
                NativeGraphPromotionRequest {
                    project_id: "project:fixture",
                    graph_version: interrupted.graph_version,
                    public_graph_version: 1,
                    payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [] }),
                    compatibility_digest: &digest_one,
                    adjacent_delta: None,
                    facts_digest: None,
                    structural_batch: None,
                    changed_record_paths: None,
                    reuse_public_components: false
                },
            )
            .is_err()
        );
        let second =
            begin_graph_build(&mut connection, "project:fixture", "material:3", "source:3")
                .unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: "project:fixture",
                graph_version: second.graph_version,
                public_graph_version: 1,
                payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [] }),
                compatibility_digest: &digest_two,
                adjacent_delta: Some(&json!({ "added": ["node:next"] })),
                facts_digest: None,
                structural_batch: None,
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            current_complete_graph(&connection, "project:fixture").unwrap(),
            Some(NativeGraphVersion {
                public_graph_version: Some(1),
                compatibility_digest: Some(digest_two),
                ..second
            })
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stores_public_graph_components_once_and_reconstructs_historical_payloads() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-component-store-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:components";
        let first_payload = json!({
            "schemaVersion": "native-shadow/v1",
            "project": { "projectId": project },
            "nodes": [
                { "id": "file:src/a.js", "kind": "file", "path": "src/a.js" },
                { "id": "symbol:src/a.js:function:a", "kind": "symbol", "label": "a" }
            ],
            "edges": [{
                "source": "file:src/a.js",
                "target": "symbol:src/a.js:function:a",
                "type": "contains",
                "confidence": "high",
                "evidence": {
                    "file": "src/a.js",
                    "parser": "fixture",
                    "parserVersion": "1",
                    "range": {
                        "start": { "line": 1, "column": 1 },
                        "end": { "line": 1, "column": 10 }
                    }
                }
            }],
            "flows": [{ "id": "flow:symbol:src/a.js:function:a", "entryId": "symbol:src/a.js:function:a", "steps": [] }],
            "diagnosticFlows": [{ "id": "flow:symbol:src/a.js:function:a", "entryId": "symbol:src/a.js:function:a", "steps": [] }],
        });
        let first =
            begin_graph_build(&mut connection, project, "material:one", "source:one").unwrap();
        let digest_one = format!("sha256:{}", "1".repeat(64));
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: first.graph_version,
                public_graph_version: 1,
                payload: &first_payload,
                compatibility_digest: &digest_one,
                adjacent_delta: None,
                facts_digest: None,
                structural_batch: None,
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            complete_graph_payload(&connection, project, first.graph_version)
                .unwrap()
                .unwrap()
                .payload,
            first_payload
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM nodes_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM node_revisions_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM edges_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM edge_evidence_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM node_placements_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM nodes_v2 AS child
                     JOIN nodes_v2 AS owner ON owner.node_pk = child.lexical_owner_pk
                     WHERE child.kind = 'symbol' AND owner.kind = 'file'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let symbol_identity =
            node_identity_by_external_id(&connection, project, "symbol:src/a.js:function:a")
                .unwrap()
                .expect("dual-write creates a canonical symbol identity");
        assert!(symbol_identity.node_uid.starts_with("n_"));
        assert_eq!(
            symbol_identity.legacy_id.as_deref(),
            Some("symbol:src/a.js:function:a")
        );
        assert_eq!(symbol_identity.status, "active");
        assert_eq!(
            node_identity_by_uid(&connection, project, &symbol_identity.node_uid)
                .unwrap()
                .expect("canonical UID resolves")
                .node_pk,
            symbol_identity.node_pk
        );
        let (project_pk, symbol_uid) = connection
            .query_row(
                "SELECT project_pk, node_uid FROM nodes_v2 WHERE node_pk = ?1",
                [symbol_identity.node_pk],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .unwrap();
        assert!(
            connection
                .execute(
                    "INSERT INTO node_identity_aliases_v2(project_pk, old_node_uid,
                       current_node_pk, reason, confidence, created_graph_version)
                     VALUES (?1, ?2, ?3, 'invalid-self-test', 'high', 1)",
                    rusqlite::params![project_pk, symbol_uid, symbol_identity.node_pk],
                )
                .is_err(),
            "alias invariants must reject self-targeting identities"
        );
        let legacy_payload: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM graph_versions WHERE project_pk = (SELECT project_pk FROM projects WHERE project_id = ?1) AND graph_version = ?2",
                rusqlite::params![project, first.graph_version],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_payload, None);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_components",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            5
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_component_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            5
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_memberships",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0,
            "v10 must not rewrite a complete membership list for every version"
        );

        let mut second_payload = first_payload.clone();
        second_payload["nodes"][1]["label"] = json!("renamed");
        let second =
            begin_graph_build(&mut connection, project, "material:two", "source:two").unwrap();
        let digest_two = format!("sha256:{}", "2".repeat(64));
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: second.graph_version,
                public_graph_version: 2,
                payload: &second_payload,
                compatibility_digest: &digest_two,
                adjacent_delta: None,
                facts_digest: None,
                structural_batch: None,
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            complete_graph_payload(&connection, project, first.graph_version)
                .unwrap()
                .unwrap()
                .payload,
            first_payload
        );
        assert_eq!(
            complete_graph_payload(&connection, project, second.graph_version)
                .unwrap()
                .unwrap()
                .payload,
            second_payload
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM nodes_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2,
            "a display-name change must preserve durable node UIDs"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM node_revisions_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3,
            "only the changed symbol opens a new revision interval"
        );
        // One changed node creates exactly one new content-addressed component;
        // all unchanged node, edge, and flow payloads are re-used.
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_components",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            6
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_component_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            6,
            "only the changed node opens a new membership interval"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_component_history WHERE last_graph_version IS NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            5
        );

        // A source-only refresh changes envelope metadata such as the source
        // fingerprint but reuses the exact public collections.  It must
        // reconstruct the newest historical payload without opening, closing,
        // hashing, or rewriting any component membership interval.
        let third =
            begin_graph_build(&mut connection, project, "material:three", "source:three").unwrap();
        let digest_three = format!("sha256:{}", "3".repeat(64));
        promote_graph_build_with_changed_records(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: third.graph_version,
                public_graph_version: 3,
                payload: &second_payload,
                compatibility_digest: &digest_three,
                adjacent_delta: None,
                facts_digest: None,
                structural_batch: None,
                changed_record_paths: None,
                reuse_public_components: true,
            },
        )
        .unwrap();
        assert_eq!(
            complete_graph_payload(&connection, project, third.graph_version)
                .unwrap()
                .unwrap()
                .payload,
            second_payload
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_components",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            6,
            "source-only reuse must not write a duplicate component"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM native_public_graph_component_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            6,
            "source-only reuse must preserve the open membership intervals"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM node_revisions_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3,
            "a no-op identity projection must not duplicate revisions"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM edge_evidence_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1,
            "stable evidence is one occurrence interval across refreshes"
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_store_preserves_java_overloads_outside_public_v1_projection() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-identity-overloads-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:identity-overloads";
        let digest = format!("sha256:{}", "a".repeat(64));
        let payload = json!({
            "schemaVersion": "native-shadow/v1",
            "nodes": [
                { "id": "file:src/OrderService.java", "kind": "file", "type": "module", "path": "src/OrderService.java" },
                { "id": "symbol:src/OrderService.java:class:OrderService", "kind": "symbol", "type": "class", "path": "src/OrderService.java", "label": "OrderService" }
            ],
            "edges": [{ "source": "file:src/OrderService.java", "target": "symbol:src/OrderService.java:class:OrderService", "type": "contains" }],
            "flows": [],
            "diagnosticFlows": []
        });
        let method = |signature: &str, line: i64| {
            json!({
                "type": "method",
                "name": "save",
                "methods": [],
                "evidence": { "parser": "tree-sitter-java", "file": "src/OrderService.java", "range": { "start": { "line": line, "column": 1 }, "end": { "line": line, "column": 20 } } },
                "identity": {
                    "qualifiedName": "OrderService.save",
                    "lexicalOwner": { "type": "class", "name": "OrderService" },
                    "signature": signature,
                    "discriminator": "instance-method"
                }
            })
        };
        let batch = json!({
            "schemaVersion": "flopeek-structural-fact-batch/v1",
            "projectId": project,
            "records": [{
                "recordOrder": 0,
                "relativePath": "src/OrderService.java",
                "language": "java",
                "sourceHash": "b".repeat(64),
                "result": { "identitySymbols": [method("(Order):void", 2), method("(Order,User):void", 3)] }
            }],
            "factsDigest": digest,
        });
        let candidate =
            begin_graph_build(&mut connection, project, "material:one", "source:one").unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: candidate.graph_version,
                public_graph_version: 1,
                payload: &payload,
                compatibility_digest: &format!("sha256:{}", "c".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&digest),
                structural_batch: Some(&batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM nodes_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(DISTINCT nodes.node_uid) FROM nodes_v2 AS nodes WHERE nodes.kind = 'method'", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(DISTINCT signature) FROM node_revisions_v2 WHERE signature LIKE '(Order%'", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM node_external_ids_v2 WHERE scheme = 'parser-symbol-v2' AND last_graph_version IS NULL", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        connection
            .execute(
                "UPDATE nodes_v2 SET current_semantic_hash =
                   (SELECT current_semantic_hash FROM nodes_v2 WHERE kind <> 'file' LIMIT 1)
                 WHERE kind = 'file'",
                [],
            )
            .unwrap();
        let collision_candidate = begin_graph_build(
            &mut connection,
            project,
            "material:collision",
            "source:collision",
        )
        .unwrap();
        let collision = promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: collision_candidate.graph_version,
                public_graph_version: 2,
                payload: &payload,
                compatibility_digest: &format!("sha256:{}", "d".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&digest),
                structural_batch: Some(&batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap_err();
        assert!(
            collision
                .to_string()
                .contains("fatal node semantic hash collision")
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_edge_preserves_distinct_callsite_occurrences() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-edge-occurrences-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:edge-occurrences";
        let digest = format!("sha256:{}", "a".repeat(64));
        let evidence = |line: i64| {
            json!({
                "parser": "typescript-ast",
                "file": "src/orders.ts",
                "range": { "start": { "line": line, "column": 1 }, "end": { "line": line, "column": 14 } }
            })
        };
        let payload = json!({
            "schemaVersion": "native-shadow/v1",
            "nodes": [
                { "id": "file:src/orders.ts", "kind": "file", "type": "module", "path": "src/orders.ts" },
                { "id": "symbol:src/orders.ts:function:run", "kind": "symbol", "type": "function", "path": "src/orders.ts", "label": "run" },
                { "id": "symbol:src/orders.ts:function:submit", "kind": "symbol", "type": "function", "path": "src/orders.ts", "label": "submit" }
            ],
            "edges": [{
                "source": "symbol:src/orders.ts:function:run",
                "target": "symbol:src/orders.ts:function:submit",
                "type": "calls",
                "confidence": "exact",
                "evidence": evidence(2)
            }],
            "flows": [],
            "diagnosticFlows": []
        });
        let batch = json!({
            "schemaVersion": "flopeek-structural-fact-batch/v1",
            "projectId": project,
            "records": [{
                "recordOrder": 0,
                "relativePath": "src/orders.ts",
                "language": "typescript",
                "sourceHash": "b".repeat(64),
                "result": { "calls": [
                    { "name": "submit", "source": { "type": "function", "name": "run" }, "imported": null, "evidence": evidence(2) },
                    { "name": "submit", "source": { "type": "function", "name": "run" }, "imported": null, "evidence": evidence(8) }
                ] }
            }],
            "factsDigest": digest,
        });
        let candidate =
            begin_graph_build(&mut connection, project, "material:one", "source:one").unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: candidate.graph_version,
                public_graph_version: 1,
                payload: &payload,
                compatibility_digest: &format!("sha256:{}", "c".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&digest),
                structural_batch: Some(&batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM edges_v2 WHERE relation = 'calls'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM edge_evidence_v2 WHERE last_graph_version IS NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relationship_presence_retains_absent_then_reappeared_intervals() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-presence-intervals-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:presence-intervals";
        let nodes = json!([
            { "id": "file:src/a.js", "kind": "file", "type": "module", "path": "src/a.js" },
            { "id": "symbol:src/a.js:function:a", "kind": "symbol", "type": "function", "path": "src/a.js", "label": "a" },
            { "id": "symbol:src/a.js:function:b", "kind": "symbol", "type": "function", "path": "src/a.js", "label": "b" }
        ]);
        let evidence = json!({
            "parser": "typescript-ast",
            "file": "src/a.js",
            "range": { "start": { "line": 1, "column": 1 }, "end": { "line": 1, "column": 8 } }
        });
        let present_edges = json!([
            { "source": "file:src/a.js", "target": "symbol:src/a.js:function:a", "type": "contains" },
            { "source": "symbol:src/a.js:function:a", "target": "symbol:src/a.js:function:b", "type": "calls", "confidence": "exact", "evidence": evidence }
        ]);

        for (public_version, present) in
            [(1_i64, true), (2, false), (3, true), (4, false), (5, true)]
        {
            let digest = format!("sha256:{}", format!("{public_version:x}").repeat(64));
            let payload = json!({
                "schemaVersion": "native-shadow/v1",
                "nodes": nodes.clone(),
                "edges": if present { present_edges.clone() } else { json!([]) },
                "flows": [],
                "diagnosticFlows": []
            });
            let batch = json!({
                "schemaVersion": "flopeek-structural-fact-batch/v1",
                "projectId": project,
                "records": [{
                    "recordOrder": 0,
                    "relativePath": "src/a.js",
                    "language": "javascript",
                    "sourceHash": format!("{:064x}", public_version),
                    "result": { "calls": if present { json!([{
                        "name": "b",
                        "source": { "type": "function", "name": "a" },
                        "imported": null,
                        "evidence": evidence.clone()
                    }]) } else { json!([]) } }
                }],
                "factsDigest": digest
            });
            let candidate = begin_graph_build(
                &mut connection,
                project,
                &format!("material:{public_version}"),
                &format!("source:{public_version}"),
            )
            .unwrap();
            promote_graph_build(
                &mut connection,
                NativeGraphPromotionRequest {
                    project_id: project,
                    graph_version: candidate.graph_version,
                    public_graph_version: public_version,
                    payload: &payload,
                    compatibility_digest: &format!("sha256:{}", "f".repeat(64)),
                    adjacent_delta: None,
                    facts_digest: Some(&digest),
                    structural_batch: Some(&batch),
                    changed_record_paths: None,
                    reuse_public_components: false,
                },
            )
            .unwrap();
        }

        let edge_intervals = connection
            .prepare(
                "SELECT presence.first_graph_version, presence.last_graph_version
                 FROM edge_presence_v2 AS presence
                 JOIN edges_v2 AS edge ON edge.edge_pk = presence.edge_pk
                 WHERE edge.relation = 'calls'
                 ORDER BY presence.first_graph_version",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(edge_intervals, vec![(1, Some(1)), (3, Some(3)), (5, None)]);

        let placement_intervals = connection
            .prepare(
                "SELECT presence.first_graph_version, presence.last_graph_version
                 FROM placement_presence_v2 AS presence
                 JOIN node_placements_v2 AS placement
                   ON placement.placement_pk = presence.placement_pk
                 WHERE placement.relation = 'contains'
                 ORDER BY presence.first_graph_version",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            placement_intervals,
            vec![(1, Some(1)), (3, Some(3)), (5, None)]
        );
        let evidence_intervals = connection
            .prepare(
                "SELECT first_graph_version, last_graph_version
                 FROM edge_evidence_v2
                 ORDER BY first_graph_version",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            evidence_intervals,
            vec![(1, Some(1)), (3, Some(3)), (5, None)]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM edge_presence_v2
                     WHERE first_graph_version <= 2
                       AND (last_graph_version IS NULL OR last_graph_version >= 2)",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "the relationship must be historically absent at graph version 2"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM edge_presence_v2
                     WHERE first_graph_version <= 4
                       AND (last_graph_version IS NULL OR last_graph_version >= 4)",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "the relationship must remain historically absent after another reappearance"
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_external_import_roots_are_namespaced_by_ecosystem() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-external-ecosystems-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:external-ecosystems";
        let digest = format!("sha256:{}", "a".repeat(64));
        let payload = json!({
            "schemaVersion": "native-shadow/v1",
            "nodes": [
                { "id": "file:src/client.ts", "kind": "file", "type": "module", "path": "src/client.ts" },
                { "id": "file:src/client.py", "kind": "file", "type": "module", "path": "src/client.py" },
                { "id": "external:requests", "kind": "external", "type": "external", "label": "Requests" }
            ],
            "edges": [], "flows": [], "diagnosticFlows": []
        });
        let external = json!({ "specifier": "requests", "nodeType": "external", "metadata": {} });
        let batch = json!({
            "schemaVersion": "flopeek-structural-fact-batch/v1", "projectId": project,
            "records": [
                { "recordOrder": 0, "relativePath": "src/client.py", "language": "python", "sourceHash": "b".repeat(64), "result": { "externalImports": [external.clone()] } },
                { "recordOrder": 1, "relativePath": "src/client.ts", "language": "typescript", "sourceHash": "c".repeat(64), "result": { "externalImports": [external] } }
            ],
            "factsDigest": digest
        });
        let candidate =
            begin_graph_build(&mut connection, project, "material:one", "source:one").unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: candidate.graph_version,
                public_graph_version: 1,
                payload: &payload,
                compatibility_digest: &format!("sha256:{}", "d".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&digest),
                structural_batch: Some(&batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        let ecosystems = {
            let mut statement = connection
                .prepare(
                    "SELECT nodes.ecosystem FROM node_external_ids_v2 AS external
                 JOIN nodes_v2 AS nodes ON nodes.node_pk = external.node_pk
                     WHERE external.scheme = 'external-import-root-v1' ORDER BY nodes.ecosystem",
                )
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(ecosystems, ["npm", "pypi"]);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_external_import_root_collapses_subpaths_and_preserves_specifiers() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-external-import-roots-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:external-import-roots";
        let digest = format!("sha256:{}", "a".repeat(64));
        let payload = json!({
            "schemaVersion": "native-shadow/v1",
            "nodes": [
                { "id": "file:src/client.ts", "kind": "file", "type": "module", "path": "src/client.ts" }
            ],
            "edges": [], "flows": [], "diagnosticFlows": []
        });
        let batch = json!({
            "schemaVersion": "flopeek-structural-fact-batch/v1", "projectId": project,
            "records": [{
                "recordOrder": 0,
                "relativePath": "src/client.ts",
                "language": "typescript",
                "sourceHash": "b".repeat(64),
                "result": {
                    "externalImports": [
                        { "specifier": "lodash/map", "nodeType": "external", "metadata": {} },
                        { "specifier": "lodash/get", "nodeType": "external", "metadata": {} }
                    ]
                }
            }],
            "factsDigest": digest
        });
        let candidate =
            begin_graph_build(&mut connection, project, "material:one", "source:one").unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: candidate.graph_version,
                public_graph_version: 1,
                payload: &payload,
                compatibility_digest: &format!("sha256:{}", "d".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&digest),
                structural_batch: Some(&batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();

        let metadata_json = connection
            .query_row(
                "SELECT revisions.metadata_json
                 FROM node_revisions_v2 AS revisions
                 JOIN nodes_v2 AS nodes ON nodes.node_pk = revisions.node_pk
                 WHERE nodes.kind = 'external' AND nodes.ecosystem = 'npm'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&metadata_json).unwrap();
        assert_eq!(metadata["canonicalImportRoot"], "lodash");
        assert_eq!(
            metadata["observedSpecifiers"],
            json!(["lodash/get", "lodash/map"])
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM nodes_v2
                     WHERE kind = 'external' AND ecosystem = 'npm'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reconstructs_the_current_structural_batch_from_record_level_cache() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-record-level-cache-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let project = "project:record-cache";
        let make_batch = |facts_digest: String, records: serde_json::Value| {
            json!({
                "schemaVersion": "flopeek-structural-fact-batch/v1",
                "projectId": project,
                "records": records,
                "packageCommands": [],
                "entryMetadata": {},
                "entryEdgeMetadata": {},
                "manualDescriptions": {},
                "flowContext": { "projectId": project, "graphVersion": 1 },
                "flowEntries": { "primary": { "tests": false, "fixtures": false }, "diagnostic": { "tests": true, "fixtures": true } },
                "lifecycleContext": { "sourceFingerprint": facts_digest, "sourceRevision": null, "updatedAt": "2026-01-01T00:00:00.000Z", "refresh": {} },
                "publicGraphContext": { "state": { "graphVersion": 1 } },
                "factsDigest": facts_digest,
            })
        };
        let facts_one = format!("sha256:{}", "1".repeat(64));
        let first_batch = make_batch(
            facts_one.clone(),
            json!([{
                "recordOrder": 0, "relativePath": "src/one.js", "sourceHash": "a".repeat(64), "sourceScope": "application", "result": {}
            }, {
                "recordOrder": 1, "relativePath": "src/two.js", "sourceHash": "b".repeat(64), "sourceScope": "application", "result": {}
            }]),
        );
        let first = begin_graph_build(&mut connection, project, &facts_one, &facts_one).unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: first.graph_version,
                public_graph_version: 1,
                payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [] }),
                compatibility_digest: &format!("sha256:{}", "c".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&facts_one),
                structural_batch: Some(&first_batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            current_structural_batch(&connection, project, &facts_one).unwrap(),
            Some(first_batch.clone())
        );

        let facts_two = format!("sha256:{}", "2".repeat(64));
        let second_batch = make_batch(
            facts_two.clone(),
            json!([{
                "recordOrder": 0, "relativePath": "src/one.js", "sourceHash": "d".repeat(64), "sourceScope": "application", "result": { "symbols": [{ "type": "function", "name": "changed" }] }
            }]),
        );
        let second = begin_graph_build(&mut connection, project, &facts_two, &facts_two).unwrap();
        promote_graph_build(
            &mut connection,
            NativeGraphPromotionRequest {
                project_id: project,
                graph_version: second.graph_version,
                public_graph_version: 2,
                payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [] }),
                compatibility_digest: &format!("sha256:{}", "e".repeat(64)),
                adjacent_delta: None,
                facts_digest: Some(&facts_two),
                structural_batch: Some(&second_batch),
                changed_record_paths: None,
                reuse_public_components: false,
            },
        )
        .unwrap();
        assert_eq!(
            current_structural_batch(&connection, project, &facts_two).unwrap(),
            Some(second_batch)
        );
        assert_eq!(
            current_structural_batch(&connection, project, &facts_one).unwrap(),
            None
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delta_retention_is_explicit_dry_run_first_and_preserves_latest_delta() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-retention-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_native_store(&root).unwrap();
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut versions = Vec::new();
        for public_graph_version in 0..=10 {
            let candidate = begin_graph_build(
                &mut connection,
                "project:retention",
                &format!("material:{public_graph_version}"),
                &format!("source:{public_graph_version}"),
            )
            .unwrap();
            let delta = (public_graph_version > 0).then(|| {
                json!({
                    "schemaVersion": "flopeek-delta/v1",
                    "fromGraphVersion": public_graph_version - 1,
                    "toGraphVersion": public_graph_version,
                    "padding": "x".repeat(128),
                })
            });
            promote_graph_build(
                &mut connection,
                NativeGraphPromotionRequest { project_id: "project:retention", graph_version: candidate.graph_version, public_graph_version, payload: &json!({ "schemaVersion": "native-shadow/v1", "nodes": [], "version": public_graph_version }), compatibility_digest: &digest, adjacent_delta: delta.as_ref(), facts_digest: None, structural_batch: None, changed_record_paths: None, reuse_public_components: false },
            )
            .unwrap();
            versions.push(candidate.graph_version);
        }

        let plan =
            native_delta_retention_plan(&connection, "project:retention", 8, usize::MAX).unwrap();
        assert_eq!(plan.total_deltas, 10);
        assert_eq!(plan.retained.len(), 8);
        assert_eq!(plan.prunable.len(), 2);
        assert_eq!(plan.retained[0].to_public_graph_version, 10);

        let dry_run =
            prune_native_graph_deltas(&mut connection, "project:retention", 8, usize::MAX, true)
                .unwrap();
        assert_eq!(dry_run.pruned.len(), 2);
        assert!(
            complete_graph_delta(&connection, "project:retention", versions[1], versions[2],)
                .unwrap()
                .is_some()
        );

        let applied =
            prune_native_graph_deltas(&mut connection, "project:retention", 8, usize::MAX, false)
                .unwrap();
        assert_eq!(applied.pruned.len(), 2);
        assert!(
            complete_graph_delta(&connection, "project:retention", versions[1], versions[2],)
                .unwrap()
                .is_none()
        );
        assert!(
            complete_graph_delta(&connection, "project:retention", versions[9], versions[10],)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            current_complete_graph(&connection, "project:retention")
                .unwrap()
                .unwrap()
                .public_graph_version,
            Some(10)
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
