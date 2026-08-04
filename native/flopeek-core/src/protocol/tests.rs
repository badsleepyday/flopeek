use super::{
    NATIVE_PROTOCOL_VERSION, NativeProtocolSession, NativeRequest, STRUCTURAL_FACT_BATCH_SCHEMA,
    STRUCTURAL_FACT_PATCH_SCHEMA, build_isolated_incremental_graph,
    get_native_database_open_evidence, handle_request, hydrate_cached_query_batch,
    hydrate_session_query_batch, isolated_structural_change_path, native_entry_source_nodes,
    native_query_cache_key, parse_session_history_limit, projection_digest,
    refresh_native_js_session_graph, refresh_native_persistent_project,
    refresh_native_session_graph, same_canonical_json, serve_jsonl,
    structural_facts_canonical_json, structural_facts_digest, structural_topology_digest,
};
use crate::store::open_native_store;
use crate::structural_graph::build_structural_graph;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::time::{SystemTime, UNIX_EPOCH};

// Independent Rust oracle for JavaScript core-compatibility `stableJson`:
// object keys sort recursively, while array order and JSON scalar encoding stay
// unchanged. Do not depend on serde_json Map's compile-time storage policy.
fn stable_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(entries) => {
            let mut keys = entries.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("object key serializes"),
                        stable_json(&entries[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        scalar => serde_json::to_string(scalar).expect("JSON scalar serializes"),
    }
}

fn responses(input: &str) -> Vec<Value> {
    let mut output = Vec::new();
    serve_jsonl(Cursor::new(input.as_bytes()), &mut output).unwrap();
    String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn responses_with_history(input: &str, history_limit: usize) -> Vec<Value> {
    let mut session = NativeProtocolSession::with_history_limit(history_limit);
    input
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let request = serde_json::from_str::<NativeRequest>(line).unwrap();
            serde_json::to_value(handle_request(&mut session, request).0).unwrap()
        })
        .collect()
}

fn request(request_id: &str, method: &str, params: Value) -> String {
    serde_json::to_string(&json!({
        "protocolVersion": NATIVE_PROTOCOL_VERSION,
        "requestId": request_id,
        "method": method,
        "params": params,
    }))
    .unwrap()
}

#[test]
fn immutable_query_memo_is_digest_bound_and_precedes_fact_hydration() {
    let params = json!({
        "projectRoot": "/definitely/not/a/repository",
        "projectId": "project:memo",
        "factsDigest": format!("sha256:{}", "a".repeat(64)),
        "query": "cached",
    });
    let key = native_query_cache_key("findNodes", &params).unwrap();
    let changed_key = native_query_cache_key(
        "findNodes",
        &json!({
            "projectRoot": "/definitely/not/a/repository",
            "projectId": "project:memo",
            "factsDigest": format!("sha256:{}", "b".repeat(64)),
            "query": "cached",
        }),
    )
    .unwrap();
    assert_ne!(key, changed_key);

    let mut session = NativeProtocolSession::default();
    session.retain_query_result(
        key,
        super::success_response(
            "original-request".to_string(),
            json!({ "query": "cached", "results": [] }),
        ),
    );
    let response = handle_request(
        &mut session,
        NativeRequest {
            protocol_version: NATIVE_PROTOCOL_VERSION.to_string(),
            request_id: "memo-hit".to_string(),
            method: "findNodes".to_string(),
            params,
        },
    )
    .0;
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["status"], "ok");
    assert_eq!(response["requestId"], "memo-hit");
    assert_eq!(
        response["result"],
        json!({ "query": "cached", "results": [] })
    );

    let missing_params = json!({
        "projectRoot": "/definitely/not/a/repository",
        "projectId": "project:memo",
        "factsDigest": format!("sha256:{}", "a".repeat(64)),
        "flowId": "flow:missing",
    });
    let missing_key = native_query_cache_key("getNativeFlowLensCore", &missing_params).unwrap();
    session.retain_query_result(
        missing_key,
        super::error_response(
            Some("original-missing".to_string()),
            "missing-flow",
            "No native flow matches params.flowId.",
        ),
    );
    let missing = handle_request(
        &mut session,
        NativeRequest {
            protocol_version: NATIVE_PROTOCOL_VERSION.to_string(),
            request_id: "memo-missing-hit".to_string(),
            method: "getNativeFlowLensCore".to_string(),
            params: missing_params,
        },
    )
    .0;
    let missing = serde_json::to_value(missing).unwrap();
    assert_eq!(missing["requestId"], "memo-missing-hit");
    assert_eq!(missing["status"], "error");
    assert_eq!(missing["error"]["code"], "missing-flow");
}

#[test]
fn immutable_query_memo_remains_strictly_bounded() {
    let mut session = NativeProtocolSession::default();
    for index in 0..300 {
        session.retain_query_result(
            format!("query-{index:03}"),
            super::success_response(format!("request-{index}"), json!(index)),
        );
    }
    assert!(session.query_result("query-000").is_none());
    assert!(session.query_result("query-043").is_none());
    assert_eq!(
        serde_json::to_value(session.query_result("query-044").unwrap()).unwrap()["result"],
        json!(44)
    );
    assert_eq!(
        serde_json::to_value(session.query_result("query-299").unwrap()).unwrap()["result"],
        json!(299)
    );
}

