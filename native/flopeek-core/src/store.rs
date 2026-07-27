use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

pub const NATIVE_STORE_SCHEMA_VERSION: i64 = 4;
pub const NATIVE_STORE_RELATIVE_PATH: &str = ".flopeek/native-core.sqlite3";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeStoreStatus {
    pub path: PathBuf,
    pub schema_version: i64,
    pub journal_mode: String,
    pub foreign_keys_enabled: bool,
}

pub fn open_native_store(root: &Path) -> rusqlite::Result<Connection> {
    let metadata_directory = root.join(".flopeek");
    fs::create_dir_all(&metadata_directory)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let database_path = root.join(NATIVE_STORE_RELATIVE_PATH);
    let connection = Connection::open(&database_path)?;
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          project_pk INTEGER PRIMARY KEY,
          project_id TEXT NOT NULL UNIQUE,
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
        ",
    )?;
    let has_source_scope = {
        let mut statement = connection.prepare("PRAGMA table_info(inventory_files)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "source_scope")
    };
    if !has_source_scope {
        connection.execute("ALTER TABLE inventory_files ADD COLUMN source_scope TEXT NOT NULL DEFAULT 'application'", [])?;
    }
    connection.execute(
        "INSERT INTO metadata(key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [NATIVE_STORE_SCHEMA_VERSION.to_string()],
    )?;
    Ok(connection)
}

pub fn initialize_native_store(root: &Path) -> rusqlite::Result<NativeStoreStatus> {
    let database_path = root.join(NATIVE_STORE_RELATIVE_PATH);
    let connection = open_native_store(root)?;
    let journal_mode =
        connection.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?;
    let foreign_keys =
        connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?;
    Ok(NativeStoreStatus {
        path: database_path,
        schema_version: NATIVE_STORE_SCHEMA_VERSION,
        journal_mode,
        foreign_keys_enabled: foreign_keys == 1,
    })
}

#[cfg(test)]
mod tests {
    use super::{NATIVE_STORE_SCHEMA_VERSION, initialize_native_store};
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
        assert!(status.path.ends_with(".flopeek/native-core.sqlite3"));
        fs::remove_dir_all(root).unwrap();
    }
}
