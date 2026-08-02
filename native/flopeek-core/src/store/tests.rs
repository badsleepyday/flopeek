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
    let first =
        begin_graph_build(&mut connection, "project:fixture", "material:1", "source:1").unwrap();
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
        begin_graph_build(&mut connection, "project:fixture", "material:2", "source:2").unwrap();
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
        begin_graph_build(&mut connection, "project:fixture", "material:3", "source:3").unwrap();
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
    let first = begin_graph_build(&mut connection, project, "material:one", "source:one").unwrap();
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
    let second = begin_graph_build(&mut connection, project, "material:two", "source:two").unwrap();
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

    for (public_version, present) in [(1_i64, true), (2, false), (3, true), (4, false), (5, true)] {
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