#[test]
fn refresh_native_project_executes_and_verifies_a_package_scoped_plan() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-bounded-protocol-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("apps/api/src")).unwrap();
    fs::create_dir_all(root.join("apps/web/src")).unwrap();
    fs::write(
        root.join("package.json"),
        r#"{"name":"monorepo","scripts":{"root":"node apps/api/src/main.ts"}}"#,
    )
    .unwrap();
    fs::write(
        root.join("apps/api/package.json"),
        r#"{"name":"api","scripts":{"api":"node src/main.ts"}}"#,
    )
    .unwrap();
    fs::write(
        root.join("apps/api/src/main.ts"),
        "export const api = true;\n",
    )
    .unwrap();
    fs::write(
        root.join("apps/web/src/main.ts"),
        "export const web = true;\n",
    )
    .unwrap();
    let input = format!(
        "{}\n",
        request(
            "bounded",
            "refreshNativeProject",
            json!({
                "projectRoot": root,
                "sessionProjectId": "session:bounded-test",
                "packagePath": "apps/api",
                "limits": { "maxFiles": 10, "maxBytes": 100000, "budgetMs": 10000 },
            }),
        )
    );
    let result = responses(&input);
    assert_eq!(result[0]["status"], "ok");
    assert_eq!(
        result[0]["result"]["sourceAuthority"],
        "rust-native-bounded/v1"
    );
    assert_eq!(result[0]["result"]["boundedDiscovery"]["verified"], true);
    assert_eq!(result[0]["result"]["boundedDiscovery"]["candidateFiles"], 1);
    assert_eq!(
        result[0]["result"]["graph"]["project"]["projectId"],
        "session:bounded-test"
    );
    assert_eq!(result[0]["result"]["graph"]["project"]["name"], "api");
    assert_eq!(
        result[0]["result"]["graph"]["analysis"]["nativeBoundedPackagePath"],
        "apps/api"
    );
    let node_ids = result[0]["result"]["graph"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|node| node.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(node_ids.contains(&"command:apps/api/package.json:api"));
    assert!(!node_ids.contains(&"command:package.json:root"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_empty_changed_paths_reuses_the_native_source_session_without_reading_disk() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-empty-change-session-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export const current = true;\n").unwrap();
    let params = json!({
        "projectRoot": root,
        "sessionProjectId": "session:empty-change",
    });
    let mut session = NativeProtocolSession::default();
    let initial = refresh_native_js_session_graph(&mut session, &params).unwrap();
    assert_eq!(initial["publicGraphVersion"], 1);
    fs::remove_file(root.join("src/main.ts")).unwrap();
    let no_op = refresh_native_js_session_graph(
        &mut session,
        &json!({
            "projectRoot": root,
            "sessionProjectId": "session:empty-change",
            "changedPaths": [],
        }),
    )
    .unwrap();
    assert_eq!(no_op["status"], "reused");
    assert_eq!(no_op["publicGraphVersion"], 1);
    assert_eq!(no_op["sourceRefresh"]["mode"], "no-op-session");
    assert_eq!(no_op["sourceRefresh"]["parsedFiles"], 0);
    assert_eq!(no_op["sourceRefresh"]["reusedFiles"], 1);
    assert!(no_op.get("graph").is_none());
    assert_eq!(
        no_op["publicGraphReuse"]["schemaVersion"],
        "flopeek-native-public-graph-reuse/v1"
    );
    assert!(no_op["publicGraphReuse"]["envelope"].get("nodes").is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_only_ephemeral_refresh_reuses_public_collections() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-source-only-session-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export const current = true;\n").unwrap();
    let mut session = NativeProtocolSession::default();
    let initial = refresh_native_js_session_graph(
        &mut session,
        &json!({
            "projectRoot": root,
            "sessionProjectId": "session:source-only",
        }),
    )
    .unwrap();
    fs::write(root.join("src/main.ts"), "\nexport const current = true;\n").unwrap();
    let refreshed = refresh_native_js_session_graph(
        &mut session,
        &json!({
            "projectRoot": root,
            "sessionProjectId": "session:source-only",
            "changedPaths": ["src/main.ts"],
        }),
    )
    .unwrap();
    assert_eq!(refreshed["status"], "promoted");
    assert_eq!(refreshed["publicGraphVersion"], 2);
    assert!(refreshed.get("graph").is_none());
    assert_eq!(
        refreshed["publicGraphReuse"]["schemaVersion"],
        "flopeek-native-public-graph-reuse/v1"
    );
    assert!(
        refreshed["publicGraphReuse"]["envelope"]
            .get("nodes")
            .is_none()
    );
    assert!(refreshed.get("receipt").is_none());
    assert_ne!(
        refreshed["graphHandle"]["factsDigest"], initial["graphHandle"]["factsDigest"],
        "source identity advances even while public collections are reused"
    );
    assert_eq!(
        refreshed["profile"]["schemaVersion"],
        "flopeek-native-session-lifecycle-profile/v1"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ephemeral_source_graph_returns_a_handle_and_retains_its_query_batch_in_rust() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-session-handle-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export const handled = true;\n").unwrap();
    let mut session = NativeProtocolSession::default();
    let result = refresh_native_js_session_graph(
        &mut session,
        &json!({
            "projectRoot": root,
            "sessionProjectId": "session:handle",
        }),
    )
    .unwrap();
    assert!(result.get("batch").is_none());
    assert_eq!(
        result["graphHandle"]["schemaVersion"],
        "flopeek-native-session-graph-handle/v1"
    );
    assert_eq!(result["graphHandle"]["persistence"], "session-memory");

    let mut query_params = json!({ "sessionGraph": result["graphHandle"].clone() });
    hydrate_session_query_batch(&session, &mut query_params).unwrap();
    assert!(query_params.get("sessionGraph").is_none());
    assert_eq!(
        query_params["batch"]["schemaVersion"],
        STRUCTURAL_FACT_BATCH_SCHEMA
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn refresh_native_persistent_project_promotes_without_returning_a_fact_batch() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-persistent-project-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/main.ts"),
        "export const persistent = true;\n",
    )
    .unwrap();
    let result = responses(&format!(
        "{}\n",
        request(
            "persistent",
            "refreshNativePersistentProject",
            json!({ "projectRoot": root }),
        )
    ));
    assert_eq!(result[0]["status"], "ok");
    assert_eq!(
        result[0]["result"]["sourceAuthority"],
        "rust-native-persistent/v1"
    );
    assert!(result[0]["result"].get("batch").is_none());
    assert_eq!(
        result[0]["result"]["graphHandle"]["schemaVersion"],
        "flopeek-native-graph-handle/v1"
    );
    assert_eq!(result[0]["result"]["graphHandle"]["persistence"], "sqlite");
    assert!(result[0]["result"]["graph"].is_object());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn persistent_project_handle_only_transport_omits_public_collections() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-persistent-handle-only-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/main.ts"),
        "export const handleOnly = true;\n",
    )
    .unwrap();
    let mut session = NativeProtocolSession::default();
    let result = refresh_native_persistent_project(
        &mut session,
        &json!({ "projectRoot": root, "returnPublicGraph": false }),
    )
    .unwrap();
    assert!(result.get("graph").is_none());
    assert!(result.get("publicGraphReuse").is_none());
    assert!(result.get("publicGraphPatch").is_none());
    assert_eq!(result["publicGraphTransport"]["mode"], "handle-only");
    assert!(result["publicGraphEnvelope"].is_object());
    assert!(result["publicGraphEnvelope"].get("nodes").is_none());
    assert!(result["publicGraphEnvelope"].get("edges").is_none());
    assert_eq!(
        result["graphHandle"]["schemaVersion"],
        "flopeek-native-graph-handle/v1"
    );
    drop(session);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn persistent_native_project_reuses_one_sqlite_connection_for_changed_path_refresh() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-persistent-connection-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    let source = root.join("src/main.ts");
    fs::write(&source, "export const initial = true;\n").unwrap();
    fs::write(root.join("src/stable.ts"), "export const stable = true;\n").unwrap();
    let mut session = NativeProtocolSession::default();
    let initial =
        refresh_native_persistent_project(&mut session, &json!({ "projectRoot": root })).unwrap();
    assert_eq!(initial["publicGraphVersion"], 1);
    assert_eq!(session.persistent_connections.len(), 1);
    assert_eq!(session.persistent_git_metadata.len(), 1);
    let mut query = json!({
        "projectRoot": root,
        "projectId": initial["graphHandle"]["projectId"],
        "factsDigest": initial["graphHandle"]["factsDigest"],
    });
    hydrate_cached_query_batch(&mut session, &mut query).unwrap();
    assert!(query["batch"].is_object());
    assert_eq!(session.persistent_connections.len(), 1);
    assert_eq!(session.persistent_git_metadata.len(), 1);
    let (changed_revisions_before, stable_revisions_before) = {
        let connection = session.persistent_connections.values().next().unwrap();
        (
            connection
                .query_row(
                    "SELECT COUNT(*) FROM node_revisions_v2 WHERE path = 'src/main.ts'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            connection
                .query_row(
                    "SELECT COUNT(*) FROM node_revisions_v2 WHERE path = 'src/stable.ts'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
        )
    };
    // Preserve every structural identity while changing the source-backed
    // revision. This selects the verified changed-record identity fast path.
    fs::write(&source, "export const initial = false;\n").unwrap();
    let refreshed = refresh_native_persistent_project(
        &mut session,
        &json!({
            "projectRoot": root,
            "changedPaths": ["src/main.ts"],
        }),
    )
    .unwrap();
    assert_eq!(session.persistent_connections.len(), 1);
    assert_eq!(refreshed["sourceRefresh"]["parsedFiles"], 1);
    assert_eq!(
        refreshed["sourceRefresh"]["changedPaths"],
        json!(["src/main.ts"])
    );
    assert_eq!(
        refreshed["receipt"]["profile"]["structuralRecordCacheWriteMode"],
        "changed-paths"
    );
    assert_eq!(
        refreshed["receipt"]["profile"]["structuralRecordCacheWritePaths"],
        1
    );
    assert_eq!(refreshed["receipt"]["profile"]["usedFactPatch"], true);
    assert_eq!(
        refreshed["receipt"]["profile"]["reusedStructuralProjection"],
        true
    );
    assert!(refreshed["receipt"]["profile"]["factPatchReconstructionMs"].is_number());
    let connection = session.persistent_connections.values().next().unwrap();
    let changed_revisions_after = connection
        .query_row(
            "SELECT COUNT(*) FROM node_revisions_v2 WHERE path = 'src/main.ts'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    let stable_revisions_after = connection
        .query_row(
            "SELECT COUNT(*) FROM node_revisions_v2 WHERE path = 'src/stable.ts'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert!(changed_revisions_after > changed_revisions_before);
    assert_eq!(stable_revisions_after, stable_revisions_before);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM edge_presence_v2 WHERE last_graph_version IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0,
        "source-only refresh must not churn edge membership intervals"
    );
    drop(session);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn database_open_evidence_reads_metadata_without_deserializing_graph_payload() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-database-open-evidence-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export const current = true;\n").unwrap();
    let mut session = NativeProtocolSession::default();
    let graph =
        refresh_native_persistent_project(&mut session, &json!({ "projectRoot": root })).unwrap();
    // Make any accidental payload deserialization fail loudly. The
    // evidence endpoint must still succeed because opening the current
    // graph reads only graph_versions metadata.
    let connection = open_native_store(&root).unwrap();
    assert!(
        connection
            .execute(
                "UPDATE native_public_graph_components SET payload_json = '{invalid-json'",
                [],
            )
            .unwrap()
            > 0
    );
    drop(connection);
    let evidence = get_native_database_open_evidence(&json!({
        "projectRoot": root,
        "projectId": graph["graphHandle"]["projectId"],
    }))
    .unwrap();
    assert_eq!(
        evidence["schemaVersion"],
        "flopeek-native-database-open-observation/v1"
    );
    assert_eq!(evidence["operation"], "open-current-graph");
    assert_eq!(evidence["fullPayloadDeserialized"], false);
    assert_eq!(evidence["observations"]["currentGraphFound"], true);
    assert_eq!(evidence["observations"]["graphPayloadRowsRead"], 0);
    assert_eq!(evidence["observations"]["graphPayloadBytesDeserialized"], 0);
    drop(session);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn persistent_native_project_explicit_no_op_reuses_the_session_snapshot_without_a_write() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-persistent-no-op-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.ts"), "export const stable = true;\n").unwrap();
    let mut session = NativeProtocolSession::default();
    let initial =
        refresh_native_persistent_project(&mut session, &json!({ "projectRoot": root })).unwrap();
    let reused = refresh_native_persistent_project(
        &mut session,
        &json!({ "projectRoot": root, "changedPaths": [] }),
    )
    .unwrap();
    assert_eq!(reused["status"], "reused");
    assert_eq!(reused["publicGraphVersion"], initial["publicGraphVersion"]);
    assert!(reused.get("graph").is_none());
    assert_eq!(
        reused["publicGraphReuse"]["schemaVersion"],
        "flopeek-native-public-graph-reuse/v1"
    );
    assert_eq!(reused["receipt"]["stored"], false);
    assert_eq!(reused["sourceRefresh"]["mode"], "no-op-session");
    assert_eq!(reused["sourceRefresh"]["parsedFiles"], 0);
    assert_eq!(
        reused["publicGraphReuse"]["envelope"]["state"]["status"],
        "native-current"
    );
    assert_eq!(
        reused["publicGraphReuse"]["envelope"]["analysis"]["graphState"]["status"],
        "unchanged"
    );
    assert_eq!(
        reused["publicGraphReuse"]["envelope"]["analysis"]["graphState"]["persistence"],
        "sqlite"
    );
    assert_eq!(session.persistent_connections.len(), 1);
    drop(session);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn canonical_json_equality_ignores_object_member_order_but_not_array_order() {
    let reordered: Value =
        serde_json::from_str(r#"{"coverage":{"parsed":2,"inventory":1},"entries":["a","b"]}"#)
            .unwrap();
    let canonical = json!({
        "entries": ["a", "b"],
        "coverage": { "inventory": 1, "parsed": 2 },
    });
    assert!(same_canonical_json(&reordered, &canonical));
    assert!(!same_canonical_json(
        &canonical,
        &json!({
            "entries": ["b", "a"],
            "coverage": { "inventory": 1, "parsed": 2 },
        })
    ));
}

#[test]
fn projection_digest_survives_sqlite_envelope_component_reassembly_order() {
    let assembled: Value = serde_json::from_str(
        r#"{"schemaVersion":"snapshot/v1","nodes":[{"label":"A","id":"a"}],"state":{"status":"complete","version":2}}"#,
    )
    .unwrap();
    let reconstructed: Value = serde_json::from_str(
        r#"{"state":{"version":2,"status":"complete"},"schemaVersion":"snapshot/v1","nodes":[{"id":"a","label":"A"}]}"#,
    )
    .unwrap();
    assert_eq!(
        projection_digest(&assembled).unwrap(),
        projection_digest(&reconstructed).unwrap()
    );
}

#[test]
fn structural_fact_digest_serialization_matches_the_javascript_stable_json_contract() {
    let mut batch = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "checkout" }]
    }));
    batch["factsDigest"] = json!("sha256:ignored");
    batch["projectRoot"] = json!("D:/private/workspace");
    batch["flowContext"]["graphVersion"] = json!(99);
    batch["lifecycleContext"]["updatedAt"] = json!("2026-07-28T00:00:00.000Z");
    batch["lifecycleContext"]["refresh"] = json!({ "mode": "incremental" });
    batch["publicGraphContext"] = json!({ "state": { "graphVersion": 99 } });
    let mut legacy = batch.as_object().unwrap().clone();
    legacy.remove("factsDigest");
    legacy.remove("projectRoot");
    legacy.remove("publicGraphContext");
    legacy
        .get_mut("lifecycleContext")
        .and_then(Value::as_object_mut)
        .unwrap()
        .retain(|key, _| key != "updatedAt" && key != "refresh");
    legacy
        .get_mut("flowContext")
        .and_then(Value::as_object_mut)
        .unwrap()
        .remove("graphVersion");
    let expected = stable_json(&Value::Object(legacy));
    let actual = structural_facts_canonical_json(batch.as_object().unwrap()).unwrap();
    assert_eq!(actual, expected);
    assert_eq!(
        structural_facts_digest(batch.as_object().unwrap()).unwrap(),
        format!("sha256:{:x}", Sha256::digest(expected)),
    );
}

#[test]
fn structural_fact_digest_accepts_canonical_raw_records_from_persistent_cache() {
    let batch = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "checkout" }]
    }));
    let expected = structural_facts_digest(batch.as_object().unwrap()).unwrap();
    let mut compact = batch;
    for record in compact
        .get_mut("records")
        .and_then(Value::as_array_mut)
        .unwrap()
    {
        *record = Value::String(stable_json(record));
    }
    assert_eq!(
        structural_facts_digest(compact.as_object().unwrap()).unwrap(),
        expected
    );
}

#[test]
fn structural_topology_digest_serialization_matches_the_stable_json_projection() {
    let mut batch = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "checkout" }]
    }));
    batch["factsDigest"] = json!("sha256:ignored");
    batch["projectRoot"] = json!("D:/private/workspace");
    batch["flowContext"]["graphVersion"] = json!(99);
    batch["flowContext"]["sourceRevision"] = json!("main");
    batch["lifecycleContext"]["updatedAt"] = json!("2026-07-28T00:00:00.000Z");
    batch["lifecycleContext"]["refresh"] = json!({ "mode": "incremental" });
    batch["lifecycleContext"]["sourceFingerprint"] = json!("sha256:source");
    batch["lifecycleContext"]["sourceRevision"] = json!("main");
    batch["publicGraphContext"] = json!({ "state": { "graphVersion": 99 } });
    let mut legacy = batch.as_object().unwrap().clone();
    legacy.remove("factsDigest");
    legacy.remove("projectRoot");
    legacy.remove("publicGraphContext");
    legacy
        .get_mut("lifecycleContext")
        .and_then(Value::as_object_mut)
        .unwrap()
        .retain(|key, _| {
            ![
                "updatedAt",
                "refresh",
                "sourceFingerprint",
                "sourceRevision",
            ]
            .contains(&key.as_str())
        });
    legacy
        .get_mut("flowContext")
        .and_then(Value::as_object_mut)
        .unwrap()
        .retain(|key, _| !["graphVersion", "sourceRevision"].contains(&key.as_str()));
    for record in legacy
        .get_mut("records")
        .and_then(Value::as_array_mut)
        .unwrap()
    {
        record.as_object_mut().unwrap().remove("sourceHash");
    }
    let expected = stable_json(&Value::Object(legacy));
    assert_eq!(
        structural_topology_digest(batch.as_object().unwrap()).unwrap(),
        format!("sha256:{:x}", Sha256::digest(expected)),
    );
}

#[test]
fn structural_topology_digest_ignores_source_identity_but_not_parser_facts() {
    let first = structural_facts(json!({ "symbols": [{ "type": "function", "name": "same" }] }));
    let mut source_only = first.clone();
    source_only["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    source_only["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    source_only["lifecycleContext"]["updatedAt"] = json!("2026-01-01T00:00:01.000Z");
    source_only["lifecycleContext"]["refresh"] =
        json!({ "mode": "incremental", "changedPaths": ["src/index.js"] });
    assert_eq!(
        structural_topology_digest(first.as_object().unwrap()).unwrap(),
        structural_topology_digest(source_only.as_object().unwrap()).unwrap()
    );
    let mut structural_change = source_only;
    structural_change["records"][0]["result"]["symbols"] =
        json!([{ "type": "function", "name": "changed" }]);
    assert_ne!(
        structural_topology_digest(first.as_object().unwrap()).unwrap(),
        structural_topology_digest(structural_change.as_object().unwrap()).unwrap()
    );
}

#[test]
fn native_request_entry_selection_matches_ordered_entry_source_expansion() {
    let graph = json!({
        "nodes": [
            { "id": "endpoint:orders", "kind": "endpoint", "type": "endpoint", "layer": "application" },
            { "id": "file:handler", "kind": "file", "type": "module", "layer": "application" },
            { "id": "file:repository", "kind": "file", "type": "module", "layer": "application" },
            { "id": "file:unrelated", "kind": "file", "type": "module", "layer": "application" }
        ],
        "edges": [
            { "source": "endpoint:orders", "target": "file:handler", "type": "handles" },
            { "source": "file:handler", "target": "file:repository", "type": "imports" },
            { "source": "file:repository", "target": "file:unrelated", "type": "imports" }
        ]
    });
    let visible = graph["nodes"].as_array().unwrap();
    let selection = native_entry_source_nodes(&graph, visible);
    let selected = selection
        .iter()
        .map(|node| node["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        selected,
        vec![
            "endpoint:orders",
            "file:handler",
            "file:repository",
            "file:unrelated"
        ]
    );
}

#[test]
fn isolated_structural_record_assembly_matches_a_full_graph_rebuild() {
    let mut first = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "before" }]
    }));
    first["records"].as_array_mut().unwrap().push(json!({
        "recordOrder": 1,
        "relativePath": "src/other.js",
        "sourceHash": "b".repeat(64),
        "sourceScope": "application",
        "result": { "symbols": [{ "type": "function", "name": "other" }] },
    }));
    let mut current = first.clone();
    current["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    current["records"][0]["result"]["symbols"] = json!([
        { "type": "function", "name": "after" },
        { "type": "function", "name": "local" },
    ]);
    let path =
        isolated_structural_change_path(first.as_object().unwrap(), current.as_object().unwrap());
    assert_eq!(path.as_deref(), Some("src/index.js"));
    let previous = build_structural_graph(&first).unwrap();
    let incremental = build_isolated_incremental_graph(
        &current,
        &serde_json::to_value(previous).unwrap(),
        path.as_deref().unwrap(),
    )
    .unwrap();
    let full = build_structural_graph(&current).unwrap();
    assert_eq!(incremental.canonical_json, full.canonical_json);
    assert_eq!(
        serde_json::to_value(incremental).unwrap(),
        serde_json::to_value(full).unwrap()
    );
}

#[test]
fn isolated_structural_assembly_abstains_when_a_record_has_cross_file_facts() {
    let first = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "before" }],
        "resolvedImports": [{ "specifier": "./other", "targetPath": "src/other.js" }],
    }));
    let mut current = first.clone();
    current["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    current["records"][0]["result"]["symbols"] = json!([{ "type": "function", "name": "after" }]);
    assert_eq!(
        isolated_structural_change_path(first.as_object().unwrap(), current.as_object().unwrap(),),
        None
    );
}

fn structural_facts(result: Value) -> Value {
    let mut params = json!({
        "schemaVersion": STRUCTURAL_FACT_BATCH_SCHEMA,
        "projectId": "project:fixture",
        "records": [{
            "recordOrder": 0,
            "relativePath": "src/index.js",
            "sourceHash": "b".repeat(64),
            "result": result,
        }],
        "flowContext": { "graphVersion": 0, "sourceRevision": null },
        "lifecycleContext": {
            "sourceFingerprint": "sha256:test",
            "sourceRevision": null,
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "refresh": { "mode": "initial", "analyzedFiles": 1, "reusedFiles": 0, "removedFiles": 0, "changedPaths": [] },
            "coverage": null,
        },
    });
    let digest = structural_facts_digest(params.as_object().unwrap()).unwrap();
    params["factsDigest"] = Value::String(digest);
    params
}

#[test]
fn emits_versioned_health_and_shutdown_responses() {
    let result = responses(&format!(
        "{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"health-1\",\"method\":\"health\"}}\n{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"shutdown-1\",\"method\":\"shutdown\"}}\n"
    ));
    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["status"], "ok");
    assert_eq!(result[0]["result"]["publicNodeIdsEnabled"], true);
    assert_eq!(result[0]["result"]["sessionGraphHistory"]["limit"], 2);
    assert!(
        result[0]["result"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("nativeJsStructuralFacts"))
    );
    assert!(
        result[0]["result"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("refreshNativeJsSessionGraph"))
    );
    for capability in [
        "createContextRefV2",
        "getNodeIdentity",
        "searchNodeIdentities",
    ] {
        assert!(
            !result[0]["result"]["capabilities"]
                .as_array()
                .unwrap()
                .contains(&json!(capability)),
            "identity v2 must not be advertised by default"
        );
    }
    let compatibility_csharp = result[0]["result"]["adapterCapabilities"]["adapters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|adapter| adapter["id"] == "csharp")
        .unwrap();
    let execution_csharp = result[0]["result"]["executionAdapterCapabilities"]["adapters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|adapter| adapter["id"] == "csharp")
        .unwrap();
    assert_eq!(compatibility_csharp["parser"], "csharp-roslyn");
    assert_eq!(compatibility_csharp["requiredToolchain"], ".NET SDK");
    assert_eq!(execution_csharp["parser"], "csharp-static-ast");
    assert_eq!(execution_csharp["availability"], "bundled");
    assert_eq!(execution_csharp["requiredToolchain"], Value::Null);
    assert_eq!(result[1]["result"]["accepted"], true);
}

#[test]
fn identity_v2_requires_explicit_capability_negotiation() {
    let result = responses(&format!(
        "{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"blocked\",\"method\":\"getNodeIdentity\",\"params\":{{}}}}\n{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"health\",\"method\":\"health\",\"params\":{{\"experimentalIdentityV2\":true}}}}\n{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"shutdown\",\"method\":\"shutdown\"}}\n"
    ));
    assert_eq!(
        result[0]["error"]["code"],
        "experimental-capability-disabled"
    );
    assert_eq!(
        result[1]["result"]["experimentalCapabilities"],
        json!(["canonical-identity-v2"])
    );
    for capability in [
        "createContextRefV2",
        "getNodeIdentity",
        "searchNodeIdentities",
    ] {
        assert!(
            result[1]["result"]["capabilities"]
                .as_array()
                .unwrap()
                .contains(&json!(capability))
        );
    }
}

#[test]
fn native_session_history_configuration_is_explicitly_bounded() {
    assert_eq!(parse_session_history_limit(None).unwrap(), 2);
    assert_eq!(parse_session_history_limit(Some("1")).unwrap(), 1);
    assert_eq!(parse_session_history_limit(Some("1000")).unwrap(), 1_000);
    for invalid in ["", "0", "1001", "-1", "two"] {
        assert!(
            parse_session_history_limit(Some(invalid)).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn rejects_unknown_protocols_and_methods_without_stopping_the_session() {
    let result = responses(&format!(
        "{{\"protocolVersion\":\"other/v1\",\"requestId\":\"wrong\",\"method\":\"health\"}}\n{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"unknown\",\"method\":\"scan\"}}\n{{\"protocolVersion\":\"{NATIVE_PROTOCOL_VERSION}\",\"requestId\":\"final\",\"method\":\"shutdown\"}}\n"
    ));
    assert_eq!(
        result
            .iter()
            .map(|item| item["status"].as_str())
            .collect::<Vec<_>>(),
        vec![Some("error"), Some("error"), Some("ok")]
    );
    assert_eq!(result[0]["error"]["code"], "unsupported-protocol");
    assert_eq!(result[1]["error"]["code"], "unknown-method");
}

#[test]
fn rejects_non_contiguous_parser_record_order() {
    let mut params = structural_facts(json!({ "symbols": [] }));
    params["records"][0]["recordOrder"] = json!(2);
    let digest = structural_facts_digest(params.as_object().unwrap()).unwrap();
    params["factsDigest"] = Value::String(digest);
    let result = responses(&format!(
        "{}\n{}\n",
        request("bad-order", "submitStructuralFacts", params),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["status"], "error");
    assert_eq!(result[0]["error"]["code"], "invalid-structural-facts");
    assert_eq!(
        result[0]["error"]["message"],
        "StructuralFactBatch/v1 recordOrder values must be contiguous from zero."
    );
}

#[test]
fn accepts_bounded_structural_facts_without_source_bodies() {
    let result = responses(&format!(
        "{}\n{}\n",
        request(
            "facts",
            "submitStructuralFacts",
            structural_facts(json!({ "symbols": [] }))
        ),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["status"], "ok");
    assert_eq!(result[0]["result"]["acceptedRecords"], 1);
    assert_eq!(result[0]["result"]["stored"], false);
}

#[test]
fn rejects_structural_fact_source_bodies() {
    let result = responses(&format!(
        "{}\n{}\n",
        request(
            "facts",
            "submitStructuralFacts",
            structural_facts(json!({ "sourceBody": "const hidden = true;" }))
        ),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["status"], "error");
    assert_eq!(result[0]["error"]["code"], "unsafe-structural-facts");
}

#[test]
fn rejects_non_portable_resolved_import_targets() {
    let result = responses(&format!(
        "{}\n{}\n",
        request(
            "facts",
            "submitStructuralFacts",
            structural_facts(json!({
                "resolvedImports": [{ "specifier": "./outside", "targetPath": "../outside.js" }],
            }))
        ),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["status"], "error");
    assert_eq!(result[0]["error"]["code"], "invalid-structural-facts");
}

#[test]
fn rejects_structural_facts_with_a_tampered_digest() {
    let mut params = structural_facts(json!({ "symbols": [] }));
    params["factsDigest"] = Value::String(format!("sha256:{}", "0".repeat(64)));
    let result = responses(&format!(
        "{}\n{}\n",
        request("facts", "submitStructuralFacts", params),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["status"], "error");
    assert_eq!(result[0]["error"]["code"], "invalid-structural-facts");
    assert_eq!(
        result[0]["error"]["message"],
        "StructuralFactBatch/v1 factsDigest does not match its canonical payload."
    );
}

#[test]
fn persists_only_validated_structural_projections_and_reuses_the_current_version() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-protocol-store-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let mut params = structural_facts(json!({ "symbols": [] }));
    params["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let input = format!(
        "{}\n{}\n{}\n",
        request("first", "persistStructuralGraph", params.clone()),
        request("second", "persistStructuralGraph", params),
        request("stop", "shutdown", json!({})),
    );
    let result = responses(&input);
    assert_eq!(result[0]["status"], "ok");
    assert_eq!(result[0]["result"]["status"], "promoted");
    assert_eq!(result[0]["result"]["graphVersion"], 1);
    assert_eq!(result[1]["status"], "ok");
    assert_eq!(result[1]["result"]["status"], "reused");
    assert_eq!(result[1]["result"]["graphVersion"], 1);
    assert!(root.join(".flopeek").join("native-core.sqlite3").is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_public_lifecycle_allocates_versions_and_reuses_a_noop() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-public-lifecycle-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let lifecycle_facts = |result| {
        let mut params = structural_facts(result);
        params["publicGraphContext"] = json!({
            "schemaVersion": 5,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "project": { "projectId": "project:fixture" },
            "state": { "graphVersion": 0, "materialFingerprint": null, "sourceFingerprint": "sha256:test", "sourceRevision": null, "updatedAt": "2026-01-01T00:00:00.000Z", "status": "unpersisted" },
            "analysis": { "coverage": null, "refresh": { "mode": "initial", "analyzedFiles": 1, "reusedFiles": 0, "removedFiles": 0, "changedPaths": [] } },
            "stats": { "scannedFiles": 1, "parsedFiles": 1, "inventoryOnlyFiles": 0, "parseFailedFiles": 0 },
        });
        params["factsDigest"] =
            Value::String(structural_facts_digest(params.as_object().unwrap()).unwrap());
        params
    };
    let mut first = lifecycle_facts(json!({ "symbols": [] }));
    first["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let mut second =
        lifecycle_facts(json!({ "symbols": [{ "type": "function", "name": "added" }] }));
    second["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    second["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    second["factsDigest"] =
        Value::String(structural_facts_digest(second.as_object().unwrap()).unwrap());
    second["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let result = responses(&format!(
        "{}\n{}\n{}\n{}\n{}\n",
        request("shadow", "persistStructuralGraph", first.clone()),
        request("first", "persistNativePublicGraph", first.clone()),
        request("noop", "persistNativePublicGraph", first),
        request("changed", "persistNativePublicGraph", second),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[1]["result"]["status"], "promoted");
    assert_eq!(result[1]["result"]["publicGraphVersion"], 1);
    assert_eq!(result[1]["result"]["graph"]["state"]["graphVersion"], 1);
    assert_eq!(result[2]["result"]["status"], "reused");
    assert_eq!(result[2]["result"]["publicGraphVersion"], 1);
    assert_eq!(
        result[2]["result"]["publicGraphReuse"]["schemaVersion"],
        "flopeek-native-public-graph-reuse/v1"
    );
    assert!(result[2]["result"].get("graph").is_none());
    assert!(
        result[2]["result"]["publicGraphReuse"]["envelope"]
            .get("nodes")
            .is_none()
    );
    assert_eq!(result[3]["result"]["status"], "promoted");
    assert_eq!(result[3]["result"]["publicGraphVersion"], 2);
    assert_eq!(result[3]["result"]["graph"]["state"]["graphVersion"], 2);
    assert_eq!(
        result[3]["result"]["receipt"]["adjacentDelta"]["fromGraphVersion"],
        1
    );
    assert_eq!(
        result[3]["result"]["receipt"]["adjacentDelta"]["toGraphVersion"],
        2
    );
    assert_eq!(
        result[3]["result"]["receipt"]["profile"]["persistentPayloadCacheHit"],
        true
    );
    assert_eq!(
        result[3]["result"]["receipt"]["profile"]["incrementalStructuralPath"],
        "src/index.js"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn structural_fact_patch_accepts_a_new_record_without_full_batch_fallback() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-structural-patch-added-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();

    let mut first = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "stable" }]
    }));
    first["publicGraphContext"] = json!({
        "schemaVersion": 5,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "project": { "projectId": "project:fixture" },
        "state": {
            "graphVersion": 0,
            "materialFingerprint": null,
            "sourceFingerprint": "sha256:test",
            "sourceRevision": null,
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "status": "unpersisted"
        },
        "analysis": {
            "coverage": null,
            "refresh": { "mode": "initial", "analyzedFiles": 1, "reusedFiles": 0, "removedFiles": 0, "changedPaths": [] }
        },
        "stats": { "scannedFiles": 1, "parsedFiles": 1, "inventoryOnlyFiles": 0, "parseFailedFiles": 0 }
    });
    first["records"][0]["sourceScope"] = json!("application");
    first["factsDigest"] =
        Value::String(structural_facts_digest(first.as_object().unwrap()).unwrap());
    first["projectRoot"] = Value::String(root.to_string_lossy().to_string());

    let mut second = first.clone();
    second["records"].as_array_mut().unwrap().push(json!({
        "recordOrder": 1,
        "relativePath": "src/added.js",
        "sourceHash": "c".repeat(64),
        "sourceScope": "application",
        "result": { "symbols": [{ "type": "function", "name": "added" }] },
    }));
    second["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    second["lifecycleContext"]["refresh"] = json!({
        "mode": "incremental",
        "analyzedFiles": 1,
        "reusedFiles": 1,
        "removedFiles": 0,
        "changedPaths": ["src/added.js"],
    });
    second["factsDigest"] =
        Value::String(structural_facts_digest(second.as_object().unwrap()).unwrap());

    let mut patch_batch = first.clone();
    patch_batch.as_object_mut().unwrap().remove("records");
    patch_batch.as_object_mut().unwrap().remove("factsDigest");
    let manifest = second["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| {
            json!({
                "relativePath": record["relativePath"],
                "sourceHash": record["sourceHash"],
                "sourceScope": "application",
                "recordOrder": record["recordOrder"],
            })
        })
        .collect::<Vec<_>>();
    let patch = json!({
        "schemaVersion": STRUCTURAL_FACT_PATCH_SCHEMA,
        "projectId": first["projectId"],
        "baseFactsDigest": first["factsDigest"],
        "projectRoot": root.to_string_lossy(),
        "batch": patch_batch,
        "manifest": manifest,
        "changedRecords": [second["records"][1]],
    });
    let result = responses(&format!(
        "{}\n{}\n{}\n",
        request("first", "persistNativePublicGraph", first),
        request("added", "persistNativePublicGraphPatch", patch),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["result"]["status"], "promoted");
    assert_eq!(result[1]["status"], "ok");
    assert_eq!(result[1]["result"]["status"], "promoted");
    assert_eq!(result[1]["result"]["publicGraphVersion"], 2);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_public_lifecycle_reuses_a_projection_for_source_only_refresh() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-source-only-lifecycle-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let mut first = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "same" }]
    }));
    first["publicGraphContext"] = json!({
        "schemaVersion": 5,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "project": { "projectId": "project:fixture" },
        "state": {
            "graphVersion": 0,
            "materialFingerprint": null,
            "sourceFingerprint": "sha256:test",
            "sourceRevision": null,
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "status": "unpersisted"
        },
        "analysis": {
            "coverage": null,
            "refresh": { "mode": "initial", "analyzedFiles": 1, "reusedFiles": 0, "removedFiles": 0, "changedPaths": [] }
        },
        "stats": { "scannedFiles": 1, "parsedFiles": 1, "inventoryOnlyFiles": 0, "parseFailedFiles": 0 }
    });
    first["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let mut second = first.clone();
    second["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    second["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    second["lifecycleContext"]["updatedAt"] = json!("2026-01-01T00:00:01.000Z");
    second["lifecycleContext"]["refresh"] = json!({
        "mode": "incremental",
        "analyzedFiles": 1,
        "reusedFiles": 0,
        "removedFiles": 0,
        "changedPaths": ["src/index.js"],
    });
    second["publicGraphContext"]["state"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    second["publicGraphContext"]["state"]["updatedAt"] = json!("2026-01-01T00:00:01.000Z");
    second["publicGraphContext"]["analysis"]["refresh"] =
        second["lifecycleContext"]["refresh"].clone();
    second["factsDigest"] =
        Value::String(structural_facts_digest(second.as_object().unwrap()).unwrap());
    let mut third = second.clone();
    third["records"][0]["sourceHash"] = Value::String("d".repeat(64));
    third["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "d".repeat(64)));
    third["lifecycleContext"]["updatedAt"] = json!("2026-01-01T00:00:02.000Z");
    third["publicGraphContext"]["state"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "d".repeat(64)));
    third["publicGraphContext"]["state"]["updatedAt"] = json!("2026-01-01T00:00:02.000Z");
    third["factsDigest"] =
        Value::String(structural_facts_digest(third.as_object().unwrap()).unwrap());
    let result = responses(&format!(
        "{}\n{}\n{}\n{}\n",
        request("first", "persistNativePublicGraph", first),
        request("second", "persistNativePublicGraph", second),
        request("third", "persistNativePublicGraph", third),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["result"]["status"], "promoted");
    assert_eq!(result[1]["result"]["status"], "promoted");
    assert_eq!(result[1]["result"]["publicGraphVersion"], 2);
    assert_eq!(
        result[1]["result"]["receipt"]["profile"]["reusedStructuralProjection"],
        true
    );
    assert_eq!(
        result[1]["result"]["receipt"]["profile"]["previousPublicSnapshotCacheHit"],
        true
    );
    assert_eq!(
        result[1]["result"]["receipt"]["adjacentDelta"]["topologyChanged"],
        false
    );
    assert_eq!(
        result[1]["result"]["receipt"]["adjacentDelta"]["sourceChanged"],
        true
    );
    assert_eq!(
        result[1]["result"]["publicGraphReuse"]["schemaVersion"],
        "flopeek-native-public-graph-reuse/v1"
    );
    assert!(
        result[1]["result"]["publicGraphReuse"]["envelope"]
            .get("nodes")
            .is_none()
    );
    assert_eq!(result[2]["result"]["publicGraphVersion"], 3);
    assert_eq!(
        result[2]["result"]["receipt"]["profile"]["previousPublicSnapshotCacheHit"],
        true
    );
    assert_eq!(
        result[2]["result"]["receipt"]["adjacentDelta"]["topologyChanged"],
        false
    );
    assert!(
        result[2]["result"]["publicGraphReuse"]["envelope"]
            .get("nodes")
            .is_none()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_session_lifecycle_never_requires_a_project_root_or_sqlite_store() {
    let lifecycle_facts = |result| {
        let mut params = structural_facts(result);
        params["publicGraphContext"] = json!({
            "schemaVersion": 5,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "project": { "projectId": "session:fixture" },
            "state": { "graphVersion": 0, "materialFingerprint": null, "sourceFingerprint": "sha256:test", "sourceRevision": null, "updatedAt": "2026-01-01T00:00:00.000Z", "status": "unpersisted" },
            "analysis": { "coverage": null, "refresh": { "mode": "initial", "analyzedFiles": 1, "reusedFiles": 0, "removedFiles": 0, "changedPaths": [] } },
            "stats": { "scannedFiles": 1, "parsedFiles": 1, "inventoryOnlyFiles": 0, "parseFailedFiles": 0 },
        });
        params["projectId"] = Value::String("session:fixture".to_string());
        params["flowContext"]["projectId"] = Value::String("session:fixture".to_string());
        params["factsDigest"] =
            Value::String(structural_facts_digest(params.as_object().unwrap()).unwrap());
        params
    };
    let first = lifecycle_facts(json!({ "symbols": [] }));
    let mut changed = lifecycle_facts(json!({
        "symbols": [{ "type": "function", "name": "added" }]
    }));
    changed["records"][0]["sourceHash"] = Value::String("d".repeat(64));
    changed["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "d".repeat(64)));
    changed["lifecycleContext"]["refresh"]["mode"] = json!("incremental");
    changed["lifecycleContext"]["refresh"]["changedPaths"] = json!(["src/index.js"]);
    changed["factsDigest"] =
        Value::String(structural_facts_digest(changed.as_object().unwrap()).unwrap());
    let result = responses(&format!(
        "{}\n{}\n{}\n{}\n",
        request("first", "refreshNativeSessionGraph", first.clone()),
        request("noop", "refreshNativeSessionGraph", first),
        request("changed", "refreshNativeSessionGraph", changed),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["result"]["persistence"], "session-memory");
    assert_eq!(result[0]["result"]["publicGraphVersion"], 1);
    assert_eq!(result[1]["result"]["status"], "reused");
    assert_eq!(result[1]["result"]["publicGraphVersion"], 1);
    assert_eq!(result[2]["result"]["publicGraphVersion"], 2);
    assert_eq!(
        result[2]["result"]["graph"]["analysis"]["latestDelta"]["fromGraphVersion"],
        1
    );
    assert_eq!(
        result[2]["result"]["graph"]["analysis"]["latestDelta"]["toGraphVersion"],
        2
    );
}

#[test]
fn native_session_history_is_bounded_and_expired_handles_are_explicit() {
    let session_facts = |hash: char, timestamp: &str, symbol: &str| {
        let mut params = structural_facts(json!({
            "symbols": [{ "type": "function", "name": symbol }]
        }));
        let fingerprint = format!("sha256:{}", hash.to_string().repeat(64));
        params["projectId"] = json!("session:bounded-history");
        params["flowContext"]["projectId"] = json!("session:bounded-history");
        params["records"][0]["sourceHash"] = json!(hash.to_string().repeat(64));
        params["lifecycleContext"]["sourceFingerprint"] = json!(fingerprint);
        params["lifecycleContext"]["updatedAt"] = json!(timestamp);
        params["publicGraphContext"] = json!({
            "schemaVersion": 5,
            "generatedAt": timestamp,
            "project": { "projectId": "session:bounded-history" },
            "state": {
                "graphVersion": 0,
                "materialFingerprint": null,
                "sourceFingerprint": fingerprint,
                "sourceRevision": null,
                "updatedAt": timestamp,
                "status": "unpersisted"
            },
            "analysis": {
                "coverage": null,
                "refresh": {
                    "mode": "incremental",
                    "analyzedFiles": 1,
                    "reusedFiles": 0,
                    "removedFiles": 0,
                    "changedPaths": ["src/index.js"]
                }
            },
            "stats": {
                "scannedFiles": 1,
                "parsedFiles": 1,
                "inventoryOnlyFiles": 0,
                "parseFailedFiles": 0
            }
        });
        params["factsDigest"] =
            Value::String(structural_facts_digest(params.as_object().unwrap()).unwrap());
        params
    };
    let first = session_facts('b', "2026-01-01T00:00:00.000Z", "first");
    let second = session_facts('c', "2026-01-01T00:00:01.000Z", "second");
    let third = session_facts('d', "2026-01-01T00:00:02.000Z", "third");
    let first_digest = first["factsDigest"].as_str().unwrap().to_string();
    let second_digest = second["factsDigest"].as_str().unwrap().to_string();
    let third_digest = third["factsDigest"].as_str().unwrap().to_string();
    let session_handle = |version: i64, digest: &str| {
        json!({
            "schemaVersion": "flopeek-native-session-graph-handle/v1",
            "projectId": "session:bounded-history",
            "factsDigest": digest,
            "persistence": "session-memory",
            "publicGraphVersion": version,
        })
    };
    let result = responses_with_history(
        &format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
            request("first", "refreshNativeSessionGraph", first),
            request("second", "refreshNativeSessionGraph", second),
            request("third", "refreshNativeSessionGraph", third),
            request(
                "expired",
                "materializeNativeGraph",
                json!({ "sessionGraph": session_handle(1, &first_digest) })
            ),
            request(
                "retained",
                "materializeNativeGraph",
                json!({ "sessionGraph": session_handle(2, &second_digest) })
            ),
            request(
                "missing",
                "materializeNativeGraph",
                json!({ "sessionGraph": session_handle(99, &second_digest) })
            ),
            request(
                "expired-context",
                "resolveNativeContextRef",
                json!({
                    "sessionGraph": session_handle(3, &third_digest),
                    "contextRef": "fp://local/session%3Abounded-history/node/symbol%3Asrc%2Findex.js%3Afunction%3Afirst@1"
                })
            ),
            request(
                "adjacent-context",
                "resolveNativeContextRef",
                json!({
                    "sessionGraph": session_handle(3, &third_digest),
                    "contextRef": "fp://local/session%3Abounded-history/node/symbol%3Asrc%2Findex.js%3Afunction%3Asecond@2"
                })
            ),
        ),
        2,
    );
    assert_eq!(result[0]["result"]["profile"]["retainedSessionGraphs"], 1);
    assert_eq!(result[1]["result"]["profile"]["retainedSessionGraphs"], 2);
    assert_eq!(result[2]["result"]["profile"]["retainedSessionGraphs"], 2);
    assert_eq!(result[2]["result"]["profile"]["expiredThroughVersion"], 1);
    assert_eq!(result[3]["error"]["code"], "native-session-graph-expired");
    assert_eq!(result[4]["status"], "ok");
    assert_eq!(result[4]["result"]["graph"]["state"]["graphVersion"], 2);
    assert_eq!(result[5]["error"]["code"], "native-session-graph-miss");
    assert_eq!(
        result[6]["result"]["status"], "expired",
        "{}",
        result[6]["result"]
    );
    assert_eq!(result[6]["result"]["code"], "history-pruned");
    assert_eq!(result[7]["result"]["status"], "successor-candidate");
    assert_eq!(
        result[7]["result"]["successorCandidates"][0]["node"]["id"],
        "symbol:src/index.js:function:third"
    );
}

#[test]
fn native_session_history_stays_constant_across_one_thousand_refreshes() {
    let mut session = NativeProtocolSession::with_history_limit(2);
    for index in 1..=1_000 {
        let hash = format!("{index:064x}");
        let timestamp = format!("2026-01-01T00:00:{:02}.000Z", index % 60);
        let mut params = structural_facts(json!({
            "symbols": [{ "type": "function", "name": format!("version_{index}") }]
        }));
        params["projectId"] = json!("session:stress-history");
        params["flowContext"]["projectId"] = json!("session:stress-history");
        params["records"][0]["sourceHash"] = json!(hash);
        params["lifecycleContext"]["sourceFingerprint"] = json!(format!("sha256:{hash}"));
        params["lifecycleContext"]["updatedAt"] = json!(timestamp);
        params["publicGraphContext"] = json!({
            "schemaVersion": 5,
            "generatedAt": timestamp,
            "project": { "projectId": "session:stress-history" },
            "state": {
                "graphVersion": 0,
                "materialFingerprint": null,
                "sourceFingerprint": format!("sha256:{hash}"),
                "sourceRevision": null,
                "updatedAt": timestamp,
                "status": "unpersisted"
            },
            "analysis": {
                "coverage": null,
                "refresh": {
                    "mode": "incremental",
                    "analyzedFiles": 1,
                    "reusedFiles": 0,
                    "removedFiles": 0,
                    "changedPaths": ["src/index.js"]
                }
            },
            "stats": {
                "scannedFiles": 1,
                "parsedFiles": 1,
                "inventoryOnlyFiles": 0,
                "parseFailedFiles": 0
            }
        });
        params["factsDigest"] =
            Value::String(structural_facts_digest(params.as_object().unwrap()).unwrap());
        let result = refresh_native_session_graph(&mut session, &params).unwrap();
        assert_eq!(result["profile"]["retainedSessionGraphs"], index.min(2));
    }
    assert_eq!(session.graphs.len(), 1);
    assert_eq!(session.session_query_graphs.len(), 2);
    assert_eq!(
        session
            .expired_session_versions
            .get("session:stress-history"),
        Some(&998)
    );
}

#[test]
fn persists_an_adjacent_public_delta_only_with_the_next_complete_graph() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-protocol-delta-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let mut first = structural_facts(json!({ "symbols": [] }));
    first["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let mut second = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "added" }]
    }));
    second["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    // Native storage versions are implementation-local. The persisted delta
    // must preserve the JavaScript public graph-version contract instead.
    second["flowContext"]["graphVersion"] = json!(1);
    second["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    second["lifecycleContext"]["updatedAt"] = Value::String("2026-01-01T00:00:01.000Z".to_string());
    second["lifecycleContext"]["refresh"]["mode"] = json!("incremental");
    second["lifecycleContext"]["refresh"]["changedPaths"] = json!(["src/index.js"]);
    let digest = structural_facts_digest(second.as_object().unwrap()).unwrap();
    second["factsDigest"] = Value::String(digest);
    second["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let result = responses(&format!(
        "{}\n{}\n{}\n{}\n",
        request("first", "persistStructuralGraph", first),
        request("second", "persistStructuralGraph", second),
        request(
            "delta",
            "getNativeStructuralDelta",
            json!({
                "projectRoot": root.to_string_lossy(),
                "projectId": "project:fixture",
                "fromGraphVersion": 1,
                "toGraphVersion": 2,
            })
        ),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[0]["result"]["graphVersion"], 1);
    assert_eq!(result[1]["result"]["graphVersion"], 2);
    assert_eq!(result[1]["result"]["adjacentDelta"]["fromGraphVersion"], 0);
    assert_eq!(result[1]["result"]["adjacentDelta"]["toGraphVersion"], 1);
    assert_eq!(
        result[1]["result"]["adjacentDelta"]["changedPaths"],
        json!(["src/index.js"])
    );
    assert_eq!(
        result[1]["result"]["adjacentDelta"]["nodes"]["added"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(result[2]["result"]["available"], true);
    assert_eq!(
        result[2]["result"]["delta"],
        result[1]["result"]["adjacentDelta"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn expires_a_missing_context_ref_before_retained_public_delta_history() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "flopeek-native-protocol-context-expired-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let mut first = structural_facts(json!({
        "symbols": [{ "type": "function", "name": "old" }]
    }));
    first["flowContext"]["graphVersion"] = json!(1);
    first["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "b".repeat(64)));
    let first_digest = structural_facts_digest(first.as_object().unwrap()).unwrap();
    first["factsDigest"] = Value::String(first_digest);
    first["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let mut second = structural_facts(json!({ "symbols": [] }));
    second["records"][0]["sourceHash"] = Value::String("c".repeat(64));
    second["flowContext"]["graphVersion"] = json!(2);
    second["lifecycleContext"]["sourceFingerprint"] =
        Value::String(format!("sha256:{}", "c".repeat(64)));
    second["lifecycleContext"]["updatedAt"] = Value::String("2026-01-01T00:00:01.000Z".to_string());
    second["lifecycleContext"]["refresh"]["mode"] = json!("incremental");
    second["lifecycleContext"]["refresh"]["changedPaths"] = json!(["src/index.js"]);
    let second_digest = structural_facts_digest(second.as_object().unwrap()).unwrap();
    second["factsDigest"] = Value::String(second_digest);
    second["projectRoot"] = Value::String(root.to_string_lossy().to_string());
    let context_ref = "fp://local/project%3Afixture/node/symbol%3Amissing@0";
    let result = responses(&format!(
        "{}\n{}\n{}\n{}\n",
        request("first", "persistStructuralGraph", first),
        request("second", "persistStructuralGraph", second.clone()),
        request(
            "resolve",
            "resolveNativeContextRef",
            json!({ "batch": second, "projectRoot": root.to_string_lossy(), "contextRef": context_ref })
        ),
        request("stop", "shutdown", json!({})),
    ));
    assert_eq!(result[2]["status"], "ok");
    assert_eq!(result[2]["result"]["status"], "expired");
    assert_eq!(result[2]["result"]["code"], "history-pruned");
    assert_eq!(
        result[2]["result"]["retention"],
        json!({"oldestRetainedFrom":1,"newestRetainedTo":2})
    );
    fs::remove_dir_all(root).unwrap();
}
