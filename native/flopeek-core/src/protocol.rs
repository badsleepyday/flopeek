use crate::inventory::{
    discover_native_bounded_project, scan_native_incremental_manifest,
    scan_native_incremental_manifest_with_source_batch,
};
use crate::js_batch::native_manual_descriptions;
use crate::js_facts::{
    NativeJsFactsStatus, refresh_native_js_facts_session, reuse_native_js_facts_session,
    scan_native_js_facts, scan_native_js_facts_ephemeral, scan_native_js_facts_ephemeral_bounded,
};
use crate::project_identity::ProjectIdentity;
use crate::record_cache::{handle_native_js_record_cache_value, load_native_js_record_cache_raw};
use crate::scope::read_native_scope;
use crate::store::{
    NativeGraphPromotionRequest, begin_graph_build, complete_graph_delta,
    complete_graph_delta_by_public_versions, complete_graph_payload,
    complete_graph_payload_by_public_version, current_complete_graph, current_structural_batch,
    initialize_native_store, open_native_store, promote_graph_build_with_changed_records,
    recover_incomplete_graph_builds, retained_public_delta_range,
};
use crate::structural_graph::{
    StructuralGraphNode, StructuralGraphProjection, StructuralGraphSnapshot,
    build_structural_graph, javascript_ascii_cmp, javascript_ascii_locale_cmp,
    structural_edge_traversal_order, structural_graph_projection_from_parts,
    structural_graph_snapshot,
};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub const NATIVE_PROTOCOL_VERSION: &str = "flopeek-native-protocol/v1";
pub const STRUCTURAL_FACT_BATCH_SCHEMA: &str = "flopeek-structural-fact-batch/v1";
pub const STRUCTURAL_FACT_PATCH_SCHEMA: &str = "flopeek-structural-fact-patch/v1";

type NativePublicDeltaHistory = (Option<Value>, Option<(i64, i64)>);
type ComparedItems = (
    Vec<Value>,
    Vec<Value>,
    Vec<Value>,
    (usize, usize, usize),
    bool,
);

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeRequest {
    protocol_version: String,
    request_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResponse {
    protocol_version: &'static str,
    request_id: Option<String>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<NativeProtocolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<NativeProtocolError>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum NativeProtocolResult {
    Value(Value),
    Raw(Box<RawValue>),
}

#[derive(Debug, Serialize)]
struct NativeProtocolError {
    code: &'static str,
    message: String,
}

// Cache-disabled scans must retain a coherent graph lifecycle for the life of
// one native JSONL process, but must never create a repository store. This is
// intentionally small and process-local: shutdown drops every graph and a
// Context Ref issued here remains valid only in the owning CoreClient session.
#[derive(Clone)]
struct NativeSessionGraph {
    facts_digest: String,
    topology_digest: String,
    public_graph_version: i64,
    // The assembled native public payload is retained for adjacent public
    // graph deltas. It is not accepted by query handlers.
    payload: Arc<Value>,
    // Query handlers accept the original StructuralFactBatch. Retain it once
    // in Rust so cache-disabled Node callers can refer to it by graph handle.
    query_batch: Arc<Value>,
}

// One bounded derived cache for the current complete persistent graph. SQLite
// remains authoritative: every use is gated by the current SQLite pointer's
// project ID and native graph version, and a different pointer replaces this
// value before it can be used. This avoids parsing the same multi-megabyte
// payload again solely to calculate the next adjacent delta.
#[derive(Clone)]
struct NativePersistentGraph {
    project_id: String,
    graph_version: i64,
    payload: Value,
    // A derived process-local snapshot avoids rebuilding the previous public
    // graph solely for an adjacent source-only delta. SQLite remains the
    // authority: callers may use this only after matching the project and
    // complete graph version selected by SQLite.
    public_snapshot: Option<Value>,
}

// The complete fact batch is larger than the public graph snapshot, but it is
// immutable for one complete graph version. Keep one process-local copy so a
// persistent JSONL client does not reread and parse it on every fact patch.
// SQLite's current pointer is checked before every reuse; this cache is never
// authoritative and is discarded when another process advances the graph.
#[derive(Clone)]
struct NativePersistentFacts {
    project_id: String,
    facts_digest: String,
    topology_digest: String,
    payload: Value,
}

#[derive(Default)]
struct NativeProtocolSession {
    graphs: BTreeMap<String, NativeSessionGraph>,
    // Every graph returned by a cache-disabled CoreClient can still be queried
    // during this JSONL process.  Store its complete batch once in Rust and
    // identify it to Node by a versioned handle, rather than retaining a
    // duplicate StructuralFactBatch in Node for each public graph object.
    session_query_graphs: BTreeMap<String, NativeSessionGraph>,
    ephemeral_sources: BTreeMap<String, NativeJsFactsStatus>,
    persistent_sources: BTreeMap<String, NativeJsFactsStatus>,
    // A durable CoreClient owns one JSONL process. Retain its SQLite handle by
    // canonical project root so schema preparation happens once per session,
    // not once per changed-path refresh. The map is deliberately process-local
    // and is dropped on shutdown; SQLite remains the authoritative store.
    persistent_connections: BTreeMap<String, rusqlite::Connection>,
    persistent_graph: Option<NativePersistentGraph>,
    persistent_facts: Option<NativePersistentFacts>,
    // Git branch/revision metadata is repository-level observational context,
    // not parser evidence. A source-only incremental event cannot alter HEAD
    // or branch, and the source session already retains its matching graph
    // lineage. Reuse this bounded snapshot to avoid spawning `git status` on
    // every changed file; a reconciled source acquisition refreshes it.
    persistent_git_metadata: BTreeMap<String, Value>,
}

fn native_session_graph_key(project_id: &str, public_graph_version: i64) -> String {
    format!("{project_id}\0{public_graph_version}")
}

fn with_persistent_session_connection<T>(
    session: &mut NativeProtocolSession,
    root: &Path,
    operation: impl FnOnce(
        &mut NativeProtocolSession,
        &mut rusqlite::Connection,
    ) -> Result<T, NativeProtocolError>,
) -> Result<T, NativeProtocolError> {
    let key = root.to_string_lossy().to_string();
    let mut connection = match session.persistent_connections.remove(&key) {
        Some(connection) => connection,
        None => open_native_store(root).map_err(|error| NativeProtocolError {
            code: "store-initialize-failed",
            message: error.to_string(),
        })?,
    };
    let result = operation(session, &mut connection);
    session.persistent_connections.insert(key, connection);
    result
}

fn ensure_persistent_payload(
    session: &mut NativeProtocolSession,
    connection: &rusqlite::Connection,
    project_id: &str,
    graph_version: i64,
) -> Result<bool, NativeProtocolError> {
    let cache_hit = session.persistent_graph.as_ref().is_some_and(|cached| {
        cached.project_id == project_id && cached.graph_version == graph_version
    });
    if !cache_hit {
        let stored = complete_graph_payload(connection, project_id, graph_version)
            .map_err(|error| NativeProtocolError {
                code: "store-read-failed",
                message: error.to_string(),
            })?
            .ok_or_else(|| NativeProtocolError {
                code: "store-read-failed",
                message: "Current complete native graph payload is unavailable.".to_string(),
            })?;
        session.persistent_graph = Some(NativePersistentGraph {
            project_id: project_id.to_string(),
            graph_version,
            payload: stored.payload,
            public_snapshot: None,
        });
    }
    Ok(cache_hit)
}

fn ensure_persistent_facts(
    session: &mut NativeProtocolSession,
    connection: &rusqlite::Connection,
    project_id: &str,
    facts_digest: &str,
) -> Result<(), NativeProtocolError> {
    let current =
        current_complete_graph(connection, project_id).map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?;
    if !current.is_some_and(|graph| graph.material_fingerprint == facts_digest) {
        return Err(NativeProtocolError {
            code: "structural-fact-patch-miss",
            message:
                "The SQLite current graph no longer matches the patch base; submit a full batch."
                    .to_string(),
        });
    }
    let cache_hit = session.persistent_facts.as_ref().is_some_and(|cached| {
        cached.project_id == project_id && cached.facts_digest == facts_digest
    });
    if !cache_hit {
        let payload = current_structural_batch(connection, project_id, facts_digest)
            .map_err(|error| NativeProtocolError {
                code: "store-read-failed",
                message: error.to_string(),
            })?
            .ok_or_else(|| NativeProtocolError {
            code: "structural-fact-patch-miss",
            message: "The current complete graph has no matching cached StructuralFactBatch; submit a full batch."
                .to_string(),
            })?;
        let receipt = submit_structural_facts(&payload)?;
        if receipt.get("factsDigest").and_then(Value::as_str) != Some(facts_digest) {
            return Err(NativeProtocolError {
                code: "store-integrity-failed",
                message: "The cached StructuralFactBatch digest does not match its complete graph."
                    .to_string(),
            });
        }
        let topology_digest = payload
            .as_object()
            .ok_or_else(|| NativeProtocolError {
                code: "store-integrity-failed",
                message: "The cached StructuralFactBatch is not an object.".to_string(),
            })
            .and_then(|batch| {
                structural_topology_digest(batch).map_err(|message| NativeProtocolError {
                    code: "store-integrity-failed",
                    message,
                })
            })?;
        session.persistent_facts = Some(NativePersistentFacts {
            project_id: project_id.to_string(),
            facts_digest: facts_digest.to_string(),
            topology_digest,
            payload,
        });
    }
    Ok(())
}

// A persistent query may name an already-promoted StructuralFactBatch instead
// of serializing it again over JSONL. SQLite remains the authority for this
// cache: the current complete graph must still have the requested digest, and
// a mismatch is deliberately reported so the caller can retry with its exact
// in-memory batch for a historical graph or concurrent promotion.
fn hydrate_cached_query_batch(
    session: &mut NativeProtocolSession,
    params: &mut Value,
) -> Result<(), NativeProtocolError> {
    if params.get("batch").is_some() {
        return Ok(());
    }
    let root = project_root(params)?;
    with_persistent_session_connection(session, &root, |session, connection| {
        hydrate_cached_query_batch_using_connection(session, params, connection)
    })
}

fn hydrate_cached_query_batch_using_connection(
    session: &mut NativeProtocolSession,
    params: &mut Value,
    connection: &rusqlite::Connection,
) -> Result<(), NativeProtocolError> {
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "Cached native query requires params.projectId.".to_string(),
        })?
        .to_string();
    let facts_digest = params
        .get("factsDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "Cached native query requires params.factsDigest.".to_string(),
        })?
        .to_string();
    if let Err(error) = ensure_persistent_facts(session, connection, &project_id, &facts_digest) {
        if error.code == "structural-fact-patch-miss" {
            return Err(NativeProtocolError {
                code: "native-query-fact-cache-miss",
                message: "The requested graph is not the current verified native fact cache."
                    .to_string(),
            });
        }
        return Err(error);
    }
    let batch = session
        .persistent_facts
        .as_ref()
        .filter(|cached| cached.project_id == project_id && cached.facts_digest == facts_digest)
        .map(|cached| cached.payload.clone())
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Verified native fact cache was unavailable after lookup.".to_string(),
        })?;
    let object = params.as_object_mut().ok_or_else(|| NativeProtocolError {
        code: "invalid-params",
        message: "Cached native query params must be an object.".to_string(),
    })?;
    object.insert("batch".to_string(), batch);
    Ok(())
}

// Cache-disabled graphs have no repository-local SQLite association.  The
// complete batch is already retained by the owning JSONL process so queries
// can use this versioned handle instead of asking Node to echo that batch back
// on every request.  Unlike persistent handles, this is intentionally valid
// only until process shutdown.
fn hydrate_session_query_batch(
    session: &NativeProtocolSession,
    params: &mut Value,
) -> Result<(), NativeProtocolError> {
    let handle = params
        .get("sessionGraph")
        .and_then(Value::as_object)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "Native session query requires params.sessionGraph.".to_string(),
        })?;
    let schema = handle.get("schemaVersion").and_then(Value::as_str);
    let project_id = handle.get("projectId").and_then(Value::as_str);
    let facts_digest = handle.get("factsDigest").and_then(Value::as_str);
    let public_graph_version = handle.get("publicGraphVersion").and_then(Value::as_i64);
    if schema != Some("flopeek-native-session-graph-handle/v1")
        || project_id.is_none_or(str::is_empty)
        || facts_digest.is_none_or(str::is_empty)
        || public_graph_version.is_none_or(|value| value <= 0)
        || handle.get("persistence").and_then(Value::as_str) != Some("session-memory")
    {
        return Err(NativeProtocolError {
            code: "invalid-params",
            message: "Native session query received an invalid graph handle.".to_string(),
        });
    }
    let project_id = project_id.expect("validated non-empty project ID");
    let facts_digest = facts_digest.expect("validated non-empty facts digest");
    let public_graph_version = public_graph_version.expect("validated graph version");
    let key = native_session_graph_key(project_id, public_graph_version);
    let graph = session
        .session_query_graphs
        .get(&key)
        .filter(|graph| graph.facts_digest == facts_digest)
        .ok_or_else(|| NativeProtocolError {
            code: "native-session-graph-miss",
            message: "The requested cache-disabled native graph is no longer retained by this JSONL session."
                .to_string(),
        })?;
    let object = params.as_object_mut().ok_or_else(|| NativeProtocolError {
        code: "invalid-params",
        message: "Native session query params must be an object.".to_string(),
    })?;
    object.remove("sessionGraph");
    object.insert("batch".to_string(), (*graph.query_batch).clone());
    Ok(())
}

fn error_response(
    request_id: Option<String>,
    code: &'static str,
    message: impl Into<String>,
) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id,
        status: "error",
        result: None,
        error: Some(NativeProtocolError {
            code,
            message: message.into(),
        }),
    }
}

fn success_response(request_id: String, result: Value) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: Some(request_id),
        status: "ok",
        result: Some(NativeProtocolResult::Value(result)),
        error: None,
    }
}

fn success_raw_response(request_id: String, result: Box<RawValue>) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: Some(request_id),
        status: "ok",
        result: Some(NativeProtocolResult::Raw(result)),
        error: None,
    }
}

fn project_root(params: &Value) -> Result<PathBuf, NativeProtocolError> {
    let Some(value) = params.get("projectRoot").and_then(Value::as_str) else {
        return Err(NativeProtocolError {
            code: "invalid-params",
            message: "initialize requires params.projectRoot as a directory path.".to_string(),
        });
    };
    let root = PathBuf::from(value);
    if !root.is_dir() {
        return Err(NativeProtocolError {
            code: "invalid-project-root",
            message: "initialize params.projectRoot must resolve to an existing directory."
                .to_string(),
        });
    }
    Ok(root)
}

fn native_incremental_manifest(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let include_source_batch = params
        .get("includeSourceBatch")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let manifest = (if include_source_batch {
        scan_native_incremental_manifest_with_source_batch(&root)
    } else {
        scan_native_incremental_manifest(&root)
    })
    .map_err(|message| NativeProtocolError {
        code: "native-incremental-manifest-failed",
        message,
    })?;
    let inventory = manifest.inventory;
    let source_batch = inventory.source_batch_records.as_ref().map(|records| {
        json!({
            "schemaVersion": "flopeek-native-ephemeral-source-batch/v1",
            "records": records.iter().map(|record| json!({
                "path": &record.path,
                "utf8": &record.utf8,
                "sizeBytes": record.size_bytes,
                "modifiedAtNs": record.modified_at_ns.to_string(),
            })).collect::<Vec<_>>(),
            "omittedFiles": inventory.source_batch_omitted_files,
            "persistence": "ephemeral-jsonl-only",
            "limitation": "Source text is returned only for the current bounded JSONL request. It is not accepted by StructuralFactBatch/v1 and is never written to SQLite or the JS record cache.",
        })
    });
    Ok(json!({
        "schemaVersion": "flopeek-native-incremental-manifest/v1",
        "mode": "native-incremental-manifest",
        "projectRoot": inventory.project_root,
        "projectId": inventory.project_identity.project_id,
        "sourceFingerprint": inventory.source_fingerprint,
        "candidatePaths": inventory.candidate_paths.unwrap_or_default(),
        "changedPaths": inventory.changed_paths,
        "reusedPaths": inventory.reused_paths,
        "removedPaths": inventory.removed_paths,
        "candidateFiles": inventory.candidate_files,
        "hashedFiles": inventory.hashed_files,
        "reusedFiles": inventory.reused_files,
        "removedFiles": inventory.removed_files,
        "sourceBatch": source_batch,
        "limitation": "This manifest identifies cache-safe source candidates only. JavaScript remains authoritative for parsing and graph assembly until full compatibility parity is demonstrated."
    }))
}

fn native_bounded_discovery(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let limits = params.get("limits").and_then(Value::as_object);
    let max_files = limits
        .and_then(|limits| limits.get("maxFiles"))
        .and_then(Value::as_u64)
        .map(|value| {
            usize::try_from(value).map_err(|_| NativeProtocolError {
                code: "invalid-params",
                message: "limits.maxFiles exceeds this platform's address space.".to_string(),
            })
        })
        .transpose()?;
    let max_bytes = limits
        .and_then(|limits| limits.get("maxBytes"))
        .and_then(Value::as_i64);
    let budget_ms = limits
        .and_then(|limits| limits.get("budgetMs"))
        .and_then(Value::as_u64);
    let package_path = params.get("packagePath").and_then(Value::as_str);
    let discovery =
        discover_native_bounded_project(&root, package_path, max_files, max_bytes, budget_ms)
            .map_err(|message| NativeProtocolError {
                code: if message.starts_with("native-bounded-") {
                    "native-bounded-discovery-failed"
                } else {
                    "native-bounded-discovery-error"
                },
                message,
            })?;
    Ok(json!({
        "schemaVersion":"flopeek-native-bounded-discovery/v1",
        "projectRoot":discovery.project_root,
        "packagePath":discovery.package_path,
        "scopeSource":discovery.scope_source,
        "planFingerprint":discovery.plan_fingerprint,
        "candidateFiles":discovery.candidates.len(),
        "candidateBytes":discovery.total_bytes,
        "candidates":discovery.candidates.into_iter().map(|candidate| json!({
            "path":candidate.path,
            "sizeBytes":candidate.size_bytes,
            "modifiedAtNs":candidate.modified_at_ns.to_string(),
            "sourceScope":candidate.source_scope,
        })).collect::<Vec<_>>(),
        "promotion":"not-started",
        "limitation":"This is native-owned bounded discovery and limit validation. Execution, mutation verification, and graph promotion are intentionally separate so an incomplete plan cannot become a graph."
    }))
}

fn refresh_native_project(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let session_project_id = params
        .get("sessionProjectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "refreshNativeProject requires sessionProjectId.".to_string(),
        })?;
    let limits = params.get("limits").and_then(Value::as_object);
    let max_files = limits
        .and_then(|limits| limits.get("maxFiles"))
        .and_then(Value::as_u64)
        .map(|value| {
            usize::try_from(value).map_err(|_| NativeProtocolError {
                code: "invalid-params",
                message: "limits.maxFiles exceeds this platform's address space.".to_string(),
            })
        })
        .transpose()?;
    let max_bytes = limits
        .and_then(|limits| limits.get("maxBytes"))
        .and_then(Value::as_i64);
    let budget_ms = limits
        .and_then(|limits| limits.get("budgetMs"))
        .and_then(Value::as_u64);
    let package_path = params.get("packagePath").and_then(Value::as_str);
    let (status, discovery) = scan_native_js_facts_ephemeral_bounded(
        &root,
        Some(session_project_id),
        package_path,
        max_files,
        max_bytes,
        budget_ms,
    )
    .map_err(|message| NativeProtocolError {
        code: "native-bounded-execution-failed",
        message,
    })?;
    let supported_paths = status.facts.keys().cloned().collect::<BTreeSet<_>>();
    let unsupported_paths = status
        .candidate_paths
        .iter()
        .filter(|path| !supported_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported_paths.is_empty() {
        return Err(NativeProtocolError {
            code: "native-source-adapter-unavailable",
            message: format!(
                "Rust bounded source authority has no promoted adapter for: {}.",
                unsupported_paths.join(", ")
            ),
        });
    }
    // A second native discovery before assembly is deliberately mandatory.
    // A changed plan is discarded rather than becoming a plausible partial
    // graph. This costs one metadata walk, but has no source-body transport.
    let verified =
        discover_native_bounded_project(&root, package_path, max_files, max_bytes, budget_ms)
            .map_err(|message| NativeProtocolError {
                code: "native-bounded-verification-failed",
                message,
            })?;
    if verified.plan_fingerprint != discovery.plan_fingerprint {
        return Err(NativeProtocolError {
            code: "native-bounded-plan-changed",
            message: "Repository source plan changed during native bounded execution; the graph was discarded."
                .to_string(),
        });
    }
    let batch = native_js_batch_envelope_for_package(&status, discovery.package_path.as_deref())?;
    let mut result = refresh_native_session_graph(session, &batch)?;
    result["batch"] = batch;
    result["sourceAuthority"] = json!("rust-native-bounded/v1");
    result["boundedDiscovery"] = json!({
        "schemaVersion":"flopeek-native-bounded-discovery/v1",
        "projectRoot":discovery.project_root,
        "packagePath":discovery.package_path,
        "scopeSource":discovery.scope_source,
        "planFingerprint":discovery.plan_fingerprint,
        "candidateFiles":discovery.candidates.len(),
        "candidateBytes":discovery.total_bytes,
        "verified":true,
        "promotion":"session-memory-only",
    });
    Ok(result)
}

fn native_js_record_cache(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let request = params
        .get("cacheRequest")
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "nativeJsRecordCache requires params.cacheRequest.".to_string(),
        })?;
    handle_native_js_record_cache_value(&root, request).map_err(|message| NativeProtocolError {
        code: "native-js-record-cache-failed",
        message,
    })
}

fn native_project_identity_value(identity: &ProjectIdentity) -> Value {
    let mut value = json!({
        "projectId": identity.project_id,
        "source": identity.source,
        "status": identity.status,
        "originRemote": identity.origin_remote,
        "limitation": identity.limitation,
    });
    if let Some(canonical_project_id) = &identity.canonical_project_id {
        value["canonicalProjectId"] = Value::String(canonical_project_id.clone());
    }
    value
}

/// Load or incrementally refresh the Rust-owned JS/TS source session without
/// materialising the diagnostic JSON protocol payload. Persistent graph
/// promotion consumes this directly; only the compatibility/debug protocol
/// method below serializes complete facts, resolution, and records.
fn load_native_js_facts_status(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<crate::js_facts::NativeJsFactsStatus, NativeProtocolError> {
    let root = project_root(params)?;
    let ephemeral = params
        .get("ephemeral")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_project_id = params.get("sessionProjectId").and_then(Value::as_str);
    let session_key = root.display().to_string();
    let changed_paths = params
        .get("changedPaths")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let status = (if ephemeral {
        scan_native_js_facts_ephemeral(&root, session_project_id)
    } else if let (Some(previous), Some(paths)) = (
        session.persistent_sources.get(&session_key),
        changed_paths.as_deref(),
    ) {
        if paths.is_empty() {
            Ok(reuse_native_js_facts_session(previous))
        } else {
            refresh_native_js_facts_session(previous, paths)
        }
    } else {
        scan_native_js_facts(&root)
    })
    .map_err(|message| NativeProtocolError {
        code: if message.starts_with("native-session-reconcile-required:") {
            "native-session-reconcile-required"
        } else {
            "native-source-facts-failed"
        },
        message,
    })?;
    if !ephemeral {
        session
            .persistent_sources
            .insert(session_key, status.clone());
    }
    Ok(status)
}

fn native_js_structural_facts(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let ephemeral = params
        .get("ephemeral")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = load_native_js_facts_status(session, params)?;
    let supported_paths = status.facts.keys().cloned().collect::<BTreeSet<_>>();
    let unsupported_paths = status
        .candidate_paths
        .iter()
        .filter(|path| !supported_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    let native_envelope = native_js_batch_envelope(&status)?;
    Ok(json!({
        "schemaVersion": "flopeek-native-source-facts/v1",
        "adapterVersion": status.adapter_version,
        "persistence": if ephemeral { "session-memory" } else { "sqlite" },
        "projectRoot": status.project_root,
        "projectIdentity": native_project_identity_value(&status.project_identity),
        "candidateFiles": status.candidate_files,
        "candidatePaths": status.candidate_paths,
        "changedPaths": status.changed_paths,
        "reusedPaths": status.reused_paths,
        "removedPaths": status.removed_paths,
        "sourceScopeCounts": status.source_scope_counts,
        "scopeSource": status.scope_source,
        "flowEntries": {
            "primary": { "tests": status.flow_entries_tests, "fixtures": status.flow_entries_fixtures },
            "diagnostic": { "tests": true, "fixtures": true },
        },
        "parsedFiles": status.parsed_files,
        "reusedFiles": status.reused_files,
        "failedFiles": status.failed_files,
        "removedFacts": status.removed_facts,
        "unsupportedPaths": unsupported_paths,
        "facts": status.facts,
        "resolution": status.resolution,
        "records": status.structural_records,
        "entryFacts": status.entry_facts,
        "nativeEnvelope": native_envelope,
    }))
}

// A caller that explicitly supplies an empty changed-path list is asserting
// that its watcher observed no source event.  Once this JSONL process already
// owns the matching Rust source session and public snapshot, do not rebuild a
// complete fact envelope merely to rediscover the same SQLite graph.  The
// SQLite pointer is still read and matched first: another process may have
// promoted a newer graph, in which case the normal lifecycle path safely
// re-establishes this process-local cache.
fn reuse_native_persistent_project_no_op(
    session: &mut NativeProtocolSession,
    root: &Path,
    status: &NativeJsFactsStatus,
) -> Result<Option<Value>, NativeProtocolError> {
    let project_id = status.project_identity.project_id.clone();
    let cached = match (&session.persistent_graph, &session.persistent_facts) {
        (Some(graph), Some(facts))
            if graph.project_id == project_id
                && facts.project_id == project_id
                && graph.public_snapshot.is_some() =>
        {
            (
                graph.graph_version,
                facts.facts_digest.clone(),
                graph
                    .public_snapshot
                    .as_ref()
                    .expect("checked public snapshot")
                    .clone(),
            )
        }
        _ => return Ok(None),
    };
    let current = with_persistent_session_connection(session, root, |_session, connection| {
        current_complete_graph(connection, &project_id).map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })
    })?;
    let Some(current) = current else {
        return Ok(None);
    };
    if current.graph_version != cached.0
        || current.material_fingerprint != cached.1
        || current.public_graph_version.unwrap_or_default() < 1
    {
        return Ok(None);
    }
    let mut envelope = native_public_graph_envelope(&cached.2);
    envelope["analysis"]["refresh"] = json!({
        "strategy": "incremental-content-analysis",
        "mode": "incremental",
        "analyzedFiles": 0,
        "reusedFiles": status.reused_files,
        "removedFiles": 0,
        "changedPaths": [],
    });
    envelope["analysis"]["latestDelta"] = Value::Null;
    let public_graph_version = current
        .public_graph_version
        .expect("positive public graph version was checked");
    Ok(Some(json!({
        "schemaVersion": "flopeek-native-public-lifecycle/v1",
        "status": "reused",
        "nativeGraphVersion": current.graph_version,
        "publicGraphVersion": public_graph_version,
        "factsDigest": cached.1,
        "receipt": {
            "schemaVersion": "flopeek-native-source-session-no-op/v1",
            "stored": false,
            "status": "reused",
            "reason": "explicit-empty-changed-paths",
        },
        "publicGraphReuse": {
            "schemaVersion": "flopeek-native-public-graph-reuse/v1",
            "envelope": envelope,
        },
    })))
}

/// Persistent strict-Rust lifecycle. Source discovery, fact assembly, graph
/// promotion, and the SQLite-attached fact cache all remain in this process;
/// the JSONL caller receives a graph handle instead of a complete fact batch
/// that it would otherwise send straight back for persistence.
fn refresh_native_persistent_project(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let handle_only_public_graph = requests_handle_only_public_graph(params)?;
    let session_key = root.display().to_string();
    let source_refresh_started = Instant::now();
    let explicit_no_op = params
        .get("changedPaths")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
        && session.persistent_sources.contains_key(&session_key);
    let status = load_native_js_facts_status(session, params)?;
    let source_refresh_ms = elapsed_ms(source_refresh_started);
    if explicit_no_op {
        if let Some(mut response) = reuse_native_persistent_project_no_op(session, &root, &status)?
        {
            response["sourceAuthority"] = json!("rust-native-persistent/v1");
            response["sourceRefresh"] = json!({
                "mode": "no-op-session",
                "parsedFiles": 0,
                "reusedFiles": status.reused_files,
                "changedPaths": [],
                "removedPaths": [],
            });
            response["graphHandle"] = json!({
                "schemaVersion": "flopeek-native-graph-handle/v1",
                "projectId": status.project_identity.project_id,
                "factsDigest": response["factsDigest"],
                "persistence": "sqlite",
                "publicGraphVersion": response["publicGraphVersion"],
            });
            if handle_only_public_graph {
                replace_public_graph_with_handle_envelope(&mut response)?;
            }
            return Ok(response);
        }
    }
    let supported_paths = status.facts.keys().cloned().collect::<BTreeSet<_>>();
    let unsupported_paths = status
        .candidate_paths
        .iter()
        .filter(|path| !supported_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported_paths.is_empty() {
        return Err(NativeProtocolError {
            code: "native-source-adapter-unavailable",
            message: format!(
                "Rust source authority has no promoted adapter for: {}.",
                unsupported_paths.join(", ")
            ),
        });
    }
    let git_metadata = if status.initial_scan {
        let metadata = native_js_git_metadata(&root);
        session
            .persistent_git_metadata
            .insert(session_key.clone(), metadata.clone());
        metadata
    } else if let Some(metadata) = session.persistent_git_metadata.get(&session_key) {
        metadata.clone()
    } else {
        // A source session can be restored independently from this lightweight
        // observation cache. Acquire one live baseline rather than assuming a
        // Git state that this process never observed.
        let metadata = native_js_git_metadata(&root);
        session
            .persistent_git_metadata
            .insert(session_key.clone(), metadata.clone());
        metadata
    };
    // Once a complete graph has been promoted in this JSONL session, a
    // changed-path refresh can move only its changed records.  The native
    // patch routine transfers the cached unchanged records instead of cloning
    // them into a second complete envelope. It still reconstructs and hashes
    // the exact batch before SQLite promotion, so factsDigest and public graph
    // compatibility remain byte-for-byte equivalent to a full refresh.
    let cached_base_digest = (!status.initial_scan)
        .then(|| {
            session
                .persistent_facts
                .as_ref()
                .filter(|facts| facts.project_id == status.project_identity.project_id)
                .map(|facts| facts.facts_digest.clone())
        })
        .flatten();
    let (mut result, facts_digest, used_fact_patch, envelope_build_ms, persistent_promotion_ms) =
        if let Some(base_digest) = cached_base_digest {
            let envelope_started = Instant::now();
            let patch = native_js_structural_fact_patch(&status, &base_digest, &git_metadata)?;
            let envelope_build_ms = elapsed_ms(envelope_started);
            let promotion_started = Instant::now();
            match persist_native_public_graph_patch(session, &patch) {
                Ok(result) => {
                    let facts_digest = result
                        .get("factsDigest")
                        .and_then(Value::as_str)
                        .ok_or_else(|| NativeProtocolError {
                            code: "native-source-facts-failed",
                            message: "Native fact patch promotion returned no factsDigest."
                                .to_string(),
                        })?
                        .to_string();
                    (
                        result,
                        facts_digest,
                        true,
                        envelope_build_ms,
                        elapsed_ms(promotion_started),
                    )
                }
                // A second process may have advanced SQLite after this client
                // cached its base. Rebuild once from current Rust source facts;
                // malformed internal patches stay loud rather than being hidden by
                // a full-batch retry.
                Err(error) if error.code == "structural-fact-patch-miss" => {
                    let full_envelope_started = Instant::now();
                    let mut batch = native_js_batch_envelope_with_git(&status, &git_metadata)?;
                    batch["projectRoot"] = Value::String(root.to_string_lossy().to_string());
                    let facts_digest = batch
                    .get("factsDigest")
                    .and_then(Value::as_str)
                    .ok_or_else(|| NativeProtocolError {
                        code: "native-source-facts-failed",
                        message: "Rust source authority returned a StructuralFactBatch without factsDigest."
                            .to_string(),
                    })?
                    .to_string();
                    let changed_record_paths = status
                        .changed_record_paths
                        .iter()
                        .cloned()
                        .collect::<BTreeSet<_>>();
                    let full_envelope_build_ms = elapsed_ms(full_envelope_started);
                    let full_promotion_started = Instant::now();
                    let result = with_persistent_session_connection(
                        session,
                        &root,
                        |session, connection| {
                            let receipt = submit_structural_facts(&batch)?;
                            persist_native_public_graph_with_receipt_using_connection(
                                session,
                                &mut batch,
                                receipt,
                                true,
                                None,
                                Some(changed_record_paths),
                                connection,
                            )
                        },
                    )?;
                    (
                        result,
                        facts_digest,
                        false,
                        full_envelope_build_ms,
                        elapsed_ms(full_promotion_started),
                    )
                }
                Err(error) => return Err(error),
            }
        } else {
            let envelope_started = Instant::now();
            let mut batch = native_js_batch_envelope_with_git(&status, &git_metadata)?;
            batch["projectRoot"] = Value::String(root.to_string_lossy().to_string());
            let facts_digest = batch
                .get("factsDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| NativeProtocolError {
                    code: "native-source-facts-failed",
                    message:
                        "Rust source authority returned a StructuralFactBatch without factsDigest."
                            .to_string(),
                })?
                .to_string();
            let changed_record_paths = (!status.initial_scan).then(|| {
                status
                    .changed_record_paths
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>()
            });
            let envelope_build_ms = elapsed_ms(envelope_started);
            let promotion_started = Instant::now();
            let result =
                with_persistent_session_connection(session, &root, |session, connection| {
                    let receipt = submit_structural_facts(&batch)?;
                    persist_native_public_graph_with_receipt_using_connection(
                        session,
                        &mut batch,
                        receipt,
                        true,
                        None,
                        changed_record_paths,
                        connection,
                    )
                })?;
            (
                result,
                facts_digest,
                false,
                envelope_build_ms,
                elapsed_ms(promotion_started),
            )
        };
    let project_id = status.project_identity.project_id.clone();
    if let Some(profile) = result
        .pointer_mut("/receipt/profile")
        .and_then(Value::as_object_mut)
    {
        profile.insert("sourceRefreshMs".to_string(), json!(source_refresh_ms));
        profile.insert("envelopeBuildMs".to_string(), json!(envelope_build_ms));
        profile.insert(
            "persistentPromotionMs".to_string(),
            json!(persistent_promotion_ms),
        );
        profile.insert("usedFactPatch".to_string(), json!(used_fact_patch));
    }
    result["sourceAuthority"] = json!("rust-native-persistent/v1");
    result["sourceRefresh"] = json!({
        "mode": if status.initial_scan { "initial" } else { "incremental" },
        "parsedFiles": status.parsed_files,
        "reusedFiles": status.reused_files,
        "changedPaths": status.changed_paths,
        "removedPaths": status.removed_paths,
    });
    result["graphHandle"] = json!({
        "schemaVersion": "flopeek-native-graph-handle/v1",
        "projectId": project_id,
        "factsDigest": facts_digest,
        "persistence": "sqlite",
        "publicGraphVersion": result["publicGraphVersion"],
    });
    if handle_only_public_graph {
        replace_public_graph_with_handle_envelope(&mut result)?;
    }
    Ok(result)
}

// The ephemeral path must not serialize a complete StructuralFactBatch to Node
// only to have Node send the identical payload back for session assembly or
// later query calls. Keep discovery, parsing, envelope construction, graph
// assembly, and query-batch retention inside the native JSONL process; Node
// receives only a versioned session handle for this process-local lineage.
fn refresh_native_js_session_graph(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let handle_only_public_graph = requests_handle_only_public_graph(params)?;
    let session_project_id = params
        .get("sessionProjectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "refreshNativeJsSessionGraph requires sessionProjectId.".to_string(),
        })?;
    let session_key = format!("{}\0{}", root.display(), session_project_id);
    let changed_paths = params
        .get("changedPaths")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let no_op = matches!(
        (
            session.ephemeral_sources.get(&session_key),
            changed_paths.as_deref()
        ),
        (Some(_), Some([]))
    );
    let status = match (
        session.ephemeral_sources.get(&session_key),
        changed_paths.as_deref(),
    ) {
        (Some(previous), Some(paths)) if !paths.is_empty() => {
            refresh_native_js_facts_session(previous, paths)
        }
        (Some(previous), Some([])) => Ok(reuse_native_js_facts_session(previous)),
        _ => scan_native_js_facts_ephemeral(&root, Some(session_project_id)),
    }
    .map_err(|message| NativeProtocolError {
        code: if message.starts_with("native-session-reconcile-required:") {
            "native-session-reconcile-required"
        } else {
            "native-source-facts-failed"
        },
        message,
    })?;
    let batch = native_js_batch_envelope(&status)?;
    let mut result = refresh_native_session_graph(session, &batch)?;
    result["sourceAuthority"] = json!("rust-native-ephemeral/v1");
    result["sourceRefresh"] = json!({
        "mode": if no_op { "no-op-session" } else if changed_paths.as_ref().is_some_and(|paths| !paths.is_empty()) { "changed-path-session" } else { "initial-or-reconciled" },
        "parsedFiles": status.parsed_files,
        "reusedFiles": status.reused_files,
        "changedPaths": status.changed_paths,
        "removedPaths": status.removed_paths,
    });
    session.ephemeral_sources.insert(session_key, status);
    if handle_only_public_graph {
        replace_public_graph_with_handle_envelope(&mut result)?;
    }
    Ok(result)
}

fn native_js_source_fingerprint(records: &[Value]) -> String {
    let mut lines = records
        .iter()
        .filter_map(|record| {
            Some(format!(
                "{}\0{}\0{}",
                record.get("relativePath")?.as_str()?,
                record
                    .get("sourceScope")
                    .and_then(Value::as_str)
                    .unwrap_or("application"),
                record.get("sourceHash")?.as_str()?,
            ))
        })
        .collect::<Vec<_>>();
    lines.sort_by(|left, right| javascript_ascii_locale_cmp(left, right));
    format!("sha256:{:x}", Sha256::digest(lines.join("\n")))
}

fn native_js_git_metadata(root: &Path) -> Value {
    let output = Command::new("git")
        .args([
            "-C",
            &root.to_string_lossy(),
            "status",
            "--porcelain=v2",
            "--branch",
        ])
        .output();
    let Ok(output) = output else {
        return json!({"branch":"not-a-git-repository","revision":null,"shallow":null,"dirty":null,"availability":"not-a-repository","reason":"Git metadata is unavailable because this directory is not a readable Git repository."});
    };
    if !output.status.success() {
        return json!({"branch":"not-a-git-repository","revision":null,"shallow":null,"dirty":null,"availability":"not-a-repository","reason":"Git metadata is unavailable because this directory is not a readable Git repository."});
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut branch = "detached".to_string();
    let mut revision = Value::Null;
    let mut dirty = false;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                revision = Value::String(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                branch = value.to_string();
            }
        } else if !line.starts_with("# ") {
            dirty = true;
        }
    }
    json!({"branch":branch,"revision":revision,"shallow":Value::Null,"dirty":dirty,"availability":"available","reason":Value::Null})
}

/// The adapter contract is owned once at the repository root.  Rust embeds the
/// same bytes that the JavaScript scanner loads, so a release cannot advertise
/// divergent adapter capabilities across the two execution paths.
fn native_adapter_registry() -> Value {
    let mut registry: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/adapter-capabilities.json"
    )))
    .expect("shared adapter capability contract is valid JSON");
    if let Some(adapters) = registry.get_mut("adapters").and_then(Value::as_array_mut) {
        for adapter in adapters {
            let Some(object) = adapter.as_object_mut() else {
                continue;
            };
            if let Some(capability) = object.get("productCapability").cloned() {
                object.insert("capabilities".to_string(), capability);
            }
            let javascript = object
                .get("implementations")
                .and_then(|value| value.get("javascript"))
                .and_then(Value::as_object)
                .cloned();
            if let Some(javascript) = javascript {
                for field in ["parser", "availability", "requiredToolchain"] {
                    if let Some(value) = javascript.get(field) {
                        object.insert(field.to_string(), value.clone());
                    }
                }
            }
        }
    }
    registry
}

fn native_js_batch_envelope(
    status: &crate::js_facts::NativeJsFactsStatus,
) -> Result<Value, NativeProtocolError> {
    native_js_batch_envelope_for_package(status, None)
}

fn native_js_batch_envelope_with_git(
    status: &crate::js_facts::NativeJsFactsStatus,
    git_metadata: &Value,
) -> Result<Value, NativeProtocolError> {
    native_js_batch_envelope_for_package_with_records(status, None, true, Some(git_metadata))
}

fn native_js_structural_fact_patch(
    status: &crate::js_facts::NativeJsFactsStatus,
    base_facts_digest: &str,
    git_metadata: &Value,
) -> Result<Value, NativeProtocolError> {
    let batch = native_js_batch_envelope_without_records(status, git_metadata)?;
    let changed_paths = status
        .changed_record_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let manifest = status
        .structural_records
        .iter()
        .map(|record| {
            json!({
                "relativePath": record["relativePath"],
                "sourceHash": record["sourceHash"],
                "sourceScope": record["sourceScope"],
                "recordOrder": record["recordOrder"],
            })
        })
        .collect::<Vec<_>>();
    let changed_records = status
        .structural_records
        .iter()
        .filter(|record| {
            record
                .get("relativePath")
                .and_then(Value::as_str)
                .is_some_and(|path| changed_paths.contains(path))
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({
        "schemaVersion": STRUCTURAL_FACT_PATCH_SCHEMA,
        "projectId": status.project_identity.project_id,
        "baseFactsDigest": base_facts_digest,
        "projectRoot": status.project_root,
        "batch": batch,
        "manifest": manifest,
        "changedRecords": changed_records,
    }))
}

/// Assemble a graph envelope from native facts. Bounded/package scans retain
/// the repository root as their identity anchor, but use the selected package
/// manifest for package-owned metadata and commands. This prevents a parent
/// monorepo's scripts from appearing as executable entry points in a child
/// package graph.
fn native_js_batch_envelope_for_package(
    status: &crate::js_facts::NativeJsFactsStatus,
    package_path: Option<&str>,
) -> Result<Value, NativeProtocolError> {
    native_js_batch_envelope_for_package_with_records(status, package_path, true, None)
}

// Compact patch envelopes carry the full non-record contract but deliberately
// omit parser records and factsDigest. The patch reconstruction routine moves
// unchanged records out of its verified cache, then computes the same digest
// as a complete StructuralFactBatch.
fn native_js_batch_envelope_without_records(
    status: &crate::js_facts::NativeJsFactsStatus,
    git_metadata: &Value,
) -> Result<Value, NativeProtocolError> {
    native_js_batch_envelope_for_package_with_records(status, None, false, Some(git_metadata))
}

fn native_js_batch_envelope_for_package_with_records(
    status: &crate::js_facts::NativeJsFactsStatus,
    package_path: Option<&str>,
    include_records: bool,
    git_metadata: Option<&Value>,
) -> Result<Value, NativeProtocolError> {
    let scope = read_native_scope(&status.project_root).map_err(|message| NativeProtocolError {
        code: "native-source-facts-failed",
        message,
    })?;
    let generated_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| NativeProtocolError {
            code: "native-source-facts-failed",
            message: error.to_string(),
        })?;
    let git = git_metadata
        .cloned()
        .unwrap_or_else(|| native_js_git_metadata(&status.project_root));
    let manifest_path = package_path
        .map(|path| status.project_root.join(path).join("package.json"))
        .unwrap_or_else(|| status.project_root.join("package.json"));
    let package = std::fs::read_to_string(manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let project_name = package
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            status
                .project_root
                .file_name()
                .and_then(|name| name.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "project".to_string());
    let mut summary = json!({"scannedFiles":0,"parsedFiles":0,"parsedWithDiagnosticsFiles":0,"inventoryOnlyFiles":0,"parseFailedFiles":0});
    let mut by_language =
        BTreeMap::<String, (usize, usize, usize, usize, usize, BTreeSet<String>)>::new();
    for record in &status.structural_records {
        let language = record
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        // StructuralFactBatch intentionally keeps parser diagnostics in file
        // metadata rather than duplicating them inside every record result.
        // Coverage is envelope data, so read the canonical file projection.
        let analysis = &record["fileMetadata"]["analysis"];
        let parser = analysis
            .get("parser")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let status_name = analysis.get("status").and_then(Value::as_str).unwrap_or("");
        summary["scannedFiles"] = Value::from(summary["scannedFiles"].as_u64().unwrap_or(0) + 1);
        let item = by_language
            .entry(language)
            .or_insert((0, 0, 0, 0, 0, BTreeSet::new()));
        item.0 += 1;
        item.5.insert(parser.to_string());
        if status_name.starts_with("parsed") {
            summary["parsedFiles"] = Value::from(summary["parsedFiles"].as_u64().unwrap_or(0) + 1);
            item.1 += 1;
        }
        if status_name == "parsed-with-diagnostics" {
            summary["parsedWithDiagnosticsFiles"] =
                Value::from(summary["parsedWithDiagnosticsFiles"].as_u64().unwrap_or(0) + 1);
            item.2 += 1;
        }
        if status_name == "inventory-only" {
            summary["inventoryOnlyFiles"] =
                Value::from(summary["inventoryOnlyFiles"].as_u64().unwrap_or(0) + 1);
            item.3 += 1;
        }
        if status_name == "parse-failed" {
            summary["parseFailedFiles"] =
                Value::from(summary["parseFailedFiles"].as_u64().unwrap_or(0) + 1);
            item.4 += 1;
        }
    }
    let by_language = by_language.into_iter().map(|(language, (files, parsed, parsed_with_diagnostics, inventory_only, parse_failed, parsers))| json!({"language":language,"files":files,"parsed":parsed,"parsedWithDiagnostics":parsed_with_diagnostics,"inventoryOnly":inventory_only,"parseFailed":parse_failed,"parsers":parsers})).collect::<Vec<_>>();
    let coverage = json!({"summary":summary,"byLanguage":by_language,"interpretation":"Coverage counts syntax-tree analysis status, not runtime execution coverage or relationship precision."});
    let source_fingerprint = native_js_source_fingerprint(&status.structural_records);
    // Inventory and parser status are the source of lifecycle telemetry. Do
    // not label every persistent refresh as an initial full scan merely
    // because graph assembly receives a complete compatibility envelope.
    let refresh = json!({
        "strategy":"incremental-content-analysis",
        "mode": if status.initial_scan { "initial" } else { "incremental" },
        "analyzedFiles":status.parsed_files,
        "reusedFiles":status.reused_files,
        "removedFiles":status.removed_facts,
        "changedPaths":&status.changed_paths,
    });
    let adapter_registry = native_adapter_registry();
    let project_identity = native_project_identity_value(&status.project_identity);
    let mut public_graph_context = json!({
        "schemaVersion":5,"generatedAt":generated_at,
        "project":{"root":status.project_root,"name":project_name,"projectId":status.project_identity.project_id,"identity":project_identity,"git":git},
        "state":{"graphVersion":0,"materialFingerprint":Value::Null,"sourceFingerprint":source_fingerprint,"sourceRevision":git["revision"],"updatedAt":generated_at,"status":"unpersisted"},
        "analysis":{"mode":"deterministic","refresh":refresh,"codeInterpretation":"AST-only for registered language adapters","unparsedPolicy":"inventory-only; no dependency or flow is inferred","coverage":coverage,"nativeBoundedPackagePath":package_path,"repositoryScope":{"schemaVersion":1,"source":scope.source,"configPath":if scope.source == "config" { Value::String(".flopeek/config.json".to_string()) } else { Value::Null },"sourceRoots":scope.source_roots,"testRoots":scope.test_roots,"fixtureRoots":scope.fixture_roots,"exclude":scope.exclude,"projectId":scope.project_id,"flowEntries":{"tests":scope.flow_entries_tests,"fixtures":scope.flow_entries_fixtures},"precedence":["excluded","fixture","test","generated","application"],"counts":{"application":status.source_scope_counts.get("application").copied().unwrap_or(0),"test":status.source_scope_counts.get("test").copied().unwrap_or(0),"fixture":status.source_scope_counts.get("fixture").copied().unwrap_or(0),"generated":status.source_scope_counts.get("generated").copied().unwrap_or(0),"excluded":status.source_scope_counts.get("excluded").copied().unwrap_or(0)}},"resolution":{"internal":["relative imports","$lib","@/","tsconfig/jsconfig baseUrl and paths","literal aliases from exported Vite/Webpack configs","safe static Vite/Webpack alias expressions (__dirname, root process.cwd(), path.resolve/join/dirname, new URL/import.meta.url, fileURLToPath(import.meta.url), and constants)","package.json imports aliases","static import/node/default/require/types package condition trees","declared npm and pnpm workspace package entries","static Yarn PnP JSON workspace package entries","Python relative and src-package imports","static Go module packages","static Rust crate/self/super modules in conventional Cargo src roots"],"limitations":["Arbitrary computed Vite/Webpack aliases, custom package conditions, unsupported pnpm YAML constructs, PHP Composer autoloading, Java framework wiring and non-local-static method dispatch, Rust custom Cargo targets and #[path] modules, Go build tags and duplicate package function names, and runtime module loading are not resolved."]},"calls":{"supported":["direct identifier calls to top-level local functions","direct identifier calls to named ES/CommonJS imports resolved inside the repository","direct identifier calls to top-level local Python functions and named ES/CommonJS imports resolved inside the repository","direct local Go function calls and aliased Go package selectors resolved inside the repository","direct local PHP function calls","direct local Rust functions and named crate/self/super imports","direct unqualified unique local static Java method calls"],"limitations":"Java instance/qualified/overloaded method dispatch, Rust macros, qualified module calls, trait dispatch, custom Cargo targets, and #[path] modules, default and namespace imports, PHP Composer/autoloaded functions, Python attribute calls, Go function values, ambiguous package functions, and unaliased package-name mismatches, dependency injection, callbacks, reflection, dynamic loading, and non-literal CommonJS requires are not resolved as call edges."},"entryPoints":status.entry_facts["entryPoints"],"adapterCapabilities":adapter_registry,"capabilities":adapter_registry["adapters"]},
        "stats":{"scannedFiles":summary["scannedFiles"],"parsedFiles":summary["parsedFiles"],"inventoryOnlyFiles":summary["inventoryOnlyFiles"],"parseFailedFiles":summary["parseFailedFiles"]}
    });
    if let Some(package_path) = package_path {
        public_graph_context["analysis"]["nativeBoundedPackagePath"] =
            Value::String(package_path.to_string());
    } else {
        public_graph_context["analysis"]
            .as_object_mut()
            .expect("native graph analysis is an object")
            .remove("nativeBoundedPackagePath");
    }
    // The compatibility contract is a set of supported call categories. Keep
    // its public array stable even if adjacent source declarations are merged
    // while evolving the native envelope.
    if let Some(supported) = public_graph_context
        .pointer_mut("/analysis/calls/supported")
        .and_then(Value::as_array_mut)
    {
        supported.dedup();
        for capability in supported {
            if capability.as_str()
                == Some(
                    "direct identifier calls to top-level local Python functions and named ES/CommonJS imports resolved inside the repository",
                )
            {
                *capability = Value::String(
                    "direct identifier calls to top-level local Python functions and named Python imports resolved inside the repository".to_string(),
                );
            }
        }
    }
    let mut batch = json!({
        "schemaVersion":STRUCTURAL_FACT_BATCH_SCHEMA,"projectId":status.project_identity.project_id,"packageCommands":status.entry_facts["packageCommands"],"entryMetadata":status.entry_facts["entryMetadata"],"entryEdgeMetadata":status.entry_facts["edgeMetadata"],"manualDescriptions":native_manual_descriptions(&status.project_root, &status.structural_records),
        "flowContext":{"graphVersion":0,"sourceRevision":git["revision"]},"flowEntries":{"primary":{"tests":scope.flow_entries_tests,"fixtures":scope.flow_entries_fixtures},"diagnostic":{"tests":true,"fixtures":true}},
        "lifecycleContext":{"sourceFingerprint":source_fingerprint,"sourceRevision":git["revision"],"updatedAt":generated_at,"refresh":refresh,"coverage":coverage},"publicGraphContext":public_graph_context
    });
    if !include_records {
        return Ok(batch);
    }
    batch["records"] = Value::Array(status.structural_records.clone());
    let facts_digest = structural_facts_digest(
        batch.as_object().expect("native batch is an object"),
    )
    .map_err(|message| NativeProtocolError {
        code: "native-source-facts-failed",
        message,
    })?;
    batch["factsDigest"] = Value::String(facts_digest);
    Ok(batch)
}

fn native_js_record_cache_load_raw(params: &Value) -> Result<Box<RawValue>, NativeProtocolError> {
    let root = project_root(params)?;
    let request = params
        .get("cacheRequest")
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "nativeJsRecordCache requires params.cacheRequest.".to_string(),
        })?;
    load_native_js_record_cache_raw(&root, request).map_err(|message| NativeProtocolError {
        code: "native-js-record-cache-failed",
        message,
    })
}

fn contains_source_body(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(contains_source_body),
        Value::Object(entries) => entries.iter().any(|(key, nested)| {
            let lower = key.to_ascii_lowercase();
            matches!(
                lower.as_str(),
                "content" | "contents" | "rawsource" | "sourcebody" | "sourcetext" | "text"
            ) || lower == "source" && !is_safe_source_reference(nested)
                || contains_source_body(nested)
        }),
        _ => false,
    }
}

fn is_safe_source_reference(value: &Value) -> bool {
    let Value::Object(reference) = value else {
        return value.is_null();
    };
    reference.len() == 2
        && reference
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty() && name.len() <= 240)
        && reference
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| !kind.is_empty() && kind.len() <= 80)
}

fn records_contain_source_body(records: &[Value]) -> bool {
    records.iter().any(contains_source_body)
}

fn string_field<'a>(
    value: &'a serde_json::Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, NativeProtocolError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: format!("StructuralFactBatch/v1 requires non-empty {field}."),
        })
}

fn structural_batch(params: &Value) -> Result<&Value, NativeProtocolError> {
    match params.get("batch") {
        Some(batch) if batch.is_object() => Ok(batch),
        Some(_) => Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message:
                "Native structural query params.batch must be a StructuralFactBatch/v1 object."
                    .to_string(),
        }),
        None => Ok(params),
    }
}

fn is_portable_repository_path(value: &str) -> bool {
    !value.is_empty()
        && !Path::new(value).is_absolute()
        && !value.contains('\\')
        && !value.split('/').any(|segment| segment == "..")
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

// The material fingerprint deliberately omits a small, fixed set of
// observational fields.  Serializing this borrowed view avoids cloning a
// multi-megabyte StructuralFactBatch on every incremental patch merely to
// remove those keys before hashing.  It preserves serde_json's canonical map
// order and value encoding, so the public JavaScript-compatible SHA-256
// contract is unchanged.
struct StructuralFactsCanonical<'a>(&'a serde_json::Map<String, Value>);

struct ObjectWithoutKeys<'a> {
    value: &'a Value,
    omitted: &'static [&'static str],
}

impl Serialize for ObjectWithoutKeys<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let Some(object) = self.value.as_object() else {
            return self.value.serialize(serializer);
        };
        let retained = object
            .keys()
            .filter(|key| !self.omitted.contains(&key.as_str()))
            .count();
        let mut map = serializer.serialize_map(Some(retained))?;
        for (key, value) in object {
            if !self.omitted.contains(&key.as_str()) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

impl Serialize for StructuralFactsCanonical<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        const ROOT_OMITTED: [&str; 3] = ["factsDigest", "projectRoot", "publicGraphContext"];
        let retained = self
            .0
            .keys()
            .filter(|key| !ROOT_OMITTED.contains(&key.as_str()))
            .count();
        let mut map = serializer.serialize_map(Some(retained))?;
        for (key, value) in self.0 {
            if ROOT_OMITTED.contains(&key.as_str()) {
                continue;
            }
            match key.as_str() {
                "lifecycleContext" => map.serialize_entry(
                    key,
                    &ObjectWithoutKeys {
                        value,
                        omitted: &["updatedAt", "refresh"],
                    },
                )?,
                "flowContext" => map.serialize_entry(
                    key,
                    &ObjectWithoutKeys {
                        value,
                        omitted: &["graphVersion"],
                    },
                )?,
                _ => map.serialize_entry(key, value)?,
            }
        }
        map.end()
    }
}

struct StructuralTopologyCanonical<'a>(&'a serde_json::Map<String, Value>);

struct RecordsWithoutSourceHashes<'a>(&'a Value);

impl Serialize for RecordsWithoutSourceHashes<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let Some(records) = self.0.as_array() else {
            return self.0.serialize(serializer);
        };
        let mut sequence = serializer.serialize_seq(Some(records.len()))?;
        for record in records {
            sequence.serialize_element(&ObjectWithoutKeys {
                value: record,
                omitted: &["sourceHash"],
            })?;
        }
        sequence.end()
    }
}

impl Serialize for StructuralTopologyCanonical<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        const ROOT_OMITTED: [&str; 3] = ["factsDigest", "projectRoot", "publicGraphContext"];
        let retained = self
            .0
            .keys()
            .filter(|key| !ROOT_OMITTED.contains(&key.as_str()))
            .count();
        let mut map = serializer.serialize_map(Some(retained))?;
        for (key, value) in self.0 {
            if ROOT_OMITTED.contains(&key.as_str()) {
                continue;
            }
            match key.as_str() {
                "lifecycleContext" => map.serialize_entry(
                    key,
                    &ObjectWithoutKeys {
                        value,
                        omitted: &[
                            "updatedAt",
                            "refresh",
                            "sourceFingerprint",
                            "sourceRevision",
                        ],
                    },
                )?,
                "flowContext" => map.serialize_entry(
                    key,
                    &ObjectWithoutKeys {
                        value,
                        omitted: &["graphVersion", "sourceRevision"],
                    },
                )?,
                "records" => map.serialize_entry(key, &RecordsWithoutSourceHashes(value))?,
                _ => map.serialize_entry(key, value)?,
            }
        }
        map.end()
    }
}

struct Sha256Writer(Sha256);

impl Write for Sha256Writer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
fn structural_facts_canonical_json(
    batch: &serde_json::Map<String, Value>,
) -> Result<String, String> {
    serde_json::to_string(&StructuralFactsCanonical(batch))
        .map_err(|error| format!("Unable to canonicalize structural facts: {error}"))
}

fn structural_facts_digest(batch: &serde_json::Map<String, Value>) -> Result<String, String> {
    let mut writer = Sha256Writer(Sha256::new());
    serde_json::to_writer(&mut writer, &StructuralFactsCanonical(batch))
        .map_err(|error| format!("Unable to canonicalize structural facts: {error}"))?;
    Ok(format!("sha256:{:x}", writer.0.finalize()))
}

// This is deliberately narrower than the material fingerprint: changing a
// source hash must still advance the public graph version and preserve stale
// Context Ref semantics, but it must not force a graph/flow rebuild when the
// JavaScript adapter emitted identical structural facts.
fn structural_topology_digest(batch: &serde_json::Map<String, Value>) -> Result<String, String> {
    let mut writer = Sha256Writer(Sha256::new());
    serde_json::to_writer(&mut writer, &StructuralTopologyCanonical(batch))
        .map_err(|error| format!("Unable to canonicalize structural topology: {error}"))?;
    Ok(format!("sha256:{:x}", writer.0.finalize()))
}

fn topology_record_value(record: &Value) -> Option<Value> {
    let mut record = record.as_object()?.clone();
    record.remove("sourceHash");
    Some(Value::Object(record))
}

fn topology_envelope_value(batch: &serde_json::Map<String, Value>) -> Value {
    let mut envelope = batch.clone();
    envelope.remove("records");
    envelope.remove("factsDigest");
    envelope.remove("projectRoot");
    envelope.remove("publicGraphContext");
    if let Some(lifecycle) = envelope
        .get_mut("lifecycleContext")
        .and_then(Value::as_object_mut)
    {
        lifecycle.remove("updatedAt");
        lifecycle.remove("refresh");
        lifecycle.remove("sourceFingerprint");
        lifecycle.remove("sourceRevision");
    }
    if let Some(flow_context) = envelope
        .get_mut("flowContext")
        .and_then(Value::as_object_mut)
    {
        flow_context.remove("graphVersion");
        flow_context.remove("sourceRevision");
    }
    Value::Object(envelope)
}

fn record_has_cross_file_or_global_facts(record: &Value) -> bool {
    let Some(result) = record.get("result").and_then(Value::as_object) else {
        return true;
    };
    if [
        "resolvedImports",
        "resolvedPackages",
        "externalImports",
        "endpoints",
        "frameworkCommands",
        "schedules",
        "requests",
    ]
    .iter()
    .any(|field| {
        result
            .get(*field)
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    }) {
        return true;
    }
    result
        .get("calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|call| call.get("imported").is_some_and(Value::is_object))
}

fn record_references_path(record: &Value, path: &str) -> bool {
    let Some(result) = record.get("result").and_then(Value::as_object) else {
        return true;
    };
    result
        .get("resolvedImports")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| item.get("targetPath").and_then(Value::as_str) == Some(path))
        || result
            .get("resolvedPackages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|item| {
                item.get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|file| file.as_str() == Some(path))
            })
}

// Return a record path only when rebuilding that one record cannot alter any
// cross-file or global contribution. This intentionally abstains for the vast
// majority of edits; correctness and public ordering win over cache breadth.
fn isolated_structural_change_path(
    previous: &serde_json::Map<String, Value>,
    current: &serde_json::Map<String, Value>,
) -> Option<String> {
    if topology_envelope_value(previous) != topology_envelope_value(current) {
        return None;
    }
    let previous_records = previous.get("records")?.as_array()?;
    let current_records = current.get("records")?.as_array()?;
    if previous_records.len() != current_records.len() {
        return None;
    }
    let previous_by_path = previous_records
        .iter()
        .filter_map(|record| {
            record
                .get("relativePath")
                .and_then(Value::as_str)
                .map(|path| (path, record))
        })
        .collect::<BTreeMap<_, _>>();
    let current_by_path = current_records
        .iter()
        .filter_map(|record| {
            record
                .get("relativePath")
                .and_then(Value::as_str)
                .map(|path| (path, record))
        })
        .collect::<BTreeMap<_, _>>();
    if previous_by_path.len() != previous_records.len()
        || current_by_path.len() != current_records.len()
        || previous_by_path.keys().ne(current_by_path.keys())
    {
        return None;
    }
    let changed = current_by_path
        .iter()
        .filter_map(|(path, current_record)| {
            (topology_record_value(previous_by_path[*path])
                != topology_record_value(current_record))
            .then_some(*path)
        })
        .collect::<Vec<_>>();
    let [path] = changed.as_slice() else {
        return None;
    };
    let previous_record = previous_by_path[*path];
    let current_record = current_by_path[*path];
    if record_has_cross_file_or_global_facts(previous_record)
        || record_has_cross_file_or_global_facts(current_record)
    {
        return None;
    }
    if current_by_path
        .iter()
        .filter(|(other_path, _)| **other_path != *path)
        .any(|(_, record)| record_references_path(record, path))
    {
        return None;
    }
    current
        .get("packageCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .all(|command| command.get("targetPath").and_then(Value::as_str) != Some(path))
        .then_some((*path).to_string())
}

fn build_isolated_incremental_graph(
    batch: &Value,
    previous_projection: &Value,
    changed_path: &str,
) -> Result<StructuralGraphProjection, NativeProtocolError> {
    let batch_object = batch.as_object().ok_or_else(|| NativeProtocolError {
        code: "invalid-structural-facts",
        message: "StructuralFactBatch/v1 must be an object.".to_string(),
    })?;
    let changed_record = batch_object
        .get("records")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|record| record.get("relativePath").and_then(Value::as_str) == Some(changed_path))
        .cloned()
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "Incremental structural record is missing from the current fact batch."
                .to_string(),
        })?;
    let mut isolated = batch_object.clone();
    isolated.insert("records".to_string(), Value::Array(vec![changed_record]));
    isolated.insert("packageCommands".to_string(), Value::Array(Vec::new()));
    let changed_graph = build_structural_graph(&Value::Object(isolated)).map_err(|message| {
        NativeProtocolError {
            code: "structural-graph-failed",
            message,
        }
    })?;
    let previous =
        structural_graph_snapshot(previous_projection).map_err(|message| NativeProtocolError {
            code: "store-read-failed",
            message,
        })?;
    let removed_ids = previous
        .nodes
        .iter()
        .filter(|node| node.path.as_deref() == Some(changed_path))
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let mut nodes = previous
        .nodes
        .into_iter()
        .filter(|node| !removed_ids.contains(&node.id))
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    for node in changed_graph.nodes {
        nodes.insert(node.id.clone(), node);
    }
    let mut edges = previous
        .edges
        .into_iter()
        .filter(|edge| !removed_ids.contains(&edge.source) && !removed_ids.contains(&edge.target))
        .map(|edge| {
            (
                (
                    edge.edge_type.clone(),
                    edge.source.clone(),
                    edge.target.clone(),
                ),
                edge,
            )
        })
        .collect::<BTreeMap<_, _>>();
    for edge in changed_graph.edges {
        edges.insert(
            (
                edge.edge_type.clone(),
                edge.source.clone(),
                edge.target.clone(),
            ),
            edge,
        );
    }
    structural_graph_projection_from_parts(
        nodes.into_values().collect(),
        edges.into_values().collect(),
    )
    .map_err(|message| NativeProtocolError {
        code: "structural-graph-serialize-failed",
        message,
    })
}

fn projection_digest(projection: &Value) -> Result<String, NativeProtocolError> {
    let serialized = serde_json::to_vec(projection).map_err(|error| NativeProtocolError {
        code: "structural-graph-serialize-failed",
        message: error.to_string(),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(serialized)))
}

fn submit_structural_facts_with_verified_digest(
    params: &Value,
    verified_digest: Option<&str>,
) -> Result<Value, NativeProtocolError> {
    let batch_value = structural_batch(params)?;
    let Some(batch) = batch_value.as_object() else {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "submitStructuralFacts params must be a StructuralFactBatch/v1 object."
                .to_string(),
        });
    };
    if batch.get("schemaVersion").and_then(Value::as_str) != Some(STRUCTURAL_FACT_BATCH_SCHEMA) {
        return Err(NativeProtocolError {
            code: "unsupported-structural-facts",
            message: format!("Structural facts must use {STRUCTURAL_FACT_BATCH_SCHEMA}."),
        });
    }
    let project_id = string_field(batch, "projectId")?;
    let facts_digest = string_field(batch, "factsDigest")?;
    if !facts_digest.starts_with("sha256:") || !is_sha256_hex(&facts_digest[7..]) {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 factsDigest must be a SHA-256 digest.".to_string(),
        });
    }
    // Patch reconstruction has already canonicalized this exact batch and
    // checked the caller's optional expected digest. Reuse that internal
    // proof, while ordinary protocol requests continue to hash independently.
    let expected_facts_digest = match verified_digest {
        Some(digest) => digest.to_string(),
        None => structural_facts_digest(batch).map_err(|message| NativeProtocolError {
            code: "invalid-structural-facts",
            message,
        })?,
    };
    if facts_digest != expected_facts_digest {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 factsDigest does not match its canonical payload."
                .to_string(),
        });
    }
    let Some(records) = batch.get("records").and_then(Value::as_array) else {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 requires records.".to_string(),
        });
    };
    if records.len() > 100_000 || records_contain_source_body(records) {
        return Err(NativeProtocolError {
            code: "unsafe-structural-facts",
            message:
                "StructuralFactBatch/v1 must not contain source bodies and must remain bounded."
                    .to_string(),
        });
    }
    let mut record_orders = std::collections::BTreeSet::new();
    for record in records {
        let Some(record) = record.as_object() else {
            return Err(NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 records must be objects.".to_string(),
            });
        };
        let relative_path = string_field(record, "relativePath")?;
        if !is_portable_repository_path(relative_path) {
            return Err(NativeProtocolError {
                code: "invalid-structural-facts",
                message:
                    "StructuralFactBatch/v1 record paths must be portable and repository-relative."
                        .to_string(),
            });
        }
        let record_order = record
            .get("recordOrder")
            .and_then(Value::as_u64)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 recordOrder must be a non-negative integer."
                    .to_string(),
            })?;
        if !record_orders.insert(record_order) {
            return Err(NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 recordOrder values must be unique.".to_string(),
            });
        }
        let source_hash = string_field(record, "sourceHash")?;
        if !is_sha256_hex(source_hash) {
            return Err(NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 record sourceHash must be a SHA-256 hex digest."
                    .to_string(),
            });
        }
        if !record.contains_key("result") {
            return Err(NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 records require result facts.".to_string(),
            });
        }
        if let Some(resolved_imports) = record
            .get("result")
            .and_then(Value::as_object)
            .and_then(|result| result.get("resolvedImports"))
        {
            let Some(resolved_imports) = resolved_imports.as_array() else {
                return Err(NativeProtocolError {
                    code: "invalid-structural-facts",
                    message: "StructuralFactBatch/v1 resolvedImports must be an array.".to_string(),
                });
            };
            for resolved_import in resolved_imports {
                let Some(resolved_import) = resolved_import.as_object() else {
                    return Err(NativeProtocolError {
                        code: "invalid-structural-facts",
                        message: "StructuralFactBatch/v1 resolvedImports must contain objects."
                            .to_string(),
                    });
                };
                string_field(resolved_import, "specifier")?;
                let target_path = string_field(resolved_import, "targetPath")?;
                if !is_portable_repository_path(target_path) {
                    return Err(NativeProtocolError {
                        code: "invalid-structural-facts",
                        message: "StructuralFactBatch/v1 resolved import target paths must be portable and repository-relative.".to_string(),
                    });
                }
            }
        }
    }
    if !record_orders.iter().copied().eq(0..records.len() as u64) {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 recordOrder values must be contiguous from zero."
                .to_string(),
        });
    }
    Ok(json!({
        "schemaVersion": STRUCTURAL_FACT_BATCH_SCHEMA,
        "projectId": project_id,
        "acceptedRecords": records.len(),
        "factsDigest": facts_digest,
        "stored": false,
        "limitation": "Structural facts are validated transport input only. JavaScript remains authoritative for graph assembly and public output.",
    }))
}

fn submit_structural_facts(params: &Value) -> Result<Value, NativeProtocolError> {
    submit_structural_facts_with_verified_digest(params, None)
}

fn native_member_summary(node: &crate::structural_graph::StructuralGraphNode) -> Value {
    let mut summary = serde_json::Map::new();
    summary.insert("id".to_string(), Value::String(node.id.clone()));
    summary.insert(
        "label".to_string(),
        node.metadata
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|metadata| metadata.get("label"))
            .cloned()
            .unwrap_or_else(|| Value::String(node.id.clone())),
    );
    summary.insert("type".to_string(), Value::String(node.node_type.clone()));
    summary.insert("kind".to_string(), Value::String(node.kind.clone()));
    summary.insert(
        "path".to_string(),
        node.path
            .as_ref()
            .map(|path| Value::String(path.clone()))
            .unwrap_or(Value::Null),
    );
    Value::Object(summary)
}

fn metadata<'a>(node: &'a StructuralGraphNode, key: &str) -> Option<&'a Value> {
    node.metadata.as_ref()?.as_object()?.get(key)
}

fn metadata_string(node: &StructuralGraphNode, key: &str) -> Option<String> {
    metadata(node, key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn node_label(node: &StructuralGraphNode) -> String {
    metadata_string(node, "label").unwrap_or_else(|| node.id.clone())
}

fn flow_source_scope(node: &StructuralGraphNode) -> String {
    metadata_string(node, "sourceScope").unwrap_or_else(|| "application".to_string())
}

fn flow_entry_kind(node: &StructuralGraphNode) -> Option<String> {
    metadata_string(node, "entryKind")
}

fn is_native_flow_entry(node: &StructuralGraphNode) -> bool {
    node.kind == "endpoint"
        || node.kind == "command"
            && matches!(
                flow_entry_kind(node).as_deref(),
                Some("package-script")
                    | Some("django-management-command")
                    | Some("framework-command")
            )
        || node.kind == "schedule" && flow_entry_kind(node).as_deref() == Some("node-cron-schedule")
}

fn native_edge_key(edge: &crate::structural_graph::StructuralGraphEdge) -> String {
    format!("{}\0{}\0{}", edge.source, edge.target, edge.edge_type)
}

/// JavaScript orders public graph nodes by display label. Entry ordering is
/// therefore a property of the native structural projection, not a graph-order
/// hint that the JavaScript oracle needs to send across the protocol boundary.
/// The shared comparator preserves the audited ASCII punctuation rules and
/// uses ICU-backed collation for non-ASCII labels and public IDs.
fn native_entry_cmp(
    left: &&StructuralGraphNode,
    right: &&StructuralGraphNode,
) -> std::cmp::Ordering {
    javascript_ascii_cmp(&node_label(left), &node_label(right))
        .then_with(|| javascript_ascii_cmp(&left.id, &right.id))
}

fn flow_contract(node: &StructuralGraphNode) -> Value {
    let label = node_label(node);
    let evidence = metadata(node, "evidence").cloned().unwrap_or(Value::Null);
    if node.kind == "endpoint" {
        let mut parts = label.splitn(2, ' ');
        return json!({"schemaVersion":"flopeek-static-flow-entry/v1","kind":"http-request","family":"http","nodeId":&node.id,"label":label,"declaration":{"method":parts.next().unwrap_or_default(),"route":parts.next().unwrap_or_default()},"evidence":evidence,"limitations":["The literal HTTP entry is static parser evidence. It does not prove a request was received, handler execution, runtime order, or business behavior."]});
    }
    let kind = flow_entry_kind(node).unwrap_or_default();
    if kind == "package-script" {
        return json!({"schemaVersion":"flopeek-static-flow-entry/v1","kind":"package-script","family":"command","nodeId":&node.id,"label":label,"declaration":{"manifest":metadata(node,"manifest").cloned().unwrap_or(Value::Null),"scriptName":metadata(node,"scriptName").cloned().unwrap_or(Value::Null),"runner":metadata(node,"runner").cloned().unwrap_or(Value::Null),"targetPath":metadata(node,"targetPath").cloned().unwrap_or(Value::Null)},"evidence":evidence,"limitations":["The literal package script is static manifest evidence. It does not prove that a shell invoked it, that the runner exists, or that its target executed successfully.","Only the declared direct runner-to-source-file target is projected; shell composition, environment expansion, package-manager indirection, and runtime module loading are outside this entry contract."]});
    }
    if node.kind == "command" {
        return json!({"schemaVersion":"flopeek-static-flow-entry/v1","kind":"framework-command","family":"command","nodeId":&node.id,"label":label,"declaration":{"adapter":metadata(node,"adapter").cloned().unwrap_or_else(|| json!("django")),"commandName":metadata(node,"commandName").cloned().unwrap_or(Value::Null),"targetPath":metadata(node,"targetPath").cloned().unwrap_or_else(|| node.path.clone().map(Value::String).unwrap_or(Value::Null)),"targetId":metadata(node,"targetId").cloned().unwrap_or(Value::Null)},"evidence":evidence,"limitations":["The framework command is an exact static declaration subset. It does not prove app registration, settings loading, command invocation, handle execution, or successful behavior.","Only top-level command declarations directly extending or decorated by supported framework bindings with a direct target method or function are projected."]});
    }
    json!({"schemaVersion":"flopeek-static-flow-entry/v1","kind":"scheduled-task","family":"scheduler","nodeId":&node.id,"label":label,"declaration":{"adapter":"node-cron","expression":metadata(node,"scheduleExpression").cloned().unwrap_or(Value::Null),"taskName":metadata(node,"taskName").cloned().unwrap_or(Value::Null),"targetPath":metadata(node,"targetPath").cloned().unwrap_or_else(|| node.path.clone().map(Value::String).unwrap_or(Value::Null))},"evidence":evidence,"limitations":["The node-cron registration is static syntax evidence. It does not prove scheduler initialization, registration execution, schedule timing, task execution, or successful behavior.","Only a module-scope literal cron expression and one exact local top-level function identifier are projected; inline callbacks, imported callbacks, dynamic expressions, nested registration, and other scheduler APIs are outside this entry contract."]})
}

fn assemble_native_flows_from_projection(
    batch: &Value,
    projection: &StructuralGraphProjection,
    include_tests: bool,
    include_fixtures: bool,
) -> Value {
    let nodes = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut outgoing = std::collections::BTreeMap::<String, Vec<_>>::new();
    for edge in &projection.edges {
        outgoing.entry(edge.source.clone()).or_default().push(edge);
    }
    let edge_order = structural_edge_traversal_order(batch, projection);
    for edges in outgoing.values_mut() {
        edges.sort_by_key(|edge| {
            edge_order
                .get(&native_edge_key(edge))
                .copied()
                .unwrap_or(usize::MAX)
        });
    }
    let mut entries = projection
        .nodes
        .iter()
        .filter(|node| {
            let source_scope = flow_source_scope(node);
            is_native_flow_entry(node)
                && (source_scope == "application"
                    || source_scope.is_empty()
                    || source_scope == "test" && include_tests
                    || source_scope == "fixture" && include_fixtures)
        })
        .collect::<Vec<_>>();
    entries.sort_by(native_entry_cmp);
    let flows = entries.into_iter().map(|entry| {
        let mut queue = std::collections::VecDeque::from([(entry.id.clone(), 0usize)]);
        let mut visited = std::collections::BTreeSet::new();
        let mut steps = Vec::new();
        while let Some((id, depth)) = queue.pop_front() {
            if visited.contains(&id) || depth > 6 || steps.len() >= 24 { continue; }
            visited.insert(id.clone());
            let Some(node) = nodes.get(id.as_str()) else { continue; };
            if matches!(flow_source_scope(node).as_str(), "test" | "fixture" | "generated") { continue; }
            steps.push(json!({"id":&node.id,"label":node_label(node),"type":&node.node_type,"depth":depth}));
            for edge in outgoing.get(&id).into_iter().flatten() {
                let allowed = if depth == 0 && entry.kind == "endpoint" { edge.edge_type == "handles" } else if depth == 0 && entry.kind == "command" { edge.edge_type == "declares-command-target" } else if depth == 0 && entry.kind == "schedule" { edge.edge_type == "schedules" } else { edge.edge_type != "contains" && edge.edge_type != "declares" };
                if allowed { queue.push_back((edge.target.clone(), depth + 1)); }
            }
        }
        json!({"id":format!("flow:{}",entry.id),"title":node_label(entry),"entryId":&entry.id,"entry":flow_contract(entry),"steps":steps})
    }).collect::<Vec<_>>();
    Value::Array(flows)
}

fn assemble_native_flows_for_scope(
    params: &Value,
    include_tests: bool,
    include_fixtures: bool,
) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    Ok(assemble_native_flows_from_projection(
        batch,
        &projection,
        include_tests,
        include_fixtures,
    ))
}

fn configured_flow_scope(batch: &Value, name: &str) -> (bool, bool) {
    let scope = batch
        .get("flowEntries")
        .and_then(Value::as_object)
        .and_then(|entries| entries.get(name))
        .and_then(Value::as_object);
    (
        scope
            .and_then(|scope| scope.get("tests"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        scope
            .and_then(|scope| scope.get("fixtures"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

fn assemble_native_flows(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let (include_tests, include_fixtures) = configured_flow_scope(batch, "primary");
    assemble_native_flows_for_scope(params, include_tests, include_fixtures)
}

fn assemble_native_diagnostic_flows(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let (include_tests, include_fixtures) = configured_flow_scope(batch, "diagnostic");
    assemble_native_flows_for_scope(params, include_tests, include_fixtures)
}

fn get_native_entry_flows(
    params: &Value,
    legacy_request_alias: bool,
) -> Result<Value, NativeProtocolError> {
    let entry = params
        .get("entry")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let scope = params
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("application");
    let available = if scope == "all" {
        assemble_native_diagnostic_flows(params)?
    } else {
        assemble_native_flows(params)?
    };
    let available_flows = available.as_array().cloned().unwrap_or_default();
    let query = entry.trim().to_ascii_lowercase();
    let flows = available_flows
        .iter()
        .filter(|flow| {
            query.is_empty()
                || flow["title"]
                    .as_str()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .contains(&query)
                || flow["entryId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .contains(&query)
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut families = BTreeMap::<String, usize>::new();
    for flow in &flows {
        let family = flow["entry"]["family"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        *families.entry(family).or_default() += 1;
    }
    let returned_ids = flows
        .iter()
        .filter_map(|flow| flow["id"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let omitted = available_flows
        .iter()
        .filter_map(|flow| flow["id"].as_str())
        .filter(|id| !returned_ids.contains(id))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let truncated = !omitted.is_empty();
    let warning = if truncated {
        Value::String(format!(
            "{} detected Flow Lens item(s) are not included in this response.",
            omitted.len()
        ))
    } else {
        Value::Null
    };
    let mut result = json!({
        "query": if entry.is_empty() { Value::Null } else { Value::String(entry.to_string()) },
        "scope": scope,
        "flows": flows,
        "flowCatalog": {
            "total": available_flows.len(),
            "returned": returned_ids.len(),
            "omittedFlowIds": omitted,
            "truncated": truncated,
            "warning": warning,
        },
        "entryFamilies": families,
        "limitation": "Flow steps are static graph traversal from supported detected entry facts. They do not prove command invocation, runtime order, dynamic execution, or business behavior.",
    });
    if legacy_request_alias {
        let object = result
            .as_object_mut()
            .expect("entry flow result is an object");
        object.insert(
            "legacyAlias".to_string(),
            Value::String("get_request_flows".to_string()),
        );
        object.insert("limitation".to_string(), Value::String("This legacy request-flow alias returns all supported static entry flows. Flow steps do not prove command invocation, runtime order, dynamic execution, or business behavior.".to_string()));
    }
    Ok(result)
}

fn native_scope_includes(scope: &str, layer: &str) -> bool {
    match scope {
        "all" => matches!(
            layer,
            "application"
                | "runtime"
                | "framework"
                | "devtool"
                | "package"
                | "test"
                | "fixture"
                | "generated"
        ),
        "runtime" => matches!(layer, "application" | "runtime"),
        "framework" => matches!(layer, "application" | "framework"),
        "devtool" => matches!(layer, "application" | "devtool"),
        _ => layer == "application",
    }
}

fn native_node_rank(node: &StructuralGraphNode) -> usize {
    match node.node_type.as_str() {
        "endpoint" => 0,
        "command" => 1,
        "schedule" => 2,
        "route" => 3,
        "controller" => 4,
        "service" => 5,
        "class" => 6,
        "function" => 7,
        "repository" => 8,
        "database" => 9,
        "queue" => 10,
        "module" => 11,
        _ => 99,
    }
}

fn get_native_find_nodes(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let requested = params
        .get("query")
        .or_else(|| params.get("q"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let query = requested.trim().to_ascii_lowercase();
    let scope = params
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("application");
    if query.is_empty() {
        return Ok(json!({"query":"","results":[]}));
    }
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let mut matches = projection
        .nodes
        .iter()
        .filter(|node| {
            native_scope_includes(scope, &metadata_string(node, "layer").unwrap_or_default())
        })
        .filter(|node| {
            [
                node_label(node),
                node.path.clone().unwrap_or_default(),
                metadata_string(node, "feature").unwrap_or_default(),
                metadata_string(node, "domain").unwrap_or_default(),
                node.node_type.clone(),
            ]
            .join(" ")
            .to_ascii_lowercase()
            .contains(&query)
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        native_node_rank(left)
            .cmp(&native_node_rank(right))
            .then_with(|| javascript_ascii_locale_cmp(&node_label(left), &node_label(right)))
    });
    Ok(json!({
        "query": query,
        "scope": scope,
        "results": matches.into_iter().take(12).map(native_member_summary).collect::<Vec<_>>(),
    }))
}

fn get_native_node_details(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let node_id = params
        .get("nodeId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNodeDetails requires params.nodeId.".to_string(),
        })?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let nodes = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let Some(node) = nodes.get(node_id).copied() else {
        return Ok(Value::Null);
    };
    let edge_order = structural_edge_traversal_order(batch, &projection);
    let mut details = projection
        .edges
        .iter()
        .filter_map(|edge| {
            let related_id = if edge.target == node_id {
                Some(("incoming", edge.source.as_str()))
            } else if edge.source == node_id {
                Some(("outgoing", edge.target.as_str()))
            } else {
                None
            }?;
            let related = nodes.get(related_id.1).copied()?;
            let mut value = native_public_edge(edge);
            value["node"] = native_public_node(related);
            Some((
                related_id.0,
                native_edge_key(edge),
                value,
                related.node_type == "test",
            ))
        })
        .collect::<Vec<_>>();
    details.sort_by(|left, right| {
        edge_order
            .get(&left.1)
            .copied()
            .unwrap_or(usize::MAX)
            .cmp(&edge_order.get(&right.1).copied().unwrap_or(usize::MAX))
    });
    let incoming = details
        .iter()
        .filter(|item| item.0 == "incoming")
        .map(|item| item.2.clone())
        .collect::<Vec<_>>();
    let outgoing = details
        .iter()
        .filter(|item| item.0 == "outgoing")
        .map(|item| item.2.clone())
        .collect::<Vec<_>>();
    let related_tests = details
        .into_iter()
        .filter(|item| item.3)
        .map(|item| item.2)
        .collect::<Vec<_>>();
    Ok(json!({
        "node": native_public_node(node),
        "incoming": incoming,
        "outgoing": outgoing,
        "relatedTests": related_tests,
    }))
}

fn encode_context_part(value: &str) -> String {
    value.bytes().fold(String::new(), |mut encoded, byte| {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
        encoded
    })
}

fn create_native_context_ref(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let project_id = batch
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 requires projectId.".to_string(),
        })?;
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "createContextRef requires params.kind.".to_string(),
        })?;
    let context_id = params
        .get("contextId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "createContextRef requires params.contextId.".to_string(),
        })?;
    let version = batch
        .get("flowContext")
        .and_then(Value::as_object)
        .and_then(|context| context.get("graphVersion"))
        .and_then(Value::as_u64)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-context",
            message:
                "StructuralFactBatch/v1 flowContext.graphVersion must be a non-negative integer."
                    .to_string(),
        })?;
    Ok(json!(format!(
        "fp://local/{}/{}/{}@{version}",
        encode_context_part(project_id),
        encode_context_part(kind),
        encode_context_part(context_id)
    )))
}

fn flow_step_role(node: &StructuralGraphNode) -> &'static str {
    match (node.kind.as_str(), node.node_type.as_str()) {
        ("endpoint", _) => "entry",
        ("command", _) => "command-entry",
        ("schedule", _) => "scheduled-entry",
        (_, "route") | (_, "controller") => "routing",
        (_, "service") => "orchestration",
        (_, "repository") | (_, "database") => "persistence",
        (_, "queue") => "async-boundary",
        (_, "external") => "external-boundary",
        ("symbol", _) => "implementation",
        (_, "module") => "module",
        _ => "technical-component",
    }
}

fn flow_static_boundary(node: &StructuralGraphNode) -> Option<&'static str> {
    match node.node_type.as_str() {
        "database" => Some("persistence"),
        "queue" => Some("async"),
        "external" => Some("external"),
        _ => None,
    }
}

fn flow_edge_evidence(edge: &crate::structural_graph::StructuralGraphEdge) -> Value {
    json!({"id":format!("edge:{}|{}|{}",edge.source,edge.edge_type,edge.target),"sourceId":&edge.source,"targetId":&edge.target,"type":&edge.edge_type,"confidence":edge.confidence.clone().unwrap_or_else(||json!("unknown")),"evidence":edge.evidence.clone().unwrap_or(Value::Null)})
}

fn native_flow_lens_from_assembled(
    batch: &Value,
    flows: &[Value],
    projection: &StructuralGraphProjection,
    flow_id: &str,
    max_steps: u64,
) -> Result<Value, NativeProtocolError> {
    let flow = flows
        .iter()
        .find(|flow| flow["id"] == flow_id || flow["entryId"] == flow_id)
        .cloned()
        .ok_or_else(|| NativeProtocolError {
            code: "missing-flow",
            message: "No native flow matches params.flowId.".to_string(),
        })?;
    let nodes = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    let source_steps = flow["steps"].as_array().cloned().unwrap_or_default();
    let displayed = source_steps
        .iter()
        .take(max_steps as usize)
        .collect::<Vec<_>>();
    let displayed_ids = displayed
        .iter()
        .filter_map(|step| step["id"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let depth_by_id = source_steps
        .iter()
        .filter_map(|step| Some((step["id"].as_str()?, step["depth"].as_u64()?)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut transitions = projection
        .edges
        .iter()
        .filter(|edge| {
            displayed_ids.contains(edge.source.as_str())
                && displayed_ids.contains(edge.target.as_str())
                && depth_by_id.get(edge.source.as_str()).is_some_and(|depth| {
                    *depth + 1 == *depth_by_id.get(edge.target.as_str()).unwrap_or(&u64::MAX)
                })
        })
        .collect::<Vec<_>>();
    transitions
        .sort_by_key(|edge| format!("edge:{}|{}|{}", edge.source, edge.edge_type, edge.target));
    let mut parent = std::collections::BTreeMap::new();
    for edge in &transitions {
        parent.entry(edge.target.as_str()).or_insert(edge);
    }
    let project_id = batch["projectId"].as_str().unwrap_or_default();
    let version = batch["flowContext"]["graphVersion"].as_u64().unwrap_or(0);
    let source_revision = batch["flowContext"]["sourceRevision"].clone();
    let steps = displayed.iter().enumerate().filter_map(|(index, step)| {
        let id = step["id"].as_str()?; let node = nodes.get(id)?; let edge = parent.get(id).copied();
        let parents = transitions.iter().filter(|item| item.target == id).collect::<Vec<_>>();
        // `parent` is keyed by target for primary-parent lookup. Its BTreeMap
        // iteration order is therefore target-ID order, while the public Flow
        // Lens contract orders branch transitions by evidence-edge ID.
        let mut children = parent
            .values()
            .filter(|item| item.source == id)
            .copied()
            .collect::<Vec<_>>();
        children.sort_by_key(|item| {
            format!("edge:{}|{}|{}", item.source, item.edge_type, item.target)
        });
        let omitted = projection.edges.iter().filter(|item| item.source == id && depth_by_id.get(item.target.as_str()).is_some_and(|target_depth| *target_depth == step["depth"].as_u64().unwrap_or(0) + 1) && !displayed_ids.contains(item.target.as_str())).count();
        let branch = (children.len() + omitted > 1).then(|| json!({"kind":"fan-out","transitions":children.iter().map(|item|flow_edge_evidence(item)).collect::<Vec<_>>(),"omittedTargets":omitted}));
        let confidence = edge.and_then(|item| item.confidence.clone()).or_else(|| metadata(node,"analysis").and_then(Value::as_object).and_then(|analysis| analysis.get("confidence")).cloned()).unwrap_or_else(||json!("unknown"));
        Some(json!({"index":index + 1,"depth":step["depth"],"id":id,"node":native_member_summary(node),"role":flow_step_role(node),"knowledgeClass":"derived","confidence":confidence,"contextRef":format!("fp://local/{}/node/{}@{version}",encode_context_part(project_id),encode_context_part(id)),"transition":edge.map(|item|flow_edge_evidence(item)),"alternativeIncomingTransitions":parents.iter().skip(1).map(|item|flow_edge_evidence(item)).collect::<Vec<_>>(),"branch":branch,"staticBoundary":flow_static_boundary(node)}))
    }).collect::<Vec<_>>();
    let static_boundaries = steps.iter().filter_map(|step| step["staticBoundary"].as_str().map(|category| json!({"category":category,"node":step["node"].clone(),"contextRef":step["contextRef"].clone(),"knowledgeClass":"derived"}))).collect::<Vec<_>>();
    let missing_transitions = steps
        .iter()
        .skip(1)
        .filter(|&step| step["transition"].is_null())
        .map(|step| step["id"].clone())
        .collect::<Vec<_>>();
    let display_truncated = source_steps.len() > displayed.len();
    let source_traversal_may_be_truncated = source_steps.len() >= 24;
    let truncation = json!({
        "requestedMaxSteps":max_steps,
        "displayedSteps":displayed.len(),
        "sourceFlowSteps":source_steps.len(),
        "displayTruncated":display_truncated,
        "displayTruncationReason":if display_truncated { json!("requested-step-limit-reached") } else { Value::Null },
        "sourceTraversalStepBound":24,
        "sourceTraversalMayBeTruncated":source_traversal_may_be_truncated,
        "sourceTraversalTruncationReason":if source_traversal_may_be_truncated { json!("source-traversal-bound-reached") } else { Value::Null },
        "missingTransitionEvidence":missing_transitions,
    });

    let entry_id = flow["entryId"].as_str().unwrap_or_default();
    let entry_node = nodes.get(entry_id).copied();
    let entry = flow["entry"].clone();
    let entry_kind = entry["kind"].as_str().unwrap_or("unknown-static-entry");
    let entry_family = entry["family"].as_str().unwrap_or("unknown");
    let declaration = entry["declaration"].as_object();
    let edge_order = structural_edge_traversal_order(batch, projection);
    let first_matching_edge = |edge_type: &str| {
        projection
            .edges
            .iter()
            .filter(|edge| edge.source == entry_id && edge.edge_type == edge_type)
            .min_by_key(|edge| {
                edge_order
                    .get(&native_edge_key(edge))
                    .copied()
                    .unwrap_or(usize::MAX)
            })
    };
    let handler_edge = (entry_kind == "http-request")
        .then(|| first_matching_edge("handles"))
        .flatten();
    let handler_node = handler_edge.and_then(|edge| nodes.get(edge.target.as_str()).copied());
    let exact_handler = handler_node.is_some_and(|node| node.kind == "symbol")
        && handler_edge
            .and_then(|edge| edge.confidence.as_ref())
            .is_some_and(|confidence| confidence == "exact");
    let sibling_handler_ids = source_steps
        .iter()
        .filter_map(|step| {
            let node = nodes.get(step["id"].as_str()?).copied()?;
            (node.kind == "symbol"
                && entry_node.is_some_and(|entry_node| node.path == entry_node.path)
                && matches!(
                    node_label(node).as_str(),
                    "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
                )
                && Some(node.id.as_str()) != handler_node.map(|item| item.id.as_str()))
            .then(|| Value::String(node.id.clone()))
        })
        .collect::<Vec<_>>();
    let handler_evidence = json!({
        "binding":if exact_handler { "exact-handler" } else if handler_node.is_some() { "non-exact-handler" } else { "file-fallback" },
        "handlerId":handler_node.map(|node| node.id.clone()),
        "edge":handler_edge.map(flow_edge_evidence),
        "siblingHandlerContamination":!sibling_handler_ids.is_empty(),
        "siblingHandlerIds":sibling_handler_ids,
    });
    let command_target_edge = (entry_family == "command")
        .then(|| first_matching_edge("declares-command-target"))
        .flatten();
    let command_target =
        command_target_edge.and_then(|edge| nodes.get(edge.target.as_str()).copied());
    let schedule_target_edge = (entry_kind == "scheduled-task")
        .then(|| first_matching_edge("schedules"))
        .flatten();
    let schedule_target =
        schedule_target_edge.and_then(|edge| nodes.get(edge.target.as_str()).copied());
    let expected_framework_target_type = if declaration
        .and_then(|item| item.get("adapter"))
        .and_then(Value::as_str)
        == Some("django")
    {
        "class"
    } else {
        "function"
    };
    let entry_evidence = if entry_kind == "http-request" {
        json!({"family":"http","binding":handler_evidence["binding"].clone(),"targetId":handler_evidence["handlerId"].clone(),"edge":handler_evidence["edge"].clone(),"siblingHandlerContamination":handler_evidence["siblingHandlerContamination"].clone(),"siblingHandlerIds":handler_evidence["siblingHandlerIds"].clone()})
    } else if entry_family == "command" {
        let exact_target = if entry_kind == "framework-command" {
            command_target.is_some_and(|node| {
                node.kind == "symbol" && node.node_type == expected_framework_target_type
            }) && command_target_edge
                .and_then(|edge| edge.confidence.as_ref())
                .is_some_and(|confidence| confidence == "exact")
        } else {
            command_target.is_some_and(|node| node.kind == "file")
                && command_target_edge
                    .and_then(|edge| edge.confidence.as_ref())
                    .is_some_and(|confidence| confidence == "exact")
        };
        json!({"family":"command","binding":if exact_target { if entry_kind == "framework-command" { "exact-framework-command-target" } else { "exact-literal-target" } } else if command_target.is_some() { "non-exact-target" } else { "missing-target" },"targetId":command_target.map(|node|node.id.clone()),"edge":command_target_edge.map(flow_edge_evidence),"siblingHandlerContamination":false,"siblingHandlerIds":[]})
    } else if entry_kind == "scheduled-task" {
        let exact_target = schedule_target
            .is_some_and(|node| node.kind == "symbol" && node.node_type == "function")
            && schedule_target_edge
                .and_then(|edge| edge.confidence.as_ref())
                .is_some_and(|confidence| confidence == "exact");
        json!({"family":"scheduler","binding":if exact_target { "exact-local-task" } else if schedule_target.is_some() { "non-exact-task" } else { "missing-task" },"targetId":schedule_target.map(|node|node.id.clone()),"edge":schedule_target_edge.map(flow_edge_evidence),"siblingHandlerContamination":false,"siblingHandlerIds":[]})
    } else {
        json!({"family":"unknown","binding":"unknown","targetId":null,"edge":null,"siblingHandlerContamination":false,"siblingHandlerIds":[]})
    };
    let adapter = declaration
        .and_then(|item| item.get("adapter"))
        .and_then(Value::as_str)
        .unwrap_or("framework");
    let mut limitations = vec![if entry_kind == "http-request" {
        "This is a bounded static technical projection from a detected HTTP/request entry. It is not a runtime trace, business process, control-flow proof, or timing sequence.".to_string()
    } else if entry_family == "command" && entry_kind == "framework-command" {
        format!("This is a bounded static technical projection from an exact {adapter} command declaration. It is not proof that the framework registered the command, initialized successfully, the command ran, a runtime trace, business process, control-flow proof, or timing sequence.")
    } else if entry_family == "command" {
        "This is a bounded static technical projection from a declared literal package script. It is not proof that a command ran, that its runner exists, a runtime trace, business process, control-flow proof, or timing sequence.".to_string()
    } else if entry_kind == "scheduled-task" {
        "This is a bounded static technical projection from a declared node-cron registration. It is not proof that scheduling initialized, a scheduled time occurred, a task ran, a runtime trace, business process, control-flow proof, or timing sequence.".to_string()
    } else {
        "This is a bounded static technical projection from a detected entry. It is not a runtime trace, business process, control-flow proof, or timing sequence.".to_string()
    }, "Step roles and static boundaries are derived from node type and parser evidence; they do not establish ownership, side-effect success, or external behavior.".to_string()];
    limitations.extend(
        entry["limitations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToString::to_string),
    );
    if display_truncated {
        limitations.push(format!("The lens displays the first {} of {} traversed steps; use raw dependencies to inspect omitted continuation.", steps.len(), source_steps.len()));
    }
    if source_traversal_may_be_truncated {
        limitations.push("The source traversal reached Flopeek's 24-step bound; further static continuation may be omitted.".to_string());
    }
    if !missing_transitions.is_empty() {
        limitations.push("Some displayed steps have no adjacent-depth parser edge in the retained traversal; they are shown as static members, not a proven transition.".to_string());
    }
    if entry_kind == "http-request" && !exact_handler {
        limitations.push("The endpoint could not be bound to one exact exported HTTP handler symbol, so this is a lower-confidence file-level fallback rather than handler-specific evidence.".to_string());
    }
    if entry_kind == "http-request"
        && handler_evidence["siblingHandlerContamination"] == Value::Bool(true)
    {
        limitations.push("Sibling HTTP handler symbols were retained in this traversal. Semantic confidence is reduced until the containment path is removed or inspected.".to_string());
    }
    if entry_kind == "package-script" && entry_evidence["binding"] != "exact-literal-target" {
        limitations.push("The literal package script could not be bound to one exact scanned target file, so the command projection has limited static evidence.".to_string());
    }
    if entry_kind == "framework-command"
        && entry_evidence["binding"] != "exact-framework-command-target"
    {
        limitations.push(format!("The {adapter} declaration could not be bound to one exact top-level {expected_framework_target_type}, so the framework command projection has limited static evidence."));
    }
    if entry_kind == "scheduled-task" && entry_evidence["binding"] != "exact-local-task" {
        limitations.push("The literal node-cron registration could not be bound to one exact local top-level task function, so the scheduler projection has limited static evidence.".to_string());
    }
    let exact_evidence = (entry_kind == "http-request"
        && exact_handler
        && handler_evidence["siblingHandlerContamination"] == Value::Bool(false))
        || (entry_kind == "package-script" && entry_evidence["binding"] == "exact-literal-target")
        || (entry_kind == "framework-command"
            && entry_evidence["binding"] == "exact-framework-command-target")
        || (entry_kind == "scheduled-task" && entry_evidence["binding"] == "exact-local-task");
    Ok(json!({
        "schemaVersion":"flopeek-flow-lens/v1",
        "id":format!("lens:{}@{version}", flow["id"].as_str().unwrap_or_default()),
        "project":{"projectId":project_id,"graphVersion":version,"sourceRevision":source_revision},
        "flow":{"id":flow["id"].clone(),"title":flow["title"].clone(),"entryId":flow["entryId"].clone(),"entry":entry,"contextRef":format!("fp://local/{}/flow/{}@{version}",encode_context_part(project_id),encode_context_part(flow["id"].as_str().unwrap_or_default())),"entryContextRef":format!("fp://local/{}/node/{}@{version}",encode_context_part(project_id),encode_context_part(entry_id))},
        "knowledgeClass":"derived",
        "confidence":if exact_evidence { "exact-static-evidence" } else { "limited-static-evidence" },
        "steps":steps,
        "staticBoundaries":static_boundaries,
        "truncation":truncation,
        "handlerEvidence":if entry_kind == "http-request" { handler_evidence } else { Value::Null },
        "entryEvidence":entry_evidence,
        "verification":Value::Null,
        "unresolvedQuestions":["No flow-level human verification record exists in this vertical slice."],
        "limitations":limitations,
        "safeActions":[{"id":"inspect-node","label":"Inspect a raw node Context Card","kind":"navigation"},{"id":"inspect-dependencies","label":"Inspect direct static dependencies","kind":"navigation"},{"id":"inspect-impact","label":"Inspect static change impact","kind":"recommendation"}],
    }))
}

fn native_flow_lens_core(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let flow_id = params
        .get("flowId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativeFlowLensCore requires params.flowId.".to_string(),
        })?;
    let max_steps = match params.get("maxSteps") {
        Some(value) => value.as_u64().ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-lens-max-steps",
            message: "maxSteps must be an integer from 1 through 24.".to_string(),
        })?,
        None => 12,
    };
    if !(1..=24).contains(&max_steps) {
        return Err(NativeProtocolError {
            code: "invalid-flow-lens-max-steps",
            message: "maxSteps must be an integer from 1 through 24.".to_string(),
        });
    }
    let flows = assemble_native_flows(params)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    native_flow_lens_from_assembled(batch, &flows, &projection, flow_id, max_steps)
}

fn native_context_relationship(
    edge: &crate::structural_graph::StructuralGraphEdge,
    direction: &str,
    node: &StructuralGraphNode,
) -> Value {
    json!({
        "direction": direction,
        "type": &edge.edge_type,
        "confidence": edge.confidence.clone().unwrap_or_else(|| json!("unknown")),
        "sourceId": &edge.source,
        "targetId": &edge.target,
        "node": native_member_summary(node),
        "evidence": edge.evidence.clone().unwrap_or(Value::Null),
    })
}

fn native_node_context_card(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let node_id = params
        .get("nodeId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativeNodeContextCard requires params.nodeId.".to_string(),
        })?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let nodes = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    let node = nodes
        .get(node_id)
        .copied()
        .ok_or_else(|| NativeProtocolError {
            code: "missing-node",
            message: "No native structural node matches params.nodeId.".to_string(),
        })?;
    let edge_order = structural_edge_traversal_order(batch, &projection);
    let mut incoming = projection
        .edges
        .iter()
        .filter(|edge| edge.target == node_id)
        .filter_map(|edge| {
            nodes
                .get(edge.source.as_str())
                .map(|related| (edge, *related))
        })
        .collect::<Vec<_>>();
    let mut outgoing = projection
        .edges
        .iter()
        .filter(|edge| edge.source == node_id)
        .filter_map(|edge| {
            nodes
                .get(edge.target.as_str())
                .map(|related| (edge, *related))
        })
        .collect::<Vec<_>>();
    let edge_rank = |edge: &crate::structural_graph::StructuralGraphEdge| {
        edge_order
            .get(&native_edge_key(edge))
            .copied()
            .unwrap_or(usize::MAX)
    };
    incoming.sort_by_key(|(edge, _)| edge_rank(edge));
    outgoing.sort_by_key(|(edge, _)| edge_rank(edge));
    let related_tests = incoming
        .iter()
        .chain(outgoing.iter())
        .filter(|(_, related)| related.node_type == "test")
        .map(|(edge, related)| {
            json!({
                "edge": native_context_relationship(edge, "related-test", related),
                "test": native_member_summary(related),
            })
        })
        .collect::<Vec<_>>();
    let flows = assemble_native_flows(params)?
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|flow| {
            flow["steps"]
                .as_array()
                .is_some_and(|steps| steps.iter().any(|step| step["id"] == node_id))
        })
        .map(|flow| {
            json!({
                "id": flow["id"].clone(),
                "title": flow["title"].clone(),
                "entryId": flow["entryId"].clone(),
                "knowledgeClass": "derived",
                "confidence": "exact",
            })
        })
        .collect::<Vec<_>>();
    let project_id = batch["projectId"].as_str().unwrap_or_default();
    let version = batch["flowContext"]["graphVersion"].as_u64().unwrap_or(0);
    let analysis = metadata(node, "analysis").and_then(Value::as_object);
    let confidence = analysis
        .and_then(|analysis| analysis.get("confidence"))
        .cloned()
        .unwrap_or_else(|| json!("unknown"));
    let parser = analysis
        .and_then(|analysis| analysis.get("parser"))
        .cloned()
        .unwrap_or_else(|| json!("unknown"));
    let status = analysis
        .and_then(|analysis| analysis.get("status"))
        .cloned()
        .unwrap_or_else(|| json!("unknown"));
    let manual_description =
        metadata_string(node, "manualDescription").filter(|value| !value.trim().is_empty());
    let mut limitations = vec![
        "This card summarizes static parser evidence. It is not a runtime trace, source diff, or business-intent claim.",
        "Relationships are limited to Flopeek's documented language and framework support.",
    ];
    if related_tests.is_empty() {
        limitations.push("No direct related test relationship was found; that does not prove behavioral coverage is absent.");
    }
    if manual_description.is_some() {
        limitations.push(
            "The local human description has no attributed verifier or lifecycle record yet.",
        );
    }
    let summary = native_member_summary(node);
    let detected_responsibility = metadata_string(node, "detectedResponsibility")
        .unwrap_or_else(|| "Technical responsibility is not available.".to_string());
    Ok(json!({
        "schemaVersion": "flopeek-context/v1",
        "contextRef": format!("fp://local/{}/node/{}@{version}", encode_context_part(project_id), encode_context_part(node_id)),
        "project": { "projectId": project_id, "graphVersion": version, "sourceRevision": batch["flowContext"]["sourceRevision"].clone() },
        "kind": "node",
        "title": node_label(node),
        "knowledgeClass": "extracted",
        "confidence": confidence.clone(),
        "node": summary,
        "responsibility": { "text": detected_responsibility, "knowledgeClass": "extracted", "confidence": confidence },
        "sourceEvidence": { "parser": parser, "status": status, "evidence": metadata(node, "evidence").cloned().unwrap_or(Value::Null) },
        "incoming": incoming.iter().take(24).map(|(edge, related)| native_context_relationship(edge, "incoming", related)).collect::<Vec<_>>(),
        "outgoing": outgoing.iter().take(24).map(|(edge, related)| native_context_relationship(edge, "outgoing", related)).collect::<Vec<_>>(),
        "relatedTests": related_tests.iter().take(20).cloned().collect::<Vec<_>>(),
        "relatedFlows": flows.iter().take(12).cloned().collect::<Vec<_>>(),
        "truncation": { "incoming": incoming.len() > 24, "outgoing": outgoing.len() > 24, "relatedTests": related_tests.len() > 20, "relatedFlows": flows.len() > 12 },
        "humanDescription": manual_description.map(|text| json!({ "text": text, "knowledgeClass": "human-authored", "authorship": { "status": "local-unattributed", "author": null, "graphVersion": version }, "verification": null })),
        "verification": Value::Null,
        "limitations": limitations,
        "unresolvedQuestions": [],
        "safeActions": [
            { "id": "inspect", "label": "Inspect raw parser evidence", "kind": "navigation" },
            { "id": "dependencies", "label": "Inspect direct dependencies", "kind": "navigation" },
            { "id": "tests", "label": "Inspect related tests", "kind": "navigation" },
            { "id": "impact", "label": "Inspect static change impact", "kind": "recommendation" },
        ],
    }))
}

fn native_flow_context_card(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let lens = native_flow_lens_core(params)?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let nodes = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut step_ids = lens["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|step| step["id"].as_str().map(ToString::to_string))
        .collect::<std::collections::BTreeSet<_>>();
    let file_ids_by_path = projection
        .nodes
        .iter()
        .filter(|node| node.kind == "file")
        .filter_map(|node| {
            node.path
                .as_ref()
                .map(|path| (path.as_str(), node.id.as_str()))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    for step in lens["steps"].as_array().into_iter().flatten() {
        if let Some(path) = step["node"]["path"].as_str() {
            if let Some(file_id) = file_ids_by_path.get(path) {
                step_ids.insert((*file_id).to_string());
            }
        }
    }
    let edge_order = structural_edge_traversal_order(batch, &projection);
    let mut edges = projection.edges.iter().collect::<Vec<_>>();
    edges.sort_by_key(|edge| {
        edge_order
            .get(&native_edge_key(edge))
            .copied()
            .unwrap_or(usize::MAX)
    });
    let mut tests = std::collections::BTreeMap::<String, Value>::new();
    for edge in edges {
        let source = nodes.get(edge.source.as_str()).copied();
        let target = nodes.get(edge.target.as_str()).copied();
        let test = source
            .filter(|node| node.node_type == "test" && step_ids.contains(&edge.target))
            .or_else(|| {
                target.filter(|node| node.node_type == "test" && step_ids.contains(&edge.source))
            });
        if let Some(test) = test {
            tests.entry(test.id.clone()).or_insert_with(|| {
                json!({
                    "test": native_member_summary(test),
                    "edge": flow_edge_evidence(edge),
                })
            });
        }
    }
    let tests = tests.into_values().collect::<Vec<_>>();
    let mut limitations = lens["limitations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    limitations.push("This card is a portable view of bounded static evidence. It does not retain source-file contents, credentials, runtime events, or business rationale.".to_string());
    limitations.push("Related tests are limited to direct stored relationships for the displayed Flow Lens steps.".to_string());
    if tests.is_empty() {
        limitations.push("No direct test relationship was found for the displayed steps; that does not prove behavioral coverage is absent.".to_string());
    }
    let entry_kind = lens["flow"]["entry"]["kind"]
        .as_str()
        .unwrap_or("unknown-static-entry");
    let entry_label = match entry_kind {
        "package-script" => "package-script",
        "framework-command" => "framework-command",
        "scheduled-task" => "scheduled-task",
        "http-request" => "HTTP/request",
        _ => "entry",
    };
    let displayed_steps = lens["steps"].as_array().map_or(0, Vec::len);
    let suffix = if displayed_steps == 1 { "" } else { "s" };
    let mut truncation = lens["truncation"].clone();
    truncation["relatedTests"] = Value::Bool(tests.len() > 20);
    Ok(json!({
        "schemaVersion": "flopeek-context/v1",
        "contextRef": lens["flow"]["contextRef"].clone(),
        "project": lens["project"].clone(),
        "kind": "flow",
        "title": lens["flow"]["title"].clone(),
        "knowledgeClass": "derived",
        "confidence": lens["confidence"].clone(),
        "flow": lens["flow"].clone(),
        "technicalSummary": {
            "text": format!("{} is a bounded static {entry_label} projection with {displayed_steps} displayed technical step{suffix}.", lens["flow"]["title"].as_str().unwrap_or_default()),
            "knowledgeClass": "derived",
            "confidence": lens["confidence"].clone(),
        },
        "projection": {
            "schemaVersion": lens["schemaVersion"].clone(),
            "id": lens["id"].clone(),
            "steps": lens["steps"].clone(),
            "staticBoundaries": lens["staticBoundaries"].clone(),
            "truncation": lens["truncation"].clone(),
        },
        "semanticSuggestion": Value::Null,
        "agentSemanticProposal": Value::Null,
        "semanticFeedback": Value::Null,
        "flowInterface": Value::Null,
        "relatedTests": tests.iter().take(20).cloned().collect::<Vec<_>>(),
        "truncation": truncation,
        "verification": Value::Null,
        "humanVerification": Value::Null,
        "limitations": limitations,
        "unresolvedQuestions": lens["unresolvedQuestions"].clone(),
        "safeActions": [
            { "id": "inspect-flow", "label": "Open the current Flow Lens", "kind": "navigation" },
            { "id": "inspect-step", "label": "Inspect a step Context Card", "kind": "navigation" },
            { "id": "compare-adjacent", "label": "Inspect a retained adjacent flow comparison", "kind": "navigation" },
            { "id": "inspect-impact", "label": "Inspect static change impact", "kind": "recommendation" },
        ],
    }))
}

struct ParsedNativeContextRef {
    project_id: String,
    kind: String,
    context_id: String,
    graph_version: u64,
}

fn decode_context_part(value: &str) -> Result<String, ()> {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(());
        }
        let high = (bytes[index + 1] as char).to_digit(16).ok_or(())?;
        let low = (bytes[index + 2] as char).to_digit(16).ok_or(())?;
        decoded.push(((high << 4) | low) as u8);
        index += 3;
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn parse_native_context_ref(value: &str) -> Result<ParsedNativeContextRef, NativeProtocolError> {
    if value.trim().is_empty() {
        return Err(NativeProtocolError {
            code: "invalid-context-ref",
            message: "Context Ref must be a non-empty string.".to_string(),
        });
    }
    let remainder = value
        .strip_prefix("fp://local/")
        .ok_or_else(|| NativeProtocolError {
            code: "unsupported-context-ref",
            message: "Context Ref must use the fp://local scheme.".to_string(),
        })?;
    let parts = remainder.split('/').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(NativeProtocolError {
            code: "invalid-context-ref",
            message: "Context Ref must contain project, kind, and context ID segments.".to_string(),
        });
    }
    let at = parts[2]
        .rfind('@')
        .filter(|index| *index > 0)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-context-ref",
            message: "Context Ref must include @graphVersion after its context ID.".to_string(),
        })?;
    let graph_version = parts[2][at + 1..]
        .parse::<u64>()
        .map_err(|_| NativeProtocolError {
            code: "invalid-graph-version",
            message: "Context Ref graphVersion must be a non-negative integer.".to_string(),
        })?;
    Ok(ParsedNativeContextRef {
        project_id: decode_context_part(parts[0]).map_err(|_| NativeProtocolError {
            code: "invalid-context-ref",
            message: "Context Ref contains invalid percent-encoding.".to_string(),
        })?,
        kind: decode_context_part(parts[1]).map_err(|_| NativeProtocolError {
            code: "invalid-context-ref",
            message: "Context Ref contains invalid percent-encoding.".to_string(),
        })?,
        context_id: decode_context_part(&parts[2][..at]).map_err(|_| NativeProtocolError {
            code: "invalid-context-ref",
            message: "Context Ref contains invalid percent-encoding.".to_string(),
        })?,
        graph_version,
    })
}

fn native_unresolved_context_ref(value: &str, reason: impl Into<String>, code: &str) -> Value {
    json!({
        "status": "unresolved",
        "requestedRef": value,
        "reason": reason.into(),
        "code": code,
        "card": Value::Null,
        "successorCandidates": [],
    })
}

fn native_public_delta_history(
    params: &Value,
    project_id: &str,
    from_version: u64,
    to_version: u64,
) -> Result<NativePublicDeltaHistory, NativeProtocolError> {
    let Some(root) = params
        .get("projectRoot")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok((None, None));
    };
    let connection = open_native_store(Path::new(root)).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let delta = complete_graph_delta_by_public_versions(
        &connection,
        project_id,
        from_version as i64,
        to_version as i64,
    )
    .map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let range = retained_public_delta_range(&connection, project_id).map_err(|error| {
        NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        }
    })?;
    Ok((delta, range))
}

fn native_expired_history_resolution(requested: &str, kind: &str, retained: (i64, i64)) -> Value {
    json!({
        "status": "expired",
        "requestedRef": requested,
        "resolvedRef": Value::Null,
        "card": Value::Null,
        "successorCandidates": [],
        "reason": format!("The requested {kind} Context Ref predates retained adjacent delta history and cannot be reconstructed."),
        "code": "history-pruned",
        "retention": { "oldestRetainedFrom": retained.0, "newestRetainedTo": retained.1 },
    })
}

fn native_successor_candidates(
    projection: &StructuralGraphProjection,
    removed: &Value,
    delta: &Value,
) -> Vec<Value> {
    let added = delta["nodes"]["added"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| node["id"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    projection
        .nodes
        .iter()
        .filter(|node| {
            added.contains(node.id.as_str())
                && node.path.as_deref() == removed["path"].as_str()
                && node.kind == removed["kind"].as_str().unwrap_or_default()
                && node.node_type == removed["type"].as_str().unwrap_or_default()
        })
        .map(|node| {
            json!({
                "node": native_member_summary(node),
                "confidence": "likely-static",
                "reason": "The node was added in the same adjacent delta with the same source path, kind, and type.",
            })
        })
        .collect()
}

fn resolve_native_context_ref(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let requested = params
        .get("contextRef")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "resolveNativeContextRef requires params.contextRef.".to_string(),
        })?;
    let parsed = match parse_native_context_ref(requested) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(native_unresolved_context_ref(
                requested,
                error.message,
                error.code,
            ));
        }
    };
    let project_id = batch["projectId"].as_str().unwrap_or_default();
    let current_version = batch["flowContext"]["graphVersion"]
        .as_u64()
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-context",
            message:
                "StructuralFactBatch/v1 flowContext.graphVersion must be a non-negative integer."
                    .to_string(),
        })?;
    if parsed.project_id != project_id {
        return Ok(native_unresolved_context_ref(
            requested,
            "Context Ref belongs to a different Flopeek project.",
            "wrong-project-id",
        ));
    }
    if !matches!(parsed.kind.as_str(), "node" | "flow") {
        return Ok(native_unresolved_context_ref(
            requested,
            format!("Context kind '{}' is not implemented.", parsed.kind),
            "unsupported-context-kind",
        ));
    }
    if parsed.graph_version > current_version {
        return Ok(native_unresolved_context_ref(
            requested,
            "Context Ref targets a graph version newer than the local graph.",
            "future-graph-version",
        ));
    }
    let mut card_params = params.clone();
    if let Some(object) = card_params.as_object_mut() {
        object.insert(
            if parsed.kind == "node" {
                "nodeId"
            } else {
                "flowId"
            }
            .to_string(),
            Value::String(parsed.context_id.clone()),
        );
    }
    let card = if parsed.kind == "node" {
        native_node_context_card(&card_params)
    } else {
        native_flow_context_card(&card_params)
    };
    let card = match card {
        Ok(card) => card,
        Err(error) if error.code == "missing-node" || error.code == "missing-flow" => {
            let (_, retained) = native_public_delta_history(
                params,
                project_id,
                parsed.graph_version,
                parsed.graph_version.saturating_add(1),
            )?;
            if retained.is_some_and(|range| parsed.graph_version < range.0 as u64) {
                return Ok(native_expired_history_resolution(
                    requested,
                    &parsed.kind,
                    retained.unwrap(),
                ));
            }
            let (delta, _) = native_public_delta_history(
                params,
                project_id,
                parsed.graph_version,
                parsed.graph_version.saturating_add(1),
            )?;
            let Some(delta) = delta else {
                let code = if parsed.kind == "node" {
                    "node-not-found"
                } else {
                    "flow-not-found"
                };
                return Ok(native_unresolved_context_ref(
                    requested,
                    format!(
                        "The {} is not present and no retained adjacent delta can establish its history.",
                        parsed.kind
                    ),
                    code,
                ));
            };
            if parsed.kind == "node" {
                let removed = delta["nodes"]["removed"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|node| node["id"] == parsed.context_id)
                    .cloned();
                let Some(removed) = removed else {
                    return Ok(native_unresolved_context_ref(
                        requested,
                        "The node is not present and no retained adjacent delta can establish its history.",
                        "node-not-found",
                    ));
                };
                let projection =
                    build_structural_graph(batch).map_err(|message| NativeProtocolError {
                        code: "structural-graph-failed",
                        message,
                    })?;
                let candidates = native_successor_candidates(&projection, &removed, &delta);
                if !candidates.is_empty() {
                    return Ok(json!({
                        "status": "successor-candidate",
                        "requestedRef": requested,
                        "resolvedRef": Value::Null,
                        "card": Value::Null,
                        "successorCandidates": candidates,
                        "delta": delta,
                        "reason": "The original node is absent. Candidate successors require human confirmation and are not automatically resolved.",
                    }));
                }
                return Ok(json!({
                    "status": "historical",
                    "requestedRef": requested,
                    "resolvedRef": Value::Null,
                    "card": Value::Null,
                    "successorCandidates": [],
                    "delta": delta,
                    "historicalNode": removed,
                    "reason": "The node was removed in a retained adjacent delta. Its original full card is not retained.",
                }));
            }
            let removed = delta["flows"]["removed"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|flow| flow["id"] == parsed.context_id)
                .cloned();
            let comparison = delta["flowComparisons"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|item| item["flow"]["id"] == parsed.context_id)
                .cloned();
            if removed.is_some()
                || comparison
                    .as_ref()
                    .is_some_and(|item| !item["before"].is_null() && item["current"].is_null())
            {
                return Ok(json!({
                    "status": "historical",
                    "requestedRef": requested,
                    "resolvedRef": Value::Null,
                    "card": Value::Null,
                    "successorCandidates": [],
                    "delta": delta,
                    "historicalFlow": removed.or_else(|| comparison.as_ref().map(|item| item["flow"].clone())),
                    "historicalFlowLensSnapshot": comparison.as_ref().map(|item| item["before"].clone()).unwrap_or(Value::Null),
                    "reason": "The flow was removed in a retained adjacent delta. Its bounded Flow Lens snapshot is returned when captured; a full historical Context Card is not reconstructed.",
                }));
            }
            return Ok(native_unresolved_context_ref(
                requested,
                "The flow is not present and no retained adjacent delta can establish its history.",
                "flow-not-found",
            ));
        }
        Err(error) => return Err(error),
    };
    let resolved_ref = card["contextRef"].clone();
    if parsed.graph_version == current_version {
        return Ok(json!({
            "status": "current",
            "requestedRef": requested,
            "resolvedRef": resolved_ref,
            "card": card,
            "successorCandidates": [],
        }));
    }
    let delta = if parsed.graph_version.saturating_add(1) == current_version {
        native_public_delta_history(params, project_id, parsed.graph_version, current_version)?.0
    } else {
        None
    };
    let mut result = json!({
        "status": "stale",
        "requestedRef": requested,
        "resolvedRef": resolved_ref,
        "card": card,
        "successorCandidates": [],
        "reason": format!("The {} still exists, but the requested graph version is older than the current graph.", parsed.kind),
    });
    if let Some(object) = result.as_object_mut() {
        if let Some(delta) = delta {
            object.insert("delta".to_string(), delta);
        }
    }
    Ok(result)
}

fn get_related_tests(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let node_id = params
        .get("nodeId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getRelatedTests requires params.nodeId.".to_string(),
        })?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let node_by_id = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    let Some(node) = node_by_id.get(node_id) else {
        return Ok(Value::Null);
    };
    let related_tests = projection
        .edges
        .iter()
        .filter_map(|edge| {
            let related_id = if edge.source == node_id {
                &edge.target
            } else if edge.target == node_id {
                &edge.source
            } else {
                return None;
            };
            let related = node_by_id.get(related_id.as_str())?;
            (related.node_type == "test").then(|| {
                json!({
                    "edge": {
                        "type": &edge.edge_type,
                        "confidence": &edge.confidence,
                        "evidence": &edge.evidence,
                    },
                    "test": native_member_summary(related),
                })
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "id": node_id,
        "node": native_member_summary(node),
        "relatedTests": related_tests,
        "limitation": "Only direct parser relationships to test files are reported. Absence does not prove that no behavioral test exists.",
    }))
}

fn query_changed_paths(params: &Value) -> Vec<String> {
    let values = match params.get("changedPaths") {
        Some(Value::Array(values)) => values.clone(),
        Some(value) => vec![value.clone()],
        None => Vec::new(),
    };
    let mut paths = Vec::new();
    for value in values {
        let Some(value) = value.as_str() else {
            continue;
        };
        let path = value.trim().replace('\\', "/");
        let path = path.trim_start_matches("./");
        if path.is_empty() || path == "." || path.split('/').any(|segment| segment == "..") {
            continue;
        }
        if !paths.contains(&path.to_string()) {
            paths.push(path.to_string());
        }
    }
    paths
}

fn query_max_depth(params: &Value) -> usize {
    params
        .get("maxDepth")
        .and_then(Value::as_u64)
        .unwrap_or(6)
        .min(12) as usize
}

fn native_agent_bootstrap(
    session: &NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    // Persistent CoreClient queries carry a verified project handle. Prefer
    // its current native snapshot over reconstructing a pending projection
    // from the fact batch: the cached snapshot contains the committed public
    // lifecycle status and version exposed to the caller.
    let graph = params
        .get("projectId")
        .and_then(Value::as_str)
        .and_then(|project_id| {
            session
                .persistent_graph
                .as_ref()
                .filter(|cached| cached.project_id == project_id)
                .and_then(|cached| cached.public_snapshot.clone())
        })
        .map(Ok)
        .unwrap_or_else(|| {
            let batch = structural_batch(params)?;
            submit_structural_facts(batch)?;
            let payload = assemble_native_public_payload(batch)?;
            native_public_graph_snapshot(&payload)
        })?;
    let declared_scan_outcome = params
        .get("scanOutcome")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            graph
                .pointer("/analysis/scanOutcome")
                .filter(|value| !value.is_null())
                .cloned()
        });
    let has_scan_outcome = declared_scan_outcome.is_some();
    let scan_outcome = declared_scan_outcome
        .unwrap_or_else(|| json!({
            "status": "unavailable",
            "reason": "This graph was not produced through a surface that exposes the shared scan-outcome contract.",
        }));
    let coverage = graph
        .pointer("/analysis/coverage")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let coverage_summary = coverage.get("summary").cloned().unwrap_or(Value::Null);
    let inventory_only = coverage_summary
        .get("inventoryOnlyFiles")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let parse_failed = coverage_summary
        .get("parseFailedFiles")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let flow_count = graph
        .get("flows")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let package_selection = graph
        .pointer("/analysis/packageSelection")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| scan_outcome.pointer("/discovery/selection").cloned())
        .unwrap_or(Value::Null);
    let cache_state = graph.pointer("/analysis/cacheState");
    let project = graph.get("project").cloned().unwrap_or_else(|| json!({}));
    let supplied_project = params.get("project").cloned().unwrap_or_else(|| json!({}));
    let branch = supplied_project
        .get("branch")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| {
            project
                .pointer("/git/branch")
                .cloned()
                .unwrap_or(Value::Null)
        });
    let revision = supplied_project
        .get("revision")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| {
            project
                .pointer("/git/revision")
                .cloned()
                .or_else(|| graph.pointer("/state/sourceRevision").cloned())
                .unwrap_or(Value::Null)
        });
    let scan_is_available = scan_outcome
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "complete")
        && scan_outcome
            .pointer("/activeGraph/freshness")
            .and_then(Value::as_str)
            .is_some_and(|freshness| freshness == "current");
    let attached_head_matched = scan_outcome
        .pointer("/activeGraph/attachedHeadFreshness/status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "matched");
    Ok(json!({
        "schemaVersion": "flopeek-agent-bootstrap/v1",
        "project": {
            "projectId": project["projectId"].clone(),
            "name": project["name"].clone(),
            "branch": branch,
            "revision": revision,
        },
        "graph": {
            "schemaVersion": graph["schemaVersion"].clone(),
            "graphVersion": graph.pointer("/state/graphVersion").cloned().unwrap_or(Value::Null),
            "status": graph.pointer("/state/status").cloned().unwrap_or_else(|| json!("unknown")),
            "updatedAt": graph.pointer("/state/updatedAt").cloned().or_else(|| graph.get("generatedAt").cloned()).unwrap_or(Value::Null),
            "inventory": {
                "nodes": graph.get("nodes").and_then(Value::as_array).map_or(0, Vec::len),
                "edges": graph.get("edges").and_then(Value::as_array).map_or(0, Vec::len),
                "applicationFlows": flow_count,
                "endpoints": graph.pointer("/stats/endpoints").cloned().unwrap_or_else(|| json!(0)),
                "commandEntries": graph.pointer("/stats/commandEntries").cloned().unwrap_or_else(|| json!(0)),
                "scheduledEntries": graph.pointer("/stats/scheduledEntries").cloned().unwrap_or_else(|| json!(0)),
                "services": graph.pointer("/stats/services").cloned().unwrap_or_else(|| json!(0)),
                "tests": graph.pointer("/stats/tests").cloned().unwrap_or_else(|| json!(0)),
            },
            "cache": {
                "status": cache_state.and_then(|value| value.get("status")).cloned().unwrap_or_else(|| json!("unknown")),
                "diagnostics": cache_state.and_then(|value| value.get("diagnostics")).cloned().unwrap_or_else(|| json!([])),
            },
            "packageSelection": package_selection,
        },
        "readiness": {
            "graphAvailable": graph.get("nodes").is_some() && graph.get("edges").is_some(),
            "applicationFlowsAvailable": flow_count > 0,
            "sourceFallbackRequired": flow_count == 0 || inventory_only > 0 || parse_failed > 0,
            "currentSourceVerified": if has_scan_outcome { json!(scan_is_available) } else { Value::Null },
            "attachedHeadVerified": if has_scan_outcome { json!(attached_head_matched) } else { Value::Null },
        },
        "scan": scan_outcome,
        "coverage": {
            "summary": coverage_summary,
            "files": coverage.get("files").cloned().unwrap_or(Value::Null),
            "languages": coverage.get("languages").cloned().or_else(|| coverage.get("byLanguage").cloned()).unwrap_or_else(|| json!([])),
            "diagnostics": coverage.get("diagnostics").cloned().unwrap_or_else(|| json!([])),
            "interpretation": "Coverage describes deterministic parser handling for this repository. It is not runtime coverage, behavioral coverage, or a recall guarantee.",
        },
        "workflow": [
            {"step":1,"action":"Orient","tools":["get_scan_status","get_agent_context","get_project_overview"],"purpose":"Read scan freshness, graph identity, parser coverage, and interpretation limits before making claims."},
            {"step":2,"action":"Focus","tools":["get_handoff_context","find_nodes","get_entry_flows"],"purpose":"Retrieve a bounded task-relevant context instead of reading the entire repository."},
            {"step":3,"action":"Inspect evidence","tools":["get_node","get_flow_projection","get_flow_context_card","get_related_tests"],"purpose":"Resolve parser facts and Context Refs before planning a source change."},
            {"step":4,"action":"Continue safely when a checkpoint exists","tools":["get_continuation_context","get_work_dependency_status"],"purpose":"Resolve exact checkpoint context and declared dependency readiness before built-in implementation entry. Ready is local delivery metadata, not source or runtime proof."},
            {"step":5,"action":"Inspect bounded Git evidence only when needed","tools":["get_active_branch_git_evidence","get_git_context_continuity"],"purpose":"Read local path-touch commits or compare one Context Ref across two static Git snapshots. Neither result proves original rationale, runtime behavior, review, test success, release state, rename, or implementation equivalence."},
            {"step":6,"action":"Edit outside Flopeek","tools":[],"purpose":"Use the host agent's normal workspace tools. Flopeek exposes no repository-source write or arbitrary shell tool."},
            {"step":7,"action":"Refresh","tools":["refresh_graph","get_scan_status","get_changed_contexts","get_flow_comparison","get_change_impact"],"purpose":"Advance the graph, confirm source freshness, and inspect bounded before/current static evidence after source edits."},
            {"step":8,"action":"Verify outside Flopeek","tools":["get_related_tests","record_agent_evidence_trace"],"purpose":"Run repository-owned verification with approved host tools, then record only bounded declared evidence metadata."}
        ],
        "policy": {"strategy":"graph-first-with-source-fallback","parserFactsAuthority":"flopeek-deterministic-scanner","agentRole":"consumer-and-proposer","sourceWrites":"not-exposed","targetExecution":"not-exposed","staticIsRuntimeTruth":false,"staticIsBusinessTruth":false,"missingEvidenceMeansMissingBehavior":false,"agentProposalCreatesParserFact":false,"agentProposalCreatesHumanVerification":false},
        "limitations": [
            "Static relationships do not prove runtime order, dynamic dispatch, successful side effects, or business intent.",
            "Inventory-only and unsupported constructs require direct source inspection and, where relevant, runtime or test evidence.",
            "Context Refs must be resolved again after a graph refresh; stale evidence must not be silently reused.",
            if package_selection.get("status").and_then(Value::as_str) == Some("selected") { "This graph covers only the selected static package subtree. It does not prove workspace topology, dependency ownership, build activation, or runtime behavior outside that subtree." } else { "This graph covers the configured repository-wide static scope; it does not prove runtime topology or behavior." },
            "Do not store source bodies, secrets, prompts, private reasoning, or raw command logs in Flopeek metadata."
        ]
    }))
}

fn native_agent_entry_reason_counts(entries: Option<&Vec<Value>>) -> Value {
    let mut counts = BTreeMap::<String, usize>::new();
    for entry in entries.into_iter().flatten() {
        if let Some(reason) = entry.get("reason").and_then(Value::as_str) {
            *counts.entry(reason.to_string()).or_default() += 1;
        }
    }
    json!(counts)
}

fn native_agent_entry_inventory(graph: &Value) -> Value {
    let Some(inventory) = graph
        .pointer("/analysis/entryPoints")
        .and_then(Value::as_object)
    else {
        return Value::Null;
    };
    let supported = inventory.get("supported").and_then(Value::as_object);
    let unsupported = inventory.get("unsupported").and_then(Value::as_object);
    let selected = |key: &str, fields: &[&str]| {
        supported
            .and_then(|supported| supported.get(key))
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| {
                        let mut item = serde_json::Map::new();
                        for field in fields {
                            item.insert(
                                (*field).to_string(),
                                entry.get(*field).cloned().unwrap_or(Value::Null),
                            );
                        }
                        Value::Object(item)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    json!({
        "schemaVersion": inventory.get("schemaVersion").cloned().unwrap_or(Value::Null),
        "supported": {
            "packageScripts": selected("packageScripts", &["id", "manifest", "scriptName", "runner", "targetPath", "targetId"]),
            "djangoManagementCommands": selected("djangoManagementCommands", &["id", "path", "commandName", "targetPath", "targetId"]),
            "nodeCronSchedules": selected("nodeCronSchedules", &["id", "path", "expression", "taskName", "targetPath", "targetId"]),
        },
        "unsupported": {
            "packageScriptReasonCounts": native_agent_entry_reason_counts(unsupported.and_then(|items| items.get("packageScripts")).and_then(Value::as_array)),
            "djangoManagementCommandReasonCounts": native_agent_entry_reason_counts(unsupported.and_then(|items| items.get("djangoManagementCommands")).and_then(Value::as_array)),
            "nodeCronScheduleReasonCounts": native_agent_entry_reason_counts(unsupported.and_then(|items| items.get("nodeCronSchedules")).and_then(Value::as_array)),
        },
        "limitations": inventory.get("limitations").cloned().unwrap_or_else(|| json!([])),
    })
}

fn native_agent_context_core(
    graph: &Value,
    projection: &Value,
    mode: &str,
    scope: &str,
    focus: Option<&str>,
) -> Value {
    let level = projection
        .pointer("/hierarchy/level")
        .and_then(Value::as_str)
        .unwrap_or(if mode == "dependencies" {
            "symbol"
        } else {
            "feature"
        });
    let meaning = match mode {
        "overview" => {
            "Each visible node is a feature summary that aggregates source nodes. It is not a source file, runtime service, or execution step."
        }
        "requests" => {
            "Each visible node is a feature summary. Edges aggregate supported static entry, HTTP handler, static fetch, import, or usage facts; they do not prove command invocation or end-to-end runtime execution."
        }
        _ => {
            "Each visible node is an original graph node. Edges are direct parser facts for the selected node's neighborhood."
        }
    };
    json!({
        "schemaVersion": "flopeek-agent-context/v1",
        "mode": mode,
        "scope": scope,
        "level": level,
        "focusId": focus,
        "projection": {
            "meaning": meaning,
            "visibleNodes": projection.get("nodes").and_then(Value::as_array).map_or(0, Vec::len),
            "visibleEdges": projection.get("edges").and_then(Value::as_array).map_or(0, Vec::len),
            "sourceNodesRepresented": projection.get("sourceNodeCount").cloned().unwrap_or_else(|| json!(0)),
            "aggregation": mode != "dependencies",
        },
        "evidencePolicy": {
            "codeInterpretation": graph.pointer("/analysis/codeInterpretation").cloned().unwrap_or(Value::Null),
            "unparsedPolicy": graph.pointer("/analysis/unparsedPolicy").cloned().unwrap_or(Value::Null),
            "rawFacts": "Raw AST relationships use their stored parser, source range, and confidence. Aggregate feature edges are labelled derived.",
        },
        "interpretationRules": [
            "Do not treat a feature summary as a source file, service boundary, or runtime call trace.",
            "Do not infer business intent or runtime order from import relationships.",
            "Use get_entry_flows followed by get_flow_projection for a bounded static explanation of a supported HTTP/request, command, or scheduler entry; inspect a step Context Card before changing code.",
            "Use get_flow_context_card to copy or hand off one versioned bounded flow context; resolve its Context Ref before reusing it after a graph refresh.",
            "Flow Lens roles, boundaries, branches, and truncation are derived static metadata, not runtime control flow or side-effect proof.",
            "Semantic flow suggestions are deterministic derived candidates with evidence and abstention; they never constitute or create human verification.",
            "Semantic suggestion feedback is immutable local human labeling. It can accept, edit, reject, or confirm abstention, but it never creates human verification or model-quality proof by itself.",
            "Use record_agent_evidence_trace after an agent action to append its Context Ref, declared action, changed paths, and verification result. This is audit metadata, not private reasoning or human verification.",
            "After refresh_graph advances the graph version, use get_changed_contexts with the adjacent versions before relying on an earlier Flow Lens or Context Card. Its affected statuses are bounded static delta evidence; historical items do not reconstruct a full Context Card.",
            "Use get_flow_comparison only for a flow captured in the retained adjacent delta. Its before/current sides are bounded static snapshots, not reconstructed runtime history.",
            "Use a raw node tool before proposing a code change.",
            "Files marked inventory-only have no inferred dependencies or flows.",
        ],
        "adapterCapabilities": graph.pointer("/analysis/adapterCapabilities").cloned().unwrap_or(Value::Null),
        "capabilities": graph.pointer("/analysis/capabilities").cloned().unwrap_or(Value::Null),
        "calls": graph.pointer("/analysis/calls").cloned().unwrap_or(Value::Null),
        "resolution": graph.pointer("/analysis/resolution").cloned().unwrap_or(Value::Null),
        "coverage": graph.pointer("/analysis/coverage").cloned().unwrap_or(Value::Null),
        "entryPoints": native_agent_entry_inventory(graph),
        "repositoryScope": graph.pointer("/analysis/repositoryScope").cloned().unwrap_or(Value::Null),
        "packageSelection": graph.pointer("/analysis/packageSelection").filter(|value| !value.is_null()).cloned().or_else(|| graph.pointer("/analysis/scanOutcome/discovery/selection").cloned()).unwrap_or(Value::Null),
        "project": graph.get("project").cloned().unwrap_or(Value::Null),
        "graphState": graph.get("state").cloned().unwrap_or(Value::Null),
        "latestDelta": graph.pointer("/analysis/latestDelta").cloned().unwrap_or(Value::Null),
        "cache": graph.pointer("/analysis/cache").cloned().unwrap_or(Value::Null),
        "cacheState": graph.pointer("/analysis/cacheState").cloned().unwrap_or(Value::Null),
        "durableBriefs": {"schemaVersion":"flopeek-brief/v1","kinds":["project","feature","flow","node"],"evidenceClasses":["static-parser-fact","deterministic-inference","human-authored","human-verified","runtime-evidence"],"derivedEvidenceCeiling":"deterministic-inference","freshnessFields":["projectIdentity","sourceBasis","graphVersion","evidenceClass","freshnessStatus"],"compositionSurface":"get_handoff_context"},
        "handoffWorkspace": {"schemaVersion":"flopeek-handoff-workspace/v1","compositionSurface":"get_handoff_context","localVersioning":"immutable-supersession","humanNotes":"append-only-attributed-supersession","portableFormats":["json","markdown"],"foreignImport":{"access":"read-only","trust":"foreign-unverified","automaticAdoption":false}},
        "trustAnalytics": {"schemaVersion":"flopeek-trust-analytics/v1","httpEndpoint":"/api/trust-analytics","mcpTool":"get_trust_analytics","purpose":"Inspect evidence availability, provenance, and freshness without collapsing unlike evidence classes into a truth score.","compositeScore":false},
        "productProof": {"schemaVersion":"flopeek-product-proof/v1","httpEndpoint":"/api/product-proof","mcpTool":"get_product_proof","purpose":"Inspect bounded public benchmark evidence, current-repository facts, feature proof surfaces, reproduction commands, and claim boundaries."},
    })
}

const NATIVE_VIEW_PROJECTION_SCHEMA: &str = "flopeek-native-view-projection-core/v1";

fn native_view_graph(
    session: &NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    params
        .get("projectId")
        .and_then(Value::as_str)
        .and_then(|project_id| {
            session
                .persistent_graph
                .as_ref()
                .filter(|cached| cached.project_id == project_id)
                .and_then(|cached| cached.public_snapshot.clone())
        })
        .map(Ok)
        .unwrap_or_else(|| {
            let batch = structural_batch(params)?;
            submit_structural_facts(batch)?;
            native_public_graph_snapshot(&assemble_native_public_payload(batch)?)
        })
}

fn native_view_option<'a>(params: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

fn native_scope_visible(node: &Value, scope: &str) -> bool {
    let layer = node
        .get("layer")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match scope {
        "all" => matches!(
            layer,
            "application"
                | "runtime"
                | "framework"
                | "devtool"
                | "package"
                | "test"
                | "fixture"
                | "generated"
        ),
        "runtime" => matches!(layer, "application" | "runtime"),
        "framework" => matches!(layer, "application" | "framework"),
        "devtool" => matches!(layer, "application" | "devtool"),
        _ => layer == "application",
    }
}

fn native_capitalise(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), characters.as_str()),
        None => String::new(),
    }
}

fn native_humanize_segment(value: &str) -> String {
    if value == "api" {
        return "API".to_string();
    }
    value
        .split('-')
        .map(native_capitalise)
        .collect::<Vec<_>>()
        .join(" ")
}

fn native_feature_key(node: &Value) -> String {
    if let Some(feature) = node.get("feature").and_then(Value::as_str) {
        return feature.to_string();
    }
    if node.get("kind").and_then(Value::as_str) == Some("external") {
        return format!(
            "{}/{}",
            value_string(node, "layer"),
            value_string(node, "label").to_lowercase()
        );
    }
    value_string(node, "domain").if_empty("project")
}

trait NativeStringFallback {
    fn if_empty(self, fallback: &str) -> String;
}
impl NativeStringFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn native_domain_key(node: &Value) -> String {
    value_string(node, "domain").if_empty("project")
}

fn native_component_key(node: &Value) -> String {
    let path = value_string(node, "path");
    if path.is_empty() {
        return value_string(node, "type").if_empty("external");
    }
    let mut segments = path.split('/').collect::<Vec<_>>();
    segments.pop();
    if segments.is_empty() {
        "root".to_string()
    } else {
        segments.join("/")
    }
}

fn native_feature_label(key: &str) -> String {
    match key {
        "overview/http-api" => "HTTP API".to_string(),
        "overview/ui" => "UI Components".to_string(),
        "overview/pages" => "Application Pages".to_string(),
        "overview/library" => "Shared Library".to_string(),
        "overview/data" => "Data Layer".to_string(),
        "overview/server-actions" => "Server Actions".to_string(),
        "overview/hooks" => "Hooks".to_string(),
        "overview/types" => "Types".to_string(),
        "overview/project" => "Application Core".to_string(),
        _ => key
            .split('/')
            .map(native_humanize_segment)
            .collect::<Vec<_>>()
            .join(" · "),
    }
}

fn native_uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn native_hierarchy_id(level: &str, parts: &[String]) -> String {
    format!(
        "{level}:{}",
        parts
            .iter()
            .map(|part| native_uri_component(part))
            .collect::<Vec<_>>()
            .join(":")
    )
}

fn native_hierarchy_parts(key: &str) -> Vec<String> {
    key.split('\0').map(ToString::to_string).collect()
}

fn native_semantic_label(level: &str, key: &str) -> String {
    let parts = native_hierarchy_parts(key);
    match level {
        "domain" => native_humanize_segment(key),
        "feature" => native_feature_label(
            parts
                .get(1)
                .unwrap_or(parts.first().unwrap_or(&String::new())),
        ),
        _ => {
            let component = parts.get(2).map(String::as_str).unwrap_or("root");
            format!(
                "{} / {}",
                native_feature_label(parts.get(1).map(String::as_str).unwrap_or_default()),
                component
                    .split('/')
                    .map(native_humanize_segment)
                    .collect::<Vec<_>>()
                    .join(" / ")
            )
        }
    }
}

fn native_parent_hierarchy_id(level: &str, key: &str) -> Value {
    let parts = native_hierarchy_parts(key);
    match level {
        "feature" => json!(native_hierarchy_id(
            "domain",
            &[parts.first().cloned().unwrap_or_default()]
        )),
        "component" => json!(native_hierarchy_id(
            "feature",
            &[
                parts.first().cloned().unwrap_or_default(),
                parts.get(1).cloned().unwrap_or_default()
            ]
        )),
        _ => Value::Null,
    }
}

fn native_decode_component(value: &str) -> String {
    let mut bytes = Vec::new();
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' && index + 2 < input.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                bytes.push(byte);
                index += 3;
                continue;
            }
        }
        bytes.push(input[index]);
        index += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_string())
}

fn native_focus_matches(node: &Value, focus: Option<&str>) -> bool {
    let Some(focus) = focus.filter(|value| !value.is_empty()) else {
        return true;
    };
    let parts = focus.split(':').collect::<Vec<_>>();
    if parts.len() > 1 {
        let decoded = parts[1..]
            .iter()
            .map(|part| native_decode_component(part))
            .collect::<Vec<_>>();
        match parts[0] {
            "domain" => {
                return native_domain_key(node) == decoded.first().cloned().unwrap_or_default();
            }
            "feature" => {
                return native_domain_key(node) == decoded.first().cloned().unwrap_or_default()
                    && native_feature_key(node) == decoded.get(1).cloned().unwrap_or_default();
            }
            "component" => {
                return native_domain_key(node) == decoded.first().cloned().unwrap_or_default()
                    && native_feature_key(node) == decoded.get(1).cloned().unwrap_or_default()
                    && native_component_key(node) == decoded.get(2).cloned().unwrap_or_default();
            }
            _ => {}
        }
    }
    if let Some(id) = focus.strip_prefix("domain:") {
        return native_domain_key(node) == id;
    }
    if let Some(id) = focus.strip_prefix("feature:") {
        return native_feature_key(node) == id;
    }
    if let Some(id) = focus.strip_prefix("component:") {
        return native_component_key(node) == id;
    }
    value_string(node, "id") == focus
}

fn native_supported_flow_entry(node: &Value) -> bool {
    let kind = node.get("kind").and_then(Value::as_str);
    let entry = node.get("entryKind").and_then(Value::as_str);
    kind == Some("endpoint")
        || (kind == Some("command")
            && matches!(
                entry,
                Some("package-script" | "django-management-command" | "framework-command")
            ))
        || (kind == Some("schedule") && entry == Some("node-cron-schedule"))
}

// Match entrySourceNodes(): expand declared entry links, then apply its single
// ordered parser-fact pass. Earlier edges can admit a source for a later edge,
// but this remains static selection rather than a runtime execution model.
fn native_entry_source_nodes(graph: &Value, visible: &[Value]) -> Vec<Value> {
    let visible_ids = visible
        .iter()
        .map(|node| value_string(node, "id"))
        .collect::<BTreeSet<_>>();
    let mut included = visible
        .iter()
        .filter(|node| {
            node.get("type").and_then(Value::as_str) != Some("test")
                && native_supported_flow_entry(node)
        })
        .map(|node| value_string(node, "id"))
        .collect::<BTreeSet<_>>();
    let edges = graph
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for edge in &edges {
        let source = value_string(edge, "source");
        let target = value_string(edge, "target");
        let edge_type = value_string(edge, "type");
        if (matches!(
            edge_type.as_str(),
            "handles" | "declares-command-target" | "schedules"
        ) && included.contains(&source)
            && visible_ids.contains(&target))
            || (edge_type == "requests"
                && included.contains(&target)
                && visible_ids.contains(&source))
        {
            included.insert(if edge_type == "requests" {
                source
            } else {
                target
            });
        }
    }
    for edge in &edges {
        let source = value_string(edge, "source");
        let target = value_string(edge, "target");
        if included.contains(&source)
            && matches!(
                value_string(edge, "type").as_str(),
                "imports" | "uses" | "contains" | "calls"
            )
            && visible_ids.contains(&target)
        {
            included.insert(target);
        }
    }
    visible
        .iter()
        .filter(|node| included.contains(&value_string(node, "id")))
        .cloned()
        .collect()
}

fn native_summary_type(members: &[Value], key: &str) -> String {
    if members
        .iter()
        .any(|node| node.get("kind").and_then(Value::as_str) == Some("endpoint"))
    {
        return "endpoint".to_string();
    }
    if members
        .iter()
        .any(|node| node.get("kind").and_then(Value::as_str) == Some("command"))
    {
        return "command".to_string();
    }
    if key.starts_with("data") {
        return "database".to_string();
    }
    if key.starts_with("runtime") {
        return "external".to_string();
    }
    if members
        .iter()
        .any(|node| node.get("type").and_then(Value::as_str) == Some("service"))
    {
        return "service".to_string();
    }
    if members
        .iter()
        .any(|node| node.get("type").and_then(Value::as_str) == Some("repository"))
    {
        return "repository".to_string();
    }
    "feature".to_string()
}

fn native_aggregate_projection(
    graph: &Value,
    source_nodes: &[Value],
    mode: &str,
    scope: &str,
    level: &str,
) -> Value {
    let mut groups = BTreeMap::<String, Vec<Value>>::new();
    for node in source_nodes {
        let key = match level {
            "domain" => native_domain_key(node),
            "component" => format!(
                "{}\0{}\0{}",
                native_domain_key(node),
                native_feature_key(node),
                native_component_key(node)
            ),
            _ => format!("{}\0{}", native_domain_key(node), native_feature_key(node)),
        };
        groups.entry(key).or_default().push(node.clone());
    }
    let mut keys = groups.keys().cloned().collect::<Vec<_>>();
    keys.sort_by(|left, right| javascript_ascii_locale_cmp(left, right));
    let mut member_to_summary = BTreeMap::new();
    let mut nodes = Vec::new();
    for key in keys {
        let members = &groups[&key];
        let parts = native_hierarchy_parts(&key);
        let id_parts = if level == "domain" {
            vec![key.clone()]
        } else {
            parts.clone()
        };
        let id = native_hierarchy_id(level, &id_parts);
        for member in members {
            member_to_summary.insert(value_string(member, "id"), id.clone());
        }
        let mut types = members
            .iter()
            .map(|member| value_string(member, "type"))
            .collect::<Vec<_>>();
        types.sort();
        types.dedup();
        let type_counts = types
            .iter()
            .map(|kind| {
                (
                    kind.clone(),
                    json!(
                        members
                            .iter()
                            .filter(|member| value_string(member, "type") == *kind)
                            .count()
                    ),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        nodes.push(json!({"id":id,"kind":"summary","type":native_summary_type(members, &key),"label":native_semantic_label(level, &key),"feature":key,"layer":"projection","memberCount":members.len(),"members":members.iter().take(12).map(member_summary_value).collect::<Vec<_>>(),"memberIds":members.iter().map(|member| member["id"].clone()).collect::<Vec<_>>(),"typeCounts":type_counts,"detectedResponsibility":format!("Feature summary of {} source node{}.", members.len(), if members.len() == 1 { "" } else { "s" }),"analysis":{"parser":"flopeek-projection","status":"aggregate","confidence":"derived"},"hierarchy":{"level":level,"key":key,"parentId":native_parent_hierarchy_id(level, &key)}}));
    }
    let mut edge_map = BTreeMap::<(String, String), (BTreeMap<String, usize>, usize)>::new();
    for edge in graph
        .get("edges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let source = member_to_summary.get(&value_string(edge, "source"));
        let target = member_to_summary.get(&value_string(edge, "target"));
        let (Some(source), Some(target)) = (source, target) else {
            continue;
        };
        if source == target {
            continue;
        }
        let item = edge_map
            .entry((source.clone(), target.clone()))
            .or_insert_with(|| (BTreeMap::new(), 0));
        item.1 += 1;
        *item.0.entry(value_string(edge, "type")).or_default() += 1;
    }
    let edges = edge_map.into_iter().map(|((source, target), (type_counts, count))| { let types = type_counts.keys().cloned().collect::<Vec<_>>(); json!({"id":format!("{source}|{target}"),"source":source,"target":target,"type":if types.len() == 1 { types[0].clone() } else { "mixed".to_string() },"types":types,"count":count,"label":format!("{count} {}", if count == 1 { "relationship" } else { "relationships" }),"confidence":"derived","evidence":{"kind":"aggregate","sourceEdgeCount":count}}) }).collect::<Vec<_>>();
    json!({"nodes":nodes,"edges":edges,"sourceNodeCount":source_nodes.len(),"mode":mode,"scope":scope})
}

fn native_projection_limit(
    params: &Value,
    key: &str,
    fallback: usize,
    maximum: usize,
) -> Result<usize, NativeProtocolError> {
    let Some(value) = params.get(key).filter(|value| !value.is_null()) else {
        return Ok(fallback);
    };
    let parsed = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()));
    match parsed.filter(|value| *value >= 1 && (*value as usize) <= maximum) {
        Some(value) => Ok(value as usize),
        None => Err(NativeProtocolError {
            code: "invalid-view-bound",
            message: format!("{key} must be an integer from 1 through {maximum}."),
        }),
    }
}

fn native_bounded_projection(
    mut projection: Value,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let max_nodes = native_projection_limit(params, "maxNodes", 40, 100)?;
    let max_edges = native_projection_limit(params, "maxEdges", 80, 200)?;
    let focus = projection
        .get("focusId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut nodes = projection
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    nodes.sort_by(|left, right| {
        let left_id = value_string(left, "id");
        let right_id = value_string(right, "id");
        if left_id == focus {
            std::cmp::Ordering::Less
        } else if right_id == focus {
            std::cmp::Ordering::Greater
        } else {
            javascript_ascii_locale_cmp(&left_id, &right_id)
        }
    });
    let all_node_count = nodes.len();
    let omitted_nodes = nodes
        .iter()
        .skip(max_nodes)
        .map(|node| node["id"].clone())
        .collect::<Vec<_>>();
    nodes.truncate(max_nodes);
    let node_ids = nodes
        .iter()
        .map(|node| value_string(node, "id"))
        .collect::<BTreeSet<_>>();
    let original_edges = projection
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut edges = original_edges
        .iter()
        .filter(|edge| {
            node_ids.contains(&value_string(edge, "source"))
                && node_ids.contains(&value_string(edge, "target"))
        })
        .cloned()
        .collect::<Vec<_>>();
    let edge_order_key = |edge: &Value| {
        let id = value_string(edge, "id");
        if id.is_empty() {
            format!(
                "{}\0{}\0{}",
                value_string(edge, "source"),
                value_string(edge, "target"),
                value_string(edge, "type")
            )
        } else {
            id
        }
    };
    edges.sort_by(|left, right| {
        javascript_ascii_locale_cmp(&edge_order_key(left), &edge_order_key(right))
    });
    let eligible_edge_count = edges.len();
    let omitted_edges = edges
        .iter()
        .skip(max_edges)
        .map(|edge| {
            let id = value_string(edge, "id");
            if id.is_empty() {
                Value::String(edge_order_key(edge))
            } else {
                Value::String(id)
            }
        })
        .collect::<Vec<_>>();
    edges.truncate(max_edges);
    let unavailable_edges = original_edges.len().saturating_sub(eligible_edge_count);
    let truncated = !omitted_nodes.is_empty() || !omitted_edges.is_empty() || unavailable_edges > 0;
    projection["nodes"] = json!(nodes);
    projection["edges"] = json!(edges);
    projection["display"] = json!({"bounds":{"maxNodes":max_nodes,"maxEdges":max_edges,"hardMaxNodes":100,"hardMaxEdges":200},"catalog":{"nodes":{"total":all_node_count,"returned":projection["nodes"].as_array().map_or(0, Vec::len),"omitted":omitted_nodes.len(),"sampleOmittedIds":omitted_nodes.into_iter().take(12).collect::<Vec<_>>()},"edges":{"total":original_edges.len(),"eligible":eligible_edge_count,"returned":projection["edges"].as_array().map_or(0, Vec::len),"omitted":omitted_edges.len(),"omittedBecauseNodeBound":unavailable_edges,"sampleOmittedIds":omitted_edges.into_iter().take(12).collect::<Vec<_>>()},"truncated":truncated,"warning":if truncated { Value::String("This view is bounded. Use focus, scope, Flow Lens, or a smaller hierarchy level to inspect omitted static evidence.".to_string()) } else { Value::Null }}});
    Ok(projection)
}

fn native_project_overview_core(
    session: &NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let graph = native_view_graph(session, params)?;
    let mode = match native_view_option(params, "mode", "overview") {
        "overview" | "requests" | "dependencies" => native_view_option(params, "mode", "overview"),
        _ => "overview",
    };
    let scope = match native_view_option(params, "scope", "application") {
        "application" | "runtime" | "framework" | "devtool" | "all" => {
            native_view_option(params, "scope", "application")
        }
        _ => "application",
    };
    let focus = params
        .get("focus")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let level = if mode == "dependencies" {
        "symbol"
    } else {
        match native_view_option(params, "level", "feature") {
            "domain" | "feature" | "component" | "symbol" => {
                native_view_option(params, "level", "feature")
            }
            _ => "feature",
        }
    };
    let graph_nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let visible = graph_nodes
        .iter()
        .filter(|node| native_scope_visible(node, scope))
        .cloned()
        .collect::<Vec<_>>();
    let mut projection = if mode == "dependencies" {
        if let Some(focus_node) = visible
            .iter()
            .find(|node| value_string(node, "id") == focus.unwrap_or_default())
        {
            let visible_ids = visible
                .iter()
                .map(|node| value_string(node, "id"))
                .collect::<BTreeSet<_>>();
            let focus_id = value_string(focus_node, "id");
            let edges = graph
                .get("edges")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|edge| {
                    (value_string(edge, "source") == focus_id
                        || value_string(edge, "target") == focus_id)
                        && visible_ids.contains(&value_string(edge, "source"))
                        && visible_ids.contains(&value_string(edge, "target"))
                })
                .cloned()
                .collect::<Vec<_>>();
            let ids = edges
                .iter()
                .flat_map(|edge| [value_string(edge, "source"), value_string(edge, "target")])
                .chain(std::iter::once(focus_id.clone()))
                .collect::<BTreeSet<_>>();
            json!({"nodes":visible.iter().filter(|node| ids.contains(&value_string(node, "id"))).cloned().collect::<Vec<_>>(),"edges":edges,"sourceNodeCount":ids.len(),"focusId":focus_id})
        } else {
            json!({"nodes":[],"edges":[],"sourceNodeCount":0,"emptyState":"Search for a file, endpoint, or service, then select it to inspect direct dependencies."})
        }
    } else {
        let candidates = if mode == "requests" {
            native_entry_source_nodes(&graph, &visible)
        } else {
            visible
        };
        let source_nodes = candidates
            .into_iter()
            .filter(|node| native_focus_matches(node, focus))
            .collect::<Vec<_>>();
        if level == "symbol" {
            let ids = source_nodes
                .iter()
                .map(|node| value_string(node, "id"))
                .collect::<BTreeSet<_>>();
            json!({"nodes":source_nodes.iter().map(|node| { let mut node = node.clone(); node["hierarchy"] = json!({"level":"symbol","parentId":focus}); node }).collect::<Vec<_>>(),"edges":graph.get("edges").and_then(Value::as_array).into_iter().flatten().filter(|edge| ids.contains(&value_string(edge, "source")) && ids.contains(&value_string(edge, "target"))).cloned().collect::<Vec<_>>(),"sourceNodeCount":source_nodes.len(),"mode":mode,"scope":scope,"focusId":focus,"hierarchy":{"level":level,"parentFocusId":focus}})
        } else {
            let mut aggregate =
                native_aggregate_projection(&graph, &source_nodes, mode, scope, level);
            aggregate["focusId"] = json!(focus);
            aggregate["hierarchy"] = json!({"level":level,"parentFocusId":focus});
            aggregate
        }
    };
    projection = native_bounded_projection(projection, params)?;
    let agent_context_core = native_agent_context_core(&graph, &projection, mode, scope, focus);
    let available_flows = if scope == "all" {
        graph.get("diagnosticFlows").or_else(|| graph.get("flows"))
    } else {
        graph.get("flows")
    }
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
    Ok(
        json!({"schemaVersion":NATIVE_VIEW_PROJECTION_SCHEMA,"generatedAt":graph["generatedAt"].clone(),"project":graph["project"].clone(),"stats":graph["stats"].clone(),"nodes":projection["nodes"].clone(),"edges":projection["edges"].clone(),"flows":available_flows,"flowCatalog":{"total":available_flows.len(),"returned":available_flows.len(),"omittedFlowIds":[],"truncated":false,"warning":Value::Null},"basis":{"projectId":graph["project"]["projectId"].clone(),"graphVersion":graph["state"]["graphVersion"].clone(),"sourceFingerprint":graph["state"]["sourceFingerprint"].clone()},"display":projection["display"].clone(),"view":{"mode":mode,"scope":scope,"level":level,"focusId":focus,"sourceNodeCount":projection["sourceNodeCount"].clone(),"emptyState":projection.get("emptyState").cloned().unwrap_or(Value::Null),"hierarchy":projection.get("hierarchy").cloned().unwrap_or_else(|| json!({"level":level,"parentFocusId":Value::Null}))},"agentContextCore":agent_context_core}),
    )
}

fn impact_node(
    node: &crate::structural_graph::StructuralGraphNode,
    distance: usize,
    relationship: &str,
) -> Value {
    let mut summary = native_member_summary(node)
        .as_object()
        .cloned()
        .unwrap_or_default();
    summary.insert("distance".to_string(), json!(distance));
    summary.insert(
        "relationship".to_string(),
        Value::String(relationship.to_string()),
    );
    Value::Object(summary)
}

fn get_change_impact(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let previous_projection: Option<StructuralGraphSnapshot> = match params.get("previousBatch") {
        Some(previous_batch) => {
            submit_structural_facts(previous_batch)?;
            let previous =
                build_structural_graph(previous_batch).map_err(|message| NativeProtocolError {
                    code: "structural-graph-failed",
                    message,
                })?;
            Some(StructuralGraphSnapshot {
                nodes: previous.nodes,
                edges: previous.edges,
            })
        }
        None => match params.get("previousGraphVersion").and_then(Value::as_i64) {
            Some(graph_version) if graph_version > 0 => {
                let root = project_root(params)?;
                let project_id =
                    batch
                        .get("projectId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| NativeProtocolError {
                            code: "invalid-structural-facts",
                            message: "StructuralFactBatch/v1 requires projectId.".to_string(),
                        })?;
                let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
                    code: "store-read-failed",
                    message: error.to_string(),
                })?;
                let stored = complete_graph_payload(&connection, project_id, graph_version)
                    .map_err(|error| NativeProtocolError {
                        code: "store-read-failed",
                        message: error.to_string(),
                    })?
                    .ok_or_else(|| NativeProtocolError {
                        code: "missing-previous-graph",
                        message: format!("No complete native graph version {graph_version} is available for this project."),
                    })?;
                let actual_digest = projection_digest(&stored.payload)?;
                if actual_digest != stored.compatibility_digest {
                    return Err(NativeProtocolError {
                        code: "store-corrupt",
                        message:
                            "Stored native graph payload does not match its projection digest."
                                .to_string(),
                    });
                }
                Some(
                    structural_graph_snapshot(&stored.payload).map_err(|message| {
                        NativeProtocolError {
                            code: "store-corrupt",
                            message,
                        }
                    })?,
                )
            }
            Some(_) => {
                return Err(NativeProtocolError {
                    code: "invalid-params",
                    message: "previousGraphVersion must be a positive integer.".to_string(),
                });
            }
            None => None,
        },
    };
    let paths = query_changed_paths(params);
    let max_depth = query_max_depth(params);
    let node_by_id = projection
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut nodes_by_path = std::collections::BTreeMap::<
        String,
        Vec<&crate::structural_graph::StructuralGraphNode>,
    >::new();
    for node in &projection.nodes {
        if let Some(path) = &node.path {
            nodes_by_path.entry(path.clone()).or_default().push(node);
        }
    }
    let matched_paths = paths
        .iter()
        .filter(|path| nodes_by_path.contains_key(*path))
        .cloned()
        .collect::<Vec<_>>();
    let previous_nodes_by_path = previous_projection.as_ref().map(|previous| {
        let mut paths = std::collections::BTreeMap::<
            String,
            Vec<&crate::structural_graph::StructuralGraphNode>,
        >::new();
        for node in &previous.nodes {
            if let Some(path) = &node.path {
                paths.entry(path.clone()).or_default().push(node);
            }
        }
        paths
    });
    let deleted_paths = paths
        .iter()
        .filter(|path| {
            !nodes_by_path.contains_key(*path)
                && previous_nodes_by_path
                    .as_ref()
                    .is_some_and(|previous| previous.contains_key(*path))
        })
        .cloned()
        .collect::<Vec<_>>();
    let unmatched_paths = paths
        .iter()
        .filter(|path| !nodes_by_path.contains_key(*path) && !deleted_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    let mut incoming = std::collections::BTreeMap::<
        String,
        Vec<&crate::structural_graph::StructuralGraphEdge>,
    >::new();
    let mut outgoing = std::collections::BTreeMap::<
        String,
        Vec<&crate::structural_graph::StructuralGraphEdge>,
    >::new();
    for edge in &projection.edges {
        incoming.entry(edge.target.clone()).or_default().push(edge);
        outgoing.entry(edge.source.clone()).or_default().push(edge);
    }
    let mut impacted = std::collections::BTreeMap::<String, usize>::new();
    let mut queue = std::collections::VecDeque::new();
    for path in &matched_paths {
        for node in nodes_by_path.get(path).into_iter().flatten() {
            if impacted.insert(node.id.clone(), 0).is_none() {
                queue.push_back((node.id.clone(), 0usize));
            }
        }
    }
    let mut historical_dependent_ids = std::collections::BTreeSet::new();
    let mut deleted_nodes = Vec::new();
    let mut historical_truncated = None;
    if let (Some(previous), Some(previous_by_path)) = (
        previous_projection.as_ref(),
        previous_nodes_by_path.as_ref(),
    ) {
        let previous_by_id = previous
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut previous_incoming = std::collections::BTreeMap::<
            String,
            Vec<&crate::structural_graph::StructuralGraphEdge>,
        >::new();
        for edge in &previous.edges {
            previous_incoming
                .entry(edge.target.clone())
                .or_default()
                .push(edge);
        }
        let mut historical_queue = std::collections::VecDeque::new();
        for path in &deleted_paths {
            for node in previous_by_path.get(path).into_iter().flatten() {
                if node.kind == "file" {
                    deleted_nodes.push(native_member_summary(node));
                }
                historical_queue.push_back((node.id.clone(), 0usize));
            }
        }
        let mut visited = std::collections::BTreeSet::new();
        let mut historical_seeds = std::collections::BTreeMap::<String, usize>::new();
        while !historical_queue.is_empty() && visited.len() < 120 {
            let (current_id, distance) = historical_queue.pop_front().unwrap();
            if visited.contains(&current_id) || distance >= max_depth {
                continue;
            }
            visited.insert(current_id.clone());
            for edge in previous_incoming.get(&current_id).into_iter().flatten() {
                let Some(dependent) = previous_by_id.get(edge.source.as_str()) else {
                    continue;
                };
                let candidates = if let Some(current) = node_by_id.get(dependent.id.as_str()) {
                    vec![*current]
                } else if let Some(path) = &dependent.path {
                    nodes_by_path.get(path).cloned().unwrap_or_default()
                } else {
                    Vec::new()
                };
                for candidate in candidates {
                    let candidate_distance = distance + 1;
                    let replace = historical_seeds
                        .get(&candidate.id)
                        .is_none_or(|existing| *existing > candidate_distance);
                    if replace {
                        historical_seeds.insert(candidate.id.clone(), candidate_distance);
                    }
                }
                historical_queue.push_back((dependent.id.clone(), distance + 1));
            }
        }
        historical_truncated = Some(!historical_queue.is_empty());
        for (id, distance) in historical_seeds {
            historical_dependent_ids.insert(id.clone());
            if impacted
                .get(&id)
                .is_some_and(|existing| *existing <= distance)
            {
                continue;
            }
            impacted.insert(id.clone(), distance);
            queue.push_back((id, distance));
        }
        deleted_nodes.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    }
    while let Some((current_id, distance)) = queue.pop_front() {
        if distance >= max_depth || impacted.len() >= 120 {
            continue;
        }
        for edge in incoming.get(&current_id).into_iter().flatten() {
            if !node_by_id.contains_key(edge.source.as_str()) || impacted.contains_key(&edge.source)
            {
                continue;
            }
            impacted.insert(edge.source.clone(), distance + 1);
            queue.push_back((edge.source.clone(), distance + 1));
        }
    }
    let mut dependencies = std::collections::BTreeMap::<String, usize>::new();
    let mut dependency_queue = std::collections::VecDeque::new();
    for path in &matched_paths {
        for node in nodes_by_path.get(path).into_iter().flatten() {
            if dependencies.insert(node.id.clone(), 0).is_none() {
                dependency_queue.push_back((node.id.clone(), 0usize));
            }
        }
    }
    while let Some((current_id, distance)) = dependency_queue.pop_front() {
        if distance >= max_depth || dependencies.len() >= 120 {
            continue;
        }
        for edge in outgoing.get(&current_id).into_iter().flatten() {
            if !node_by_id.contains_key(edge.target.as_str())
                || dependencies.contains_key(&edge.target)
            {
                continue;
            }
            dependencies.insert(edge.target.clone(), distance + 1);
            dependency_queue.push_back((edge.target.clone(), distance + 1));
        }
    }
    let mut affected_nodes = impacted
        .iter()
        .filter_map(|(id, distance)| {
            node_by_id.get(id.as_str()).map(|node| {
                impact_node(
                    node,
                    *distance,
                    if historical_dependent_ids.contains(id) {
                        "historical-dependent"
                    } else if *distance == 0 {
                        "changed"
                    } else {
                        "dependent"
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    affected_nodes.sort_by(|left, right| {
        left["distance"]
            .as_u64()
            .cmp(&right["distance"].as_u64())
            .then_with(|| {
                left["label"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .cmp(&right["label"].as_str().unwrap_or_default().to_lowercase())
            })
            .then_with(|| right["label"].as_str().cmp(&left["label"].as_str()))
    });
    let mut dependency_nodes = dependencies
        .iter()
        .filter_map(|(id, distance)| {
            node_by_id.get(id.as_str()).map(|node| {
                impact_node(
                    node,
                    *distance,
                    if *distance == 0 {
                        "changed"
                    } else {
                        "dependency"
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    dependency_nodes.sort_by(|left, right| {
        left["distance"]
            .as_u64()
            .cmp(&right["distance"].as_u64())
            .then_with(|| {
                left["label"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .cmp(&right["label"].as_str().unwrap_or_default().to_lowercase())
            })
            .then_with(|| right["label"].as_str().cmp(&left["label"].as_str()))
    });
    let changed_nodes = affected_nodes
        .iter()
        .filter(|node| node["distance"] == 0)
        .cloned()
        .collect::<Vec<_>>();
    let affected_endpoints = affected_nodes
        .iter()
        .filter(|node| node["kind"] == "endpoint")
        .cloned()
        .collect::<Vec<_>>();
    let recommended_tests = affected_nodes
        .iter()
        .filter(|node| node["type"] == "test")
        .cloned()
        .collect::<Vec<_>>();
    let truncated =
        impacted.len() >= 120 || dependencies.len() >= 120 || historical_truncated.unwrap_or(false);
    let mut result = json!({
        "changedPaths": paths,
        "matchedPaths": matched_paths,
        "deletedPaths": deleted_paths,
        "unmatchedPaths": unmatched_paths,
        "deletedNodes": deleted_nodes,
        "historicalBaseline": previous_projection.is_some(),
        "changedNodes": changed_nodes,
        "affectedNodes": affected_nodes,
        "affectedEndpoints": affected_endpoints,
        "recommendedTests": recommended_tests,
        "dependencyNodes": dependency_nodes,
        "limitation": "Impact is a traversal of stored static graph edges. It identifies direct and transitive dependents and dependencies, not runtime execution or dynamic loading. Deleted-file callers are historical evidence only when a matching prior graph is available; the prior graph can be stale.",
    });
    if truncated || historical_truncated.is_some() {
        result["truncated"] = Value::Bool(truncated);
    }
    Ok(result)
}

// A promoted projection is already complete, validated, and held in memory.
// Keep it private to this process call so the public lifecycle can produce its
// response without reading and parsing the exact same SQLite payload again.
// The standalone protocol receipt deliberately exposes only receipt metadata;
// retained/last-complete reads still reconstruct exclusively from SQLite.
struct PersistedStructuralGraph {
    receipt: Value,
    projection: Value,
    public_snapshot: Value,
    public_collection_patch: Option<Value>,
    public_snapshot_materialization_ms: u64,
}

const NATIVE_PUBLIC_GRAPH_COLLECTIONS: [(&str, bool); 4] = [
    ("nodes", false),
    ("edges", true),
    ("flows", false),
    ("diagnosticFlows", false),
];

fn native_public_graph_envelope(public_graph: &Value) -> Value {
    let object = public_graph
        .as_object()
        .expect("native public graph snapshots remain objects");
    let mut envelope = serde_json::Map::new();
    for (key, value) in object {
        if !NATIVE_PUBLIC_GRAPH_COLLECTIONS
            .iter()
            .any(|(collection, _)| key == collection)
        {
            envelope.insert(key.clone(), value.clone());
        }
    }
    Value::Object(envelope)
}

// A handle-only refresh deliberately keeps the public collections in the
// native process.  It is an explicit transport mode for consumers that will
// immediately issue native SQLite queries, not a replacement for the normal
// compatibility snapshot.  Keep the ordinary envelope because it carries
// graph state, scan telemetry, and aggregate stats without duplicating the
// potentially large node/edge/flow collections in Node.
fn replace_public_graph_with_handle_envelope(
    response: &mut Value,
) -> Result<(), NativeProtocolError> {
    let graph = response
        .get("graph")
        .cloned()
        .or_else(|| response.pointer("/publicGraphReuse/envelope").cloned())
        .or_else(|| response.pointer("/publicGraphPatch/envelope").cloned())
        .ok_or_else(|| NativeProtocolError {
            code: "native-public-graph-missing",
            message: "Native persistent refresh produced no public graph representation."
                .to_string(),
        })?;
    let envelope = native_public_graph_envelope(&graph);
    let object = response
        .as_object_mut()
        .ok_or_else(|| NativeProtocolError {
            code: "native-public-graph-invalid",
            message: "Native persistent refresh result must be an object.".to_string(),
        })?;
    object.remove("graph");
    object.remove("publicGraphReuse");
    object.remove("publicGraphPatch");
    object.insert("publicGraphEnvelope".to_string(), envelope);
    object.insert(
        "publicGraphTransport".to_string(),
        json!({
            "schemaVersion": "flopeek-native-public-graph-transport/v1",
            "mode": "handle-only",
            "limitation": "Public graph collections remain in the native SQLite session. Request an explicit compatibility snapshot before using JavaScript graph extensions or export surfaces.",
        }),
    );
    Ok(())
}

fn requests_handle_only_public_graph(params: &Value) -> Result<bool, NativeProtocolError> {
    match params.get("returnPublicGraph") {
        None | Some(Value::Bool(true)) => Ok(false),
        Some(Value::Bool(false)) => Ok(true),
        Some(_) => Err(NativeProtocolError {
            code: "invalid-params",
            message: "refreshNativePersistentProject params.returnPublicGraph must be a boolean."
                .to_string(),
        }),
    }
}

fn native_public_collection_key(value: &Value, is_edge: bool) -> Option<String> {
    if !is_edge {
        return value
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| (!id.is_empty()).then(|| format!("id:{id}")));
    }
    let source = value.get("source").and_then(Value::as_str)?;
    let target = value.get("target").and_then(Value::as_str)?;
    let edge_type = value.get("type").and_then(Value::as_str)?;
    serde_json::to_string(&json!([source, target, edge_type])).ok()
}

// A structural refresh can return a compact collection patch because the
// persistent Node CoreClient still owns the preceding public graph.  This is
// a transport representation only: Rust continues to persist and validate the
// complete graph transactionally, while Node reconstructs the exact public
// arrays before exposing a result.
fn native_public_collection_patch(previous: &Value, current: &Value) -> Option<Value> {
    let previous = previous.as_object()?;
    let current = current.as_object()?;
    let mut collections = serde_json::Map::new();
    for (field, is_edge) in NATIVE_PUBLIC_GRAPH_COLLECTIONS {
        let previous_values = previous.get(field)?.as_array()?;
        let current_values = current.get(field)?.as_array()?;
        let mut previous_by_key = BTreeMap::new();
        let mut previous_order = Vec::with_capacity(previous_values.len());
        for value in previous_values {
            let key = native_public_collection_key(value, is_edge)?;
            if previous_by_key.insert(key.clone(), value).is_some() {
                return None;
            }
            previous_order.push(key);
        }
        let mut current_by_key = BTreeMap::new();
        let mut current_order = Vec::with_capacity(current_values.len());
        for value in current_values {
            let key = native_public_collection_key(value, is_edge)?;
            if current_by_key.insert(key.clone(), value).is_some() {
                return None;
            }
            current_order.push(key);
        }
        let removed = previous_order
            .iter()
            .filter(|key| !current_by_key.contains_key(*key))
            .cloned()
            .map(Value::String)
            .collect::<Vec<_>>();
        let upserts = current_order
            .iter()
            .filter_map(|key| {
                let value = current_by_key.get(key)?;
                (previous_by_key.get(key) != Some(value)).then(|| (*value).clone())
            })
            .collect::<Vec<_>>();
        // Most local edits only insert/remove a few public members while the
        // surviving members keep their order. Preserve that fact as sparse
        // inserts instead of sending a complete 10k-entry ordering array.
        // A genuine reorder still carries the full order as a safe fallback.
        let retained_previous = previous_order
            .iter()
            .filter(|key| current_by_key.contains_key(*key))
            .collect::<Vec<_>>();
        let retained_current = current_order
            .iter()
            .filter(|key| previous_by_key.contains_key(*key))
            .collect::<Vec<_>>();
        let stable_retained_order = retained_previous == retained_current;
        let inserts = if stable_retained_order {
            {
                current_order
                    .iter()
                    .enumerate()
                    .filter(|(_, key)| !previous_by_key.contains_key(*key))
                    .map(|(index, key)| json!({ "key": key, "index": index }))
                    .collect::<Vec<_>>()
            }
        } else {
            Default::default()
        };
        collections.insert(
            field.to_string(),
            json!({
                "remove": removed,
                "upsert": upserts,
                "insert": inserts,
                "order": (!stable_retained_order).then_some(current_order),
            }),
        );
    }
    Some(Value::Object(collections))
}

fn persist_reused_structural_projection(
    params: &Value,
    connection: &mut rusqlite::Connection,
    receipt: Value,
    previous_projection: &Value,
    previous_public_snapshot: Option<&Value>,
    changed_record_paths: Option<&BTreeSet<String>>,
) -> Result<PersistedStructuralGraph, NativeProtocolError> {
    let started = Instant::now();
    let batch = structural_batch(params)?;
    let project_id = receipt
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing projectId.".to_string(),
        })?;
    let facts_digest = receipt
        .get("factsDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing factsDigest.".to_string(),
        })?;
    let public_graph_version = batch["flowContext"]["graphVersion"]
        .as_i64()
        .filter(|version| *version >= 0)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-context",
            message:
                "StructuralFactBatch/v1 flowContext.graphVersion must be a non-negative integer."
                    .to_string(),
        })?;
    let projection_clone_started = Instant::now();
    let mut projection = previous_projection.clone();
    let projection_clone_ms = elapsed_ms(projection_clone_started);
    projection["flowContext"] = batch["flowContext"].clone();
    projection["lifecycleContext"] = batch["lifecycleContext"].clone();
    projection["publicGraphContext"] = batch["publicGraphContext"].clone();
    projection["projectId"] = Value::String(project_id.to_string());
    let projection_digest_started = Instant::now();
    let projection_digest = projection_digest(&projection)?;
    let projection_digest_ms = elapsed_ms(projection_digest_started);
    // A source-only projection has already proved its public collections are
    // reusable. Prefer the process-local previous snapshot when it is tied to
    // the SQLite-selected graph version; a cache miss retains the conservative
    // full reconstruction path.
    let previous_public_snapshot_cache_hit = previous_public_snapshot.is_some();
    let snapshot_started = Instant::now();
    let (public_snapshot, adjacent_delta) = if let Some(cached) = previous_public_snapshot {
        // Do not reconstruct arrays that the response will deliberately omit.
        // `cached` supplies the exact public collections for affected-node and
        // flow evidence; the independently built envelopes retain current
        // source/version/refresh semantics for the adjacent delta.
        let previous_context = native_public_graph_context(previous_projection, None)?;
        let mut current_context = native_public_graph_context(&projection, None)?;
        current_context["stats"] = cached["stats"].clone();
        let delta = native_public_graph_delta_with_reused_collections(
            previous_projection,
            &previous_context,
            &projection,
            &current_context,
            cached,
        )?;
        (current_context, delta)
    } else {
        let public_snapshot = native_public_graph_snapshot(&projection)?;
        let previous_public = native_public_graph_snapshot(previous_projection)?;
        let delta = native_public_graph_delta_from_public_snapshots(
            previous_projection,
            &previous_public,
            &projection,
            &public_snapshot,
        )?;
        (public_snapshot, delta)
    };
    let public_snapshot_materialization_ms = elapsed_ms(snapshot_started);
    let persistence_started = Instant::now();
    let candidate =
        begin_graph_build(connection, project_id, facts_digest, facts_digest).map_err(|error| {
            NativeProtocolError {
                code: "store-build-failed",
                message: error.to_string(),
            }
        })?;
    let structural_batch = structural_batch(params)?;
    let promotion_timing = promote_graph_build_with_changed_records(
        connection,
        NativeGraphPromotionRequest {
            project_id,
            graph_version: candidate.graph_version,
            public_graph_version,
            payload: &projection,
            compatibility_digest: &projection_digest,
            adjacent_delta: Some(&adjacent_delta),
            facts_digest: Some(facts_digest),
            structural_batch: Some(structural_batch),
            changed_record_paths,
            reuse_public_components: true,
        },
    )
    .map_err(|error| NativeProtocolError {
        code: "store-promote-failed",
        message: error.to_string(),
    })?;
    let persistence_ms = elapsed_ms(persistence_started);
    Ok(PersistedStructuralGraph {
        receipt: json!({
            "schemaVersion": "flopeek-native-shadow-store-receipt/v1",
            "stored": true,
            "status": "promoted",
            "graphVersion": candidate.graph_version,
            "projectionDigest": projection_digest,
            "factsDigest": facts_digest,
            "adjacentDelta": adjacent_delta,
            "profile": {
                "schemaVersion": "flopeek-native-lifecycle-profile/v1",
                "factValidationMs": 0,
                "graphAssemblyMs": 0,
                "flowAssemblyMs": 0,
                "primaryFlowsMs": 0,
                "diagnosticFlowsMs": 0,
                "flowLensesMs": 0,
                "serializationMs": 0,
                "projectionCloneMs": projection_clone_ms,
                "projectionDigestMs": projection_digest_ms,
                "deltaAndPersistenceMs": persistence_ms,
                "persistenceMs": persistence_ms,
                "promotionPublicCacheMs": promotion_timing.public_cache_ms,
                "promotionPublicCacheWriteMs": promotion_timing.public_cache_write_ms,
                "promotionDeltaWriteMs": promotion_timing.delta_write_ms,
                "promotionFactCacheMs": promotion_timing.structural_fact_cache_ms,
                "promotionProjectPointerMs": promotion_timing.project_pointer_ms,
                "promotionTransactionMs": promotion_timing.transaction_ms,
                "promotionTotalMs": promotion_timing.total_ms,
                "reusedStructuralProjection": true,
                "previousPublicSnapshotCacheHit": previous_public_snapshot_cache_hit,
                "totalMs": elapsed_ms(started),
            },
            "limitation": "This persists only the validated native structural shadow projection. JavaScript remains authoritative for public graph, Context Ref, and query output.",
        }),
        projection,
        public_snapshot,
        public_collection_patch: None,
        public_snapshot_materialization_ms,
    })
}

struct PersistStructuralGraphOptions<'a> {
    validated_receipt: Option<Value>,
    previous_projection: Option<&'a Value>,
    previous_public_snapshot: Option<&'a Value>,
    reuse_previous_projection: bool,
    isolated_incremental_path: Option<&'a str>,
    changed_record_paths: Option<&'a BTreeSet<String>>,
}

fn persist_structural_graph_internal(
    params: &Value,
    connection: &mut rusqlite::Connection,
    options: PersistStructuralGraphOptions<'_>,
) -> Result<PersistedStructuralGraph, NativeProtocolError> {
    let started = Instant::now();
    // persistNativePublicGraph has already validated the exact same material
    // batch to choose its graph version. Reuse that receipt instead of hashing
    // and validating the multi-megabyte fact batch a second time. The only
    // mutations before this call are flowContext.graphVersion and
    // publicGraphContext.state, both intentionally excluded from the material
    // digest by structural_facts_canonical_json.
    let receipt = match options.validated_receipt {
        Some(receipt) => receipt,
        None => submit_structural_facts(params)?,
    };
    if options.reuse_previous_projection {
        let previous =
            options.previous_projection.ok_or_else(|| {
                NativeProtocolError {
            code: "store-integrity-failed",
            message:
                "A structural projection reuse request requires the current complete projection."
                    .to_string(),
        }
            })?;
        return persist_reused_structural_projection(
            params,
            connection,
            receipt,
            previous,
            options.previous_public_snapshot,
            options.changed_record_paths,
        );
    }
    let fact_validation_ms = elapsed_ms(started);
    let batch = structural_batch(params)?;
    let assembly_started = Instant::now();
    let graph = match (
        options.isolated_incremental_path,
        options.previous_projection,
    ) {
        (Some(path), Some(previous)) => build_isolated_incremental_graph(batch, previous, path)?,
        _ => build_structural_graph(batch).map_err(|message| NativeProtocolError {
            code: "structural-graph-failed",
            message,
        })?,
    };
    let native_traversal_order = structural_edge_traversal_order(batch, &graph);
    let mut projection = serde_json::to_value(&graph).map_err(|error| NativeProtocolError {
        code: "structural-graph-serialize-failed",
        message: error.to_string(),
    })?;
    let graph_assembly_ms = elapsed_ms(assembly_started);
    let flows_started = Instant::now();
    let (primary_tests, primary_fixtures) = configured_flow_scope(batch, "primary");
    let primary_flows_started = Instant::now();
    let flows =
        assemble_native_flows_from_projection(batch, &graph, primary_tests, primary_fixtures);
    let primary_flows_ms = elapsed_ms(primary_flows_started);
    let flow_entries = flows.as_array().ok_or_else(|| NativeProtocolError {
        code: "flow-assembly-failed",
        message: "Native flow assembly must return an array.".to_string(),
    })?;
    let diagnostic_flows_started = Instant::now();
    let (diagnostic_tests, diagnostic_fixtures) = configured_flow_scope(batch, "diagnostic");
    let diagnostic_flows =
        assemble_native_flows_from_projection(batch, &graph, diagnostic_tests, diagnostic_fixtures);
    let diagnostic_flows_ms = elapsed_ms(diagnostic_flows_started);
    let flow_lenses_started = Instant::now();
    let flow_lenses = flow_entries
        .iter()
        .filter_map(|flow| flow["id"].as_str())
        .map(|flow_id| native_flow_lens_from_assembled(batch, flow_entries, &graph, flow_id, 12))
        .collect::<Result<Vec<_>, _>>()?;
    let flow_lenses_ms = elapsed_ms(flow_lenses_started);
    let flow_assembly_ms = elapsed_ms(flows_started);
    let serialization_started = Instant::now();
    projection["flowContext"] = batch["flowContext"].clone();
    projection["lifecycleContext"] = batch["lifecycleContext"].clone();
    projection["publicGraphContext"] = batch["publicGraphContext"].clone();
    projection["nativeTraversalOrder"] =
        serde_json::to_value(native_traversal_order).map_err(|error| NativeProtocolError {
            code: "structural-graph-serialize-failed",
            message: error.to_string(),
        })?;
    projection["flows"] = flows;
    projection["diagnosticFlows"] = diagnostic_flows;
    projection["flowLenses"] = Value::Array(flow_lenses);
    projection["snapshotSchemaVersion"] = json!("flopeek-native-core-snapshot/v1");
    let project_id = receipt
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing projectId.".to_string(),
        })?;
    let public_graph_version = projection["flowContext"]["graphVersion"]
        .as_i64()
        .filter(|version| *version >= 0)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-context",
            message:
                "StructuralFactBatch/v1 flowContext.graphVersion must be a non-negative integer."
                    .to_string(),
        })?;
    projection["projectId"] = Value::String(project_id.to_string());
    let projection_digest = projection_digest(&projection)?;
    let serialization_ms = elapsed_ms(serialization_started);
    // Public response construction needs only nodes and edges. Retain this
    // typed snapshot alongside the JSON persistence projection so a newly
    // promoted graph is not deserialized from JSON merely to serialize the
    // equivalent public node/edge response again.
    let snapshot = StructuralGraphSnapshot {
        nodes: graph.nodes,
        edges: graph.edges,
    };
    // Build this exactly once for both adjacent-delta comparison and the
    // public lifecycle response. Reconstructing nodes/edges twice here used
    // to clone and sort the entire public graph on every changed refresh.
    let public_snapshot_started = Instant::now();
    let public_snapshot = native_public_graph_snapshot_from_snapshot(&snapshot, &projection, None)?;
    let public_snapshot_materialization_ms = elapsed_ms(public_snapshot_started);
    let facts_digest = receipt
        .get("factsDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing factsDigest.".to_string(),
        })?;
    let persistence_started = Instant::now();
    let previous = if let Some(current) =
        current_complete_graph(connection, project_id).map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })? {
        if current.material_fingerprint == facts_digest
            && current.source_fingerprint == facts_digest
            && current.public_graph_version == Some(public_graph_version)
        {
            return Ok(PersistedStructuralGraph {
                receipt: json!({
                    "schemaVersion": "flopeek-native-shadow-store-receipt/v1",
                    "stored": true,
                    "status": "reused",
                    "graphVersion": current.graph_version,
                    "projectionDigest": current.compatibility_digest,
                    "factsDigest": facts_digest,
                    "profile": {"schemaVersion":"flopeek-native-lifecycle-profile/v1","factValidationMs":fact_validation_ms,"graphAssemblyMs":graph_assembly_ms,"flowAssemblyMs":flow_assembly_ms,"primaryFlowsMs":primary_flows_ms,"diagnosticFlowsMs":diagnostic_flows_ms,"flowLensesMs":flow_lenses_ms,"serializationMs":serialization_ms,"persistenceMs":elapsed_ms(persistence_started),"totalMs":elapsed_ms(started)},
                    "limitation": "This persists only the validated native structural shadow projection. JavaScript remains authoritative for public graph, Context Ref, and query output.",
                }),
                projection,
                public_snapshot,
                public_collection_patch: None,
                public_snapshot_materialization_ms,
            });
        }
        Some(current)
    } else {
        None
    };
    // The current persistent session already holds the previous complete
    // projection. Reconstruct its public arrays once for both delta evidence
    // and the optional compact transport patch; never let this optimization
    // alter the complete SQLite candidate.
    let previous_public_snapshot = options
        .previous_projection
        .map(native_public_graph_snapshot)
        .transpose()?;
    let public_collection_patch = previous_public_snapshot
        .as_ref()
        .and_then(|previous_public| {
            native_public_collection_patch(previous_public, &public_snapshot)
        });
    let adjacent_delta = previous
        .as_ref()
        .map(|previous| {
            if let (Some(cached), Some(previous_public)) =
                (options.previous_projection, previous_public_snapshot.as_ref())
            {
                return native_public_graph_delta_from_public_snapshots(
                    cached,
                    previous_public,
                    &projection,
                    &public_snapshot,
                );
            }
            let stored = complete_graph_payload(connection, project_id, previous.graph_version)
                .map_err(|error| NativeProtocolError {
                    code: "store-read-failed",
                    message: error.to_string(),
                })?
                .ok_or_else(|| NativeProtocolError {
                    code: "store-read-failed",
                    message: "Current complete native graph payload is unavailable.".to_string(),
                })?;
            if stored.compatibility_digest != previous.compatibility_digest.clone().unwrap_or_default() {
                return Err(NativeProtocolError {
                    code: "store-integrity-failed",
                    message: "Current complete native graph payload digest does not match its graph version.".to_string(),
                });
            }
            let previous_public = native_public_graph_snapshot(&stored.payload)?;
            native_public_graph_delta_from_public_snapshots(
                &stored.payload,
                &previous_public,
                &projection,
                &public_snapshot,
            )
        })
        .transpose()?;
    let delta_ms = elapsed_ms(persistence_started);
    let candidate =
        begin_graph_build(connection, project_id, facts_digest, facts_digest).map_err(|error| {
            NativeProtocolError {
                code: "store-build-failed",
                message: error.to_string(),
            }
        })?;
    let structural_batch = structural_batch(params)?;
    let promotion_timing = promote_graph_build_with_changed_records(
        connection,
        NativeGraphPromotionRequest {
            project_id,
            graph_version: candidate.graph_version,
            public_graph_version,
            payload: &projection,
            compatibility_digest: &projection_digest,
            adjacent_delta: adjacent_delta.as_ref(),
            facts_digest: Some(facts_digest),
            structural_batch: Some(structural_batch),
            changed_record_paths: options.changed_record_paths,
            reuse_public_components: false,
        },
    )
    .map_err(|error| NativeProtocolError {
        code: "store-promote-failed",
        message: error.to_string(),
    })?;
    let persistence_ms = elapsed_ms(persistence_started);
    Ok(PersistedStructuralGraph {
        receipt: json!({
            "schemaVersion": "flopeek-native-shadow-store-receipt/v1",
            "stored": true,
            "status": "promoted",
            "graphVersion": candidate.graph_version,
            "projectionDigest": projection_digest,
            "factsDigest": facts_digest,
            "adjacentDelta": adjacent_delta,
            "profile": {"schemaVersion":"flopeek-native-lifecycle-profile/v1","factValidationMs":fact_validation_ms,"graphAssemblyMs":graph_assembly_ms,"flowAssemblyMs":flow_assembly_ms,"primaryFlowsMs":primary_flows_ms,"diagnosticFlowsMs":diagnostic_flows_ms,"flowLensesMs":flow_lenses_ms,"serializationMs":serialization_ms,"deltaAndPersistenceMs":delta_ms,"persistenceMs":persistence_ms,"promotionPublicCacheMs":promotion_timing.public_cache_ms,"promotionPublicCacheWriteMs":promotion_timing.public_cache_write_ms,"promotionDeltaWriteMs":promotion_timing.delta_write_ms,"promotionFactCacheMs":promotion_timing.structural_fact_cache_ms,"promotionProjectPointerMs":promotion_timing.project_pointer_ms,"promotionTransactionMs":promotion_timing.transaction_ms,"promotionTotalMs":promotion_timing.total_ms,"totalMs":elapsed_ms(started)},
            "limitation": "This persists only the validated native structural shadow projection. JavaScript remains authoritative for public graph, Context Ref, and query output.",
        }),
        projection,
        public_snapshot,
        public_collection_patch,
        public_snapshot_materialization_ms,
    })
}

fn persist_structural_graph(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let mut connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-initialize-failed",
        message: error.to_string(),
    })?;
    let project_id = structural_batch(params)?
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 requires projectId.".to_string(),
        })?;
    recover_incomplete_graph_builds(&mut connection, project_id).map_err(|error| {
        NativeProtocolError {
            code: "store-recovery-failed",
            message: error.to_string(),
        }
    })?;
    Ok(persist_structural_graph_internal(
        params,
        &mut connection,
        PersistStructuralGraphOptions {
            validated_receipt: None,
            previous_projection: None,
            previous_public_snapshot: None,
            reuse_previous_projection: false,
            isolated_incremental_path: None,
            changed_record_paths: None,
        },
    )?
    .receipt)
}

fn versioned_native_lifecycle_params(
    params: &mut Value,
    public_graph_version: i64,
    validated_facts_digest: &str,
) -> Result<(), NativeProtocolError> {
    let batch = if params.get("batch").is_some() {
        params.get_mut("batch")
    } else {
        Some(params)
    }
    .and_then(Value::as_object_mut)
    .ok_or_else(|| NativeProtocolError {
        code: "invalid-structural-facts",
        message: "Native lifecycle requires a StructuralFactBatch/v1 object.".to_string(),
    })?;
    let flow_context = batch
        .get_mut("flowContext")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-context",
            message: "StructuralFactBatch/v1 requires flowContext.".to_string(),
        })?;
    flow_context.insert("graphVersion".to_string(), json!(public_graph_version));
    let state = batch
        .get_mut("publicGraphContext")
        .and_then(Value::as_object_mut)
        .and_then(|context| context.get_mut("state"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-public-graph-context",
            message:
                "StructuralFactBatch/v1 requires publicGraphContext.state for native lifecycle."
                    .to_string(),
        })?;
    state.insert("graphVersion".to_string(), json!(public_graph_version));
    state.insert(
        "status".to_string(),
        Value::String("native-pending-promotion".to_string()),
    );
    if !validated_facts_digest.starts_with("sha256:")
        || !is_sha256_hex(&validated_facts_digest[7..])
    {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "Native lifecycle requires a validated StructuralFactBatch/v1 factsDigest."
                .to_string(),
        });
    }
    // This function changes only fields excluded from the material digest:
    // flowContext.graphVersion and publicGraphContext. Recomputing the digest
    // would clone and serialize every parser fact without changing identity.
    batch.insert(
        "factsDigest".to_string(),
        Value::String(validated_facts_digest.to_string()),
    );
    Ok(())
}

/// Rebuild a complete fact batch from the cache attached to SQLite's current
/// complete graph.  The patch is deliberately rejected on any cache miss or
/// manifest disagreement: a caller must then submit a normal full batch.  In
/// particular this prevents a resolver/configuration change from silently
/// combining fresh records with imports resolved under an older context.
fn reconstruct_structural_fact_patch(
    session: &mut NativeProtocolSession,
    params: &Value,
    connection: &rusqlite::Connection,
) -> Result<(NativePersistentFacts, NativePersistentFacts, Value), NativeProtocolError> {
    let patch = params.as_object().ok_or_else(|| NativeProtocolError {
        code: "invalid-structural-fact-patch",
        message: "Native structural fact patch must be an object.".to_string(),
    })?;
    if patch.get("schemaVersion").and_then(Value::as_str) != Some(STRUCTURAL_FACT_PATCH_SCHEMA) {
        return Err(NativeProtocolError {
            code: "unsupported-structural-fact-patch",
            message: format!("Structural fact patches must use {STRUCTURAL_FACT_PATCH_SCHEMA}."),
        });
    }
    let project_id = string_field(patch, "projectId")?.to_string();
    let base_digest = string_field(patch, "baseFactsDigest")?.to_string();
    let expected_digest = patch
        .get("expectedFactsDigest")
        .and_then(Value::as_str)
        .map(str::to_string);
    if !base_digest.starts_with("sha256:")
        || !is_sha256_hex(&base_digest[7..])
        || expected_digest
            .as_ref()
            .is_some_and(|digest| !digest.starts_with("sha256:") || !is_sha256_hex(&digest[7..]))
    {
        return Err(NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch digests must be SHA-256 values when supplied."
                .to_string(),
        });
    }
    ensure_persistent_facts(session, connection, &project_id, &base_digest)?;
    let mut batch = patch
        .get("batch")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch requires a batch envelope.".to_string(),
        })?;
    if batch.get("schemaVersion").and_then(Value::as_str) != Some(STRUCTURAL_FACT_BATCH_SCHEMA)
        || batch.get("projectId").and_then(Value::as_str) != Some(project_id.as_str())
        || batch.contains_key("records")
        || batch.contains_key("factsDigest")
    {
        return Err(NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch batch envelope is invalid.".to_string(),
        });
    }
    let manifest = patch
        .get("manifest")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch requires a record manifest.".to_string(),
        })?;
    let changed = patch
        .get("changedRecords")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch requires changed records.".to_string(),
        })?;
    // Move the non-authoritative process cache into the candidate batch so
    // unchanged parser records are not deep-cloned on every compact patch.
    // A later promotion failure intentionally leaves this cache empty; the
    // next request reloads the last complete SQLite graph instead.
    let mut previous = session
        .persistent_facts
        .take()
        .expect("persistent facts are ensured");
    if previous.project_id != project_id || previous.facts_digest != base_digest {
        return Err(NativeProtocolError {
            code: "structural-fact-patch-miss",
            message: "The persistent fact cache no longer matches the patch base.".to_string(),
        });
    }
    let mut next = NativePersistentFacts {
        project_id: previous.project_id.clone(),
        facts_digest: previous.facts_digest.clone(),
        topology_digest: previous.topology_digest.clone(),
        payload: std::mem::replace(&mut previous.payload, Value::Null),
    };
    let cached_records = next
        .payload
        .get_mut("records")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| NativeProtocolError {
            code: "store-integrity-failed",
            message: "The cached StructuralFactBatch is missing records.".to_string(),
        })?;
    let mut cached_by_path = BTreeMap::new();
    for record in std::mem::take(cached_records) {
        let path = record
            .get("relativePath")
            .and_then(Value::as_str)
            .ok_or_else(|| NativeProtocolError {
                code: "store-integrity-failed",
                message: "The cached StructuralFactBatch contains an invalid record.".to_string(),
            })?;
        if cached_by_path.insert(path.to_string(), record).is_some() {
            return Err(NativeProtocolError {
                code: "store-integrity-failed",
                message: "The cached StructuralFactBatch repeats a record path.".to_string(),
            });
        }
    }
    let mut changed_by_path = BTreeMap::new();
    for record in changed {
        let path = record
            .get("relativePath")
            .and_then(Value::as_str)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "Changed structural fact records require relativePath.".to_string(),
            })?;
        if changed_by_path.insert(path, record).is_some() {
            return Err(NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "Structural fact patch repeats a changed record path.".to_string(),
            });
        }
    }
    let mut records = Vec::with_capacity(manifest.len());
    let mut manifest_paths = BTreeMap::new();
    for header in manifest {
        let object = header.as_object().ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch manifest records must be objects.".to_string(),
        })?;
        let path = string_field(object, "relativePath")?;
        let source_hash = string_field(object, "sourceHash")?;
        let source_scope = string_field(object, "sourceScope")?;
        let record_order = object
            .get("recordOrder")
            .and_then(Value::as_u64)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "Structural fact patch manifest records require recordOrder.".to_string(),
            })?;
        if !is_portable_repository_path(path)
            || !is_sha256_hex(source_hash)
            || manifest_paths.insert(path.to_string(), ()).is_some()
        {
            return Err(NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "Structural fact patch manifest is invalid.".to_string(),
            });
        }
        let cached_record = cached_by_path
            .remove(path)
            .ok_or_else(|| NativeProtocolError {
                code: "structural-fact-patch-miss",
                message: format!(
                    "Structural fact patch is missing cached record {path}; submit a full batch."
                ),
            })?;
        let record = changed_by_path
            .remove(path)
            .cloned()
            .unwrap_or(cached_record);
        if record.get("relativePath").and_then(Value::as_str) != Some(path)
            || record.get("sourceHash").and_then(Value::as_str) != Some(source_hash)
            || record.get("sourceScope").and_then(Value::as_str) != Some(source_scope)
            || record.get("recordOrder").and_then(Value::as_u64) != Some(record_order)
        {
            return Err(NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: format!("Structural fact patch record header disagrees for {path}."),
            });
        }
        records.push(record);
    }
    if !changed_by_path.is_empty() {
        return Err(NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch includes records absent from its manifest.".to_string(),
        });
    }
    batch.insert("records".to_string(), Value::Array(records));
    // The native cache is the only input authority for unchanged records, so
    // native computes the candidate digest when Node intentionally omitted it
    // to avoid serializing every unchanged record. An older caller may still
    // provide an expected value, which remains a strict cross-check.
    let computed_digest =
        structural_facts_digest(&batch).map_err(|message| NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message,
        })?;
    if let Some(expected_digest) = expected_digest.as_ref() {
        if expected_digest != &computed_digest {
            return Err(NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "Structural fact patch digest verification failed.".to_string(),
            });
        }
    }
    // The digest string is tiny; retain it for the internal validation proof
    // while the reconstructed wire batch takes its own owned value.
    batch.insert(
        "factsDigest".to_string(),
        Value::String(computed_digest.clone()),
    );
    let mut reconstructed = Value::Object(batch);
    reconstructed["projectRoot"] = params["projectRoot"].clone();
    let receipt =
        submit_structural_facts_with_verified_digest(&reconstructed, Some(&computed_digest))?;
    let topology_digest = reconstructed
        .as_object()
        .ok_or_else(|| NativeProtocolError {
            code: "store-integrity-failed",
            message: "Reconstructed structural fact patch is not an object.".to_string(),
        })
        .and_then(|batch| {
            structural_topology_digest(batch).map_err(|message| NativeProtocolError {
                code: "store-integrity-failed",
                message,
            })
        })?;
    next.project_id = project_id;
    next.facts_digest = computed_digest;
    next.topology_digest = topology_digest;
    next.payload = reconstructed;
    Ok((next, previous, receipt))
}

fn persist_native_public_graph_patch(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    with_persistent_session_connection(session, &root, |session, connection| {
        persist_native_public_graph_patch_using_connection(session, params, connection)
    })
}

fn persist_native_public_graph_patch_using_connection(
    session: &mut NativeProtocolSession,
    params: &Value,
    connection: &mut rusqlite::Connection,
) -> Result<Value, NativeProtocolError> {
    let reconstruction_started = Instant::now();
    let (mut next, previous, receipt) =
        reconstruct_structural_fact_patch(session, params, connection)?;
    let reconstruction_ms = elapsed_ms(reconstruction_started);
    let changed_paths = params
        .get("changedRecords")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch requires changed records.".to_string(),
        })?
        .iter()
        .map(|record| {
            record
                .get("relativePath")
                .and_then(Value::as_str)
                .filter(|path| is_portable_repository_path(path))
                .map(str::to_string)
                .ok_or_else(|| NativeProtocolError {
                    code: "invalid-structural-fact-patch",
                    message:
                        "Changed structural fact records require portable relativePath values."
                            .to_string(),
                })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let project_root =
        next.payload
            .get("projectRoot")
            .cloned()
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-facts",
                message: "Reconstructed structural fact patch is missing projectRoot.".to_string(),
            })?;
    // Keep the previous cache identity available during promotion. Its payload
    // was moved into `next`, so a failed promotion clears this derived cache
    // rather than risking stale process-local parser facts.
    session.persistent_facts = Some(previous);
    // Keep patch membership outside StructuralFactBatch/v1 so it can optimize
    // the SQLite record cache without becoming parser evidence or affecting
    // the canonical public facts digest.
    let persistence_started = Instant::now();
    let persistence_params_started = Instant::now();
    let mut persistence_params = json!({
        "batch": std::mem::replace(&mut next.payload, Value::Null),
        "projectRoot": project_root,
        "nativeFactPatchChangedPaths": changed_paths,
    });
    let persistence_params_ms = elapsed_ms(persistence_params_started);
    let native_lifecycle_started = Instant::now();
    let mut result = match persist_native_public_graph_with_receipt_using_connection(
        session,
        &mut persistence_params,
        receipt,
        false,
        Some(next.topology_digest.clone()),
        None,
        connection,
    ) {
        Ok(result) => result,
        Err(error) => {
            session.persistent_facts = None;
            return Err(error);
        }
    };
    let native_lifecycle_ms = elapsed_ms(native_lifecycle_started);
    // Only update the process cache after the durable graph promotion succeeds.
    // Removing `batch` transfers the already-validated exact value rather than
    // copying it; an error above leaves the prior cache valid for retry.
    let session_cache_started = Instant::now();
    let payload = persistence_params
        .as_object_mut()
        .and_then(|object| object.remove("batch"))
        .expect("patch persistence parameters retain their batch");
    next.payload = payload;
    session.persistent_facts = Some(next);
    let session_cache_ms = elapsed_ms(session_cache_started);
    let persistence_ms = elapsed_ms(persistence_started);
    if let Some(profile) = result
        .get_mut("receipt")
        .and_then(|receipt| receipt.get_mut("profile"))
        .and_then(Value::as_object_mut)
    {
        profile.insert(
            "factPatchReconstructionMs".to_string(),
            json!(reconstruction_ms),
        );
        profile.insert("factPatchPersistenceMs".to_string(), json!(persistence_ms));
        profile.insert(
            "factPatchParamsMs".to_string(),
            json!(persistence_params_ms),
        );
        profile.insert(
            "factPatchNativeLifecycleMs".to_string(),
            json!(native_lifecycle_ms),
        );
        profile.insert(
            "factPatchSessionCacheMs".to_string(),
            json!(session_cache_ms),
        );
        // The nested native-public lifecycle timer intentionally starts after
        // patch reconstruction. Expose the complete Rust patch interval as
        // well so the Node profiler does not mislabel reconstruction and
        // durable promotion as JSONL transport residual.
        profile.insert(
            "nativePatchLifecycleTotalMs".to_string(),
            json!(reconstruction_ms.saturating_add(persistence_ms)),
        );
    }
    Ok(result)
}

fn native_fact_patch_changed_paths(
    params: &Value,
) -> Result<Option<BTreeSet<String>>, NativeProtocolError> {
    let Some(paths) = params.get("nativeFactPatchChangedPaths") else {
        return Ok(None);
    };
    let paths = paths.as_array().ok_or_else(|| NativeProtocolError {
        code: "invalid-structural-fact-patch",
        message: "nativeFactPatchChangedPaths must be an array.".to_string(),
    })?;
    let mut result = BTreeSet::new();
    for path in paths {
        let path = path
            .as_str()
            .filter(|path| is_portable_repository_path(path))
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "nativeFactPatchChangedPaths must contain portable paths.".to_string(),
            })?;
        if !result.insert(path.to_string()) {
            return Err(NativeProtocolError {
                code: "invalid-structural-fact-patch",
                message: "nativeFactPatchChangedPaths repeats a path.".to_string(),
            });
        }
    }
    Ok(Some(result))
}

// This is intentionally distinct from the shadow persistence endpoint. The
// native lifecycle determines the public graph version from the last complete
// SQLite graph, then uses that version consistently for flows, Context Refs,
// snapshots, and adjacent deltas. JavaScript-provided version numbers are not
// authoritative here.
fn persist_native_public_graph(
    session: &mut NativeProtocolSession,
    params: &mut Value,
) -> Result<Value, NativeProtocolError> {
    let receipt = submit_structural_facts(params)?;
    // The JSONL request is owned by this native process and is not observable
    // after its response. Versioning mutates only non-material context fields,
    // so avoid cloning a complete multi-megabyte fact batch solely to set them.
    persist_native_public_graph_with_receipt(session, params, receipt, true, None)
}

fn persist_native_public_graph_with_receipt(
    session: &mut NativeProtocolSession,
    params: &mut Value,
    receipt: Value,
    retain_persistent_facts: bool,
    verified_topology_digest: Option<String>,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let mut connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-initialize-failed",
        message: error.to_string(),
    })?;
    persist_native_public_graph_with_receipt_using_connection(
        session,
        params,
        receipt,
        retain_persistent_facts,
        verified_topology_digest,
        None,
        &mut connection,
    )
}

fn persist_native_public_graph_with_receipt_using_connection(
    session: &mut NativeProtocolSession,
    params: &mut Value,
    receipt: Value,
    retain_persistent_facts: bool,
    verified_topology_digest: Option<String>,
    changed_record_paths_override: Option<BTreeSet<String>>,
    connection: &mut rusqlite::Connection,
) -> Result<Value, NativeProtocolError> {
    let lifecycle_started = Instant::now();
    let preflight_started = Instant::now();
    let changed_record_paths = match changed_record_paths_override {
        Some(paths) => Some(paths),
        None => native_fact_patch_changed_paths(params)?,
    };
    let project_id = receipt
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing projectId.".to_string(),
        })?;
    let facts_digest = receipt
        .get("factsDigest")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing factsDigest.".to_string(),
        })?;
    let preflight_validation_ms = elapsed_ms(preflight_started);
    let store_preparation_started = Instant::now();
    recover_incomplete_graph_builds(connection, &project_id).map_err(|error| {
        NativeProtocolError {
            code: "store-recovery-failed",
            message: error.to_string(),
        }
    })?;
    let current =
        current_complete_graph(connection, &project_id).map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?;
    let store_preparation_ms = elapsed_ms(store_preparation_started);
    // A structural-shadow store may legitimately have public_graph_version 0.
    // It is not a reusable public CoreClient version: promote it once to 1 so
    // every externally visible graph and Context Ref retains the positive
    // version contract.
    let unchanged = current.as_ref().is_some_and(|graph| {
        graph.material_fingerprint == facts_digest
            && graph.source_fingerprint == facts_digest
            && graph
                .public_graph_version
                .is_some_and(|version| version >= 1)
    });
    let public_graph_version = match current.as_ref() {
        Some(graph) if unchanged => {
            graph
                .public_graph_version
                .ok_or_else(|| NativeProtocolError {
                    code: "store-integrity-failed",
                    message: "Current complete native graph is missing its public graph version."
                        .to_string(),
                })?
        }
        Some(graph) => graph.public_graph_version.unwrap_or(0) + 1,
        None => 1,
    };
    // A no-op refresh needs the newest public envelope (for scan telemetry),
    // but it must not rebuild the structural graph, traverse every Flow Lens,
    // or open a second write transaction merely to discover that the current
    // complete version is reusable.
    if unchanged {
        let current = current.expect("unchanged requires a complete graph");
        versioned_native_lifecycle_params(params, public_graph_version, &facts_digest)?;
        let persistent_payload_cache_hit =
            ensure_persistent_payload(session, connection, &project_id, current.graph_version)?;
        let persistent = session
            .persistent_graph
            .as_ref()
            .expect("persistent payload is ensured");
        // A live CoreClient already owns the exact public collections returned
        // by the previous request. On a no-op, send only the refreshed envelope
        // instead of serializing and transferring the whole graph again. A
        // restarted process has no public snapshot and conservatively returns
        // one complete graph so the caller can establish its local baseline.
        let can_reuse_public_collections =
            persistent_payload_cache_hit && persistent.public_snapshot.is_some();
        let mut public_graph = if can_reuse_public_collections {
            let mut context =
                native_public_graph_context(&persistent.payload, params.get("publicGraphContext"))?;
            context["stats"] = persistent
                .public_snapshot
                .as_ref()
                .expect("public collection reuse requires a cached snapshot")["stats"]
                .clone();
            context
        } else {
            native_public_graph_snapshot_with_public_context(
                &persistent.payload,
                params.get("publicGraphContext"),
            )?
        };
        public_graph["state"]["status"] = Value::String("native-current".to_string());
        public_graph["analysis"]["latestDelta"] = Value::Null;
        let receipt = json!({
            "schemaVersion": "flopeek-native-shadow-store-receipt/v1",
            "stored": true,
            "status": "reused",
            "graphVersion": current.graph_version,
            "projectionDigest": current.compatibility_digest,
            "factsDigest": facts_digest,
            "limitation": "This persists only the validated native structural shadow projection. JavaScript remains authoritative for public graph, Context Ref, and query output.",
        });
        public_graph["analysis"]["graphState"] = json!({
            "schemaVersion": "flopeek-native-graph-state/v1",
            "status": "unchanged",
            "persistence": "sqlite",
            "nativeGraphVersion": current.graph_version,
            "graphVersion": public_graph_version,
            "materialFingerprint": facts_digest,
            "sourceFingerprint": public_graph["state"]["sourceFingerprint"].clone(),
            "sourceRevision": public_graph["state"]["sourceRevision"].clone(),
            "updatedAt": public_graph["state"]["updatedAt"].clone(),
            "latestDelta": Value::Null,
            "limitation": "Native graph versions are retained in the repository-local SQLite store. They identify static graph state and do not prove runtime behavior.",
        });
        let current_batch = structural_batch(params)?;
        let current_topology_digest = match verified_topology_digest {
            Some(digest) => digest,
            None => current_batch
                .as_object()
                .ok_or_else(|| NativeProtocolError {
                    code: "invalid-structural-facts",
                    message: "StructuralFactBatch/v1 must be an object.".to_string(),
                })
                .and_then(|batch| {
                    structural_topology_digest(batch).map_err(|message| NativeProtocolError {
                        code: "invalid-structural-facts",
                        message,
                    })
                })?,
        };
        session.persistent_facts = Some(NativePersistentFacts {
            project_id: project_id.clone(),
            facts_digest: facts_digest.clone(),
            topology_digest: current_topology_digest,
            payload: current_batch.clone(),
        });
        let mut response = json!({
            "schemaVersion": "flopeek-native-public-lifecycle/v1",
            "status": "reused",
            "nativeGraphVersion": current.graph_version,
            "publicGraphVersion": public_graph_version,
            "factsDigest": facts_digest,
            "receipt": receipt,
            "limitation": "Native public lifecycle is an experimental SQLite authority. JavaScript remains the public default and compatibility oracle until the rollout gate passes.",
        });
        if can_reuse_public_collections {
            response["publicGraphReuse"] = json!({
                "schemaVersion": "flopeek-native-public-graph-reuse/v1",
                "envelope": native_public_graph_envelope(&public_graph),
            });
        } else {
            response["graph"] = public_graph;
        }
        return Ok(response);
    }
    let topology_digest = match verified_topology_digest {
        Some(digest) => digest,
        None => structural_batch(params)?
            .as_object()
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 must be an object.".to_string(),
            })
            .and_then(|batch| {
                structural_topology_digest(batch).map_err(|message| NativeProtocolError {
                    code: "invalid-structural-facts",
                    message,
                })
            })?,
    };
    let reuse_previous_projection = current.as_ref().is_some_and(|current| {
        current.material_fingerprint != facts_digest
            && session.persistent_facts.as_ref().is_some_and(|facts| {
                facts.project_id == project_id
                    && facts.facts_digest == current.material_fingerprint
                    && facts.topology_digest == topology_digest
            })
    });
    let isolated_incremental_path = if reuse_previous_projection {
        None
    } else {
        current.as_ref().and_then(|current| {
            session.persistent_facts.as_ref().and_then(|facts| {
                (facts.project_id == project_id
                    && facts.facts_digest == current.material_fingerprint)
                    .then(|| {
                        let previous = facts.payload.as_object()?;
                        let next = structural_batch(params).ok()?.as_object()?;
                        isolated_structural_change_path(previous, next)
                    })
                    .flatten()
            })
        })
    };
    let mut persistent_payload_cache_hit = false;
    let previous_projection = if let Some(previous) = current.as_ref() {
        let cache_hit =
            ensure_persistent_payload(session, connection, &project_id, previous.graph_version)?;
        persistent_payload_cache_hit = cache_hit;
        Some(
            &session
                .persistent_graph
                .as_ref()
                .expect("persistent payload is ensured")
                .payload,
        )
    } else {
        None
    };
    // `cached_or_load_persistent_payload` above may replace the cache. Read
    // its public snapshot only afterwards, when both references are immutable
    // and guaranteed to point at the SQLite-selected prior graph version.
    let previous_public_snapshot = current.as_ref().and_then(|previous| {
        session
            .persistent_graph
            .as_ref()
            .filter(|cached| {
                cached.project_id == project_id && cached.graph_version == previous.graph_version
            })
            .and_then(|cached| cached.public_snapshot.as_ref())
    });
    let versioning_started = Instant::now();
    versioned_native_lifecycle_params(params, public_graph_version, &facts_digest)?;
    let versioning_ms = elapsed_ms(versioning_started);
    let mut stored = persist_structural_graph_internal(
        params,
        connection,
        PersistStructuralGraphOptions {
            validated_receipt: Some(receipt),
            previous_projection,
            previous_public_snapshot,
            reuse_previous_projection,
            isolated_incremental_path: isolated_incremental_path.as_deref(),
            changed_record_paths: changed_record_paths.as_ref(),
        },
    )?;
    let native_graph_version = stored
        .receipt
        .get("graphVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| NativeProtocolError {
            code: "store-promote-failed",
            message: "Native persistence receipt is missing graphVersion.".to_string(),
        })?;
    let projection = stored.projection;
    let mut public_graph = stored.public_snapshot;
    let public_collection_patch = stored.public_collection_patch;
    let snapshot_materialization_ms = stored.public_snapshot_materialization_ms;
    public_graph["state"]["status"] = Value::String(
        if unchanged {
            "native-current"
        } else {
            "native-advanced"
        }
        .to_string(),
    );
    public_graph["analysis"]["latestDelta"] = stored.receipt["adjacentDelta"].clone();
    public_graph["analysis"]["graphState"] = json!({
        "schemaVersion": "flopeek-native-graph-state/v1",
        "status": if unchanged { "unchanged" } else { "advanced" },
        "persistence": "sqlite",
        "nativeGraphVersion": native_graph_version,
        "graphVersion": public_graph_version,
        "materialFingerprint": facts_digest,
        "sourceFingerprint": public_graph["state"]["sourceFingerprint"].clone(),
        "sourceRevision": public_graph["state"]["sourceRevision"].clone(),
        "updatedAt": public_graph["state"]["updatedAt"].clone(),
        "latestDelta": stored.receipt["adjacentDelta"].clone(),
        "limitation": "Native graph versions are retained in the repository-local SQLite store. They identify static graph state and do not prove runtime behavior.",
    });
    if let Some(profile) = stored
        .receipt
        .get_mut("profile")
        .and_then(Value::as_object_mut)
    {
        profile.insert(
            "preflightValidationMs".to_string(),
            json!(preflight_validation_ms),
        );
        profile.insert(
            "storePreparationMs".to_string(),
            json!(store_preparation_ms),
        );
        profile.insert("versioningMs".to_string(), json!(versioning_ms));
        profile.insert(
            "persistentPayloadCacheHit".to_string(),
            Value::Bool(persistent_payload_cache_hit),
        );
        profile.insert(
            "incrementalStructuralPath".to_string(),
            isolated_incremental_path
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        profile.insert(
            "structuralRecordCacheWriteMode".to_string(),
            Value::String(
                if changed_record_paths.is_some() {
                    "changed-paths"
                } else {
                    "full-batch"
                }
                .to_string(),
            ),
        );
        profile.insert(
            "structuralRecordCacheWritePaths".to_string(),
            json!(changed_record_paths.as_ref().map_or(0, BTreeSet::len)),
        );
        profile.insert(
            "snapshotMaterializationMs".to_string(),
            json!(snapshot_materialization_ms),
        );
        profile.insert(
            "nativePublicLifecycleTotalMs".to_string(),
            json!(elapsed_ms(lifecycle_started)),
        );
    }
    let reuses_public_graph = stored
        .receipt
        .get("profile")
        .and_then(|profile| profile.get("reusedStructuralProjection"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reused_public_snapshot = stored
        .receipt
        .get("profile")
        .and_then(|profile| profile.get("previousPublicSnapshotCacheHit"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // Session caches are derived from the just-committed SQLite graph. Keep
    // their cost separate from promotion: the cache is needed for the next
    // compact fact patch, but it must not be misreported as a database write
    // or JSONL transport delay.
    let session_graph_cache_started = Instant::now();
    if reuses_public_graph && reused_public_snapshot {
        // Keep the already-materialized collections in memory and replace only
        // the envelope. This is a derived cache update; SQLite has already
        // committed the new complete projection above.
        let cached = session
            .persistent_graph
            .as_mut()
            .expect("source-only snapshot reuse requires the prior process cache");
        cached.project_id = project_id.clone();
        cached.graph_version = native_graph_version;
        cached.payload = projection;
        let snapshot = cached
            .public_snapshot
            .as_mut()
            .expect("source-only snapshot reuse requires public collections");
        let snapshot_object = snapshot
            .as_object_mut()
            .expect("cached public snapshot remains an object");
        for (key, value) in public_graph
            .as_object()
            .expect("public reuse envelope remains an object")
        {
            if !NATIVE_PUBLIC_GRAPH_COLLECTIONS
                .iter()
                .any(|(collection, _)| key == collection)
            {
                snapshot_object.insert(key.clone(), value.clone());
            }
        }
    } else {
        session.persistent_graph = Some(NativePersistentGraph {
            project_id: project_id.clone(),
            graph_version: native_graph_version,
            payload: projection,
            public_snapshot: Some(public_graph.clone()),
        });
    }
    let session_graph_cache_ms = elapsed_ms(session_graph_cache_started);
    let session_facts_cache_started = Instant::now();
    if retain_persistent_facts {
        session.persistent_facts = Some(NativePersistentFacts {
            project_id: project_id.clone(),
            facts_digest: facts_digest.clone(),
            topology_digest,
            payload: structural_batch(params)?.clone(),
        });
    }
    let session_facts_cache_ms = elapsed_ms(session_facts_cache_started);
    if let Some(profile) = stored
        .receipt
        .get_mut("profile")
        .and_then(Value::as_object_mut)
    {
        profile.insert(
            "sessionGraphCacheUpdateMs".to_string(),
            json!(session_graph_cache_ms),
        );
        profile.insert(
            "sessionFactsCacheUpdateMs".to_string(),
            json!(session_facts_cache_ms),
        );
        profile.insert(
            "sessionCacheUpdateMs".to_string(),
            json!(session_graph_cache_ms.saturating_add(session_facts_cache_ms)),
        );
    }
    let response_assembly_started = Instant::now();
    let public_graph_reuse = if reuses_public_graph {
        Some(json!({
            "schemaVersion": "flopeek-native-public-graph-reuse/v1",
            "envelope": native_public_graph_envelope(&public_graph),
        }))
    } else {
        None
    };
    let public_graph_patch = if public_graph_reuse.is_none() {
        public_collection_patch.and_then(|collections| {
            let patch = json!({
                "schemaVersion": "flopeek-native-public-graph-patch/v1",
                "envelope": native_public_graph_envelope(&public_graph),
                "collections": collections,
            });
            // A patch is a transport optimization, not a second graph
            // representation. Fall back to the complete graph whenever its
            // JSON would not be smaller than the exact public response.
            (serde_json::to_vec(&patch).ok()?.len() < serde_json::to_vec(&public_graph).ok()?.len())
                .then_some(patch)
        })
    } else {
        None
    };
    let mut response = json!({
        "schemaVersion": "flopeek-native-public-lifecycle/v1",
        "status": if unchanged { "reused" } else { "promoted" },
        "nativeGraphVersion": native_graph_version,
        "publicGraphVersion": public_graph_version,
        "factsDigest": facts_digest,
        "receipt": stored.receipt,
        "limitation": "Native public lifecycle is an experimental SQLite authority. JavaScript remains the public default and compatibility oracle until the rollout gate passes.",
    });
    if let Some(reuse) = public_graph_reuse {
        response["publicGraphReuse"] = reuse;
    } else if let Some(patch) = public_graph_patch {
        response["publicGraphPatch"] = patch;
    } else {
        response["graph"] = public_graph;
    }
    if let Some(profile) = response
        .get_mut("receipt")
        .and_then(|receipt| receipt.get_mut("profile"))
        .and_then(Value::as_object_mut)
    {
        profile.insert(
            "responseAssemblyMs".to_string(),
            json!(elapsed_ms(response_assembly_started)),
        );
        profile.insert(
            "nativePublicLifecycleReturnMs".to_string(),
            json!(elapsed_ms(lifecycle_started)),
        );
    }
    Ok(response)
}

// The cache-disabled counterpart to persist_native_public_graph. It uses the
// same fact validation, public graph assembly, version-neutral material
// fingerprint, and adjacent-delta implementation, but deliberately never
// resolves projectRoot or opens SQLite. Its authority ends with this JSONL
// process, which is the exact lifetime advertised by cache-disabled Context
// Refs.
fn refresh_native_session_graph(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let started = Instant::now();
    let receipt = submit_structural_facts(params)?;
    let fact_validation_ms = elapsed_ms(started);
    let project_id = receipt
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing projectId.".to_string(),
        })?;
    let facts_digest = receipt
        .get("factsDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 receipt is missing factsDigest.".to_string(),
        })?;
    let topology_digest = params
        .as_object()
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 must be an object.".to_string(),
        })
        .and_then(|batch| {
            structural_topology_digest(batch).map_err(|message| NativeProtocolError {
                code: "invalid-structural-facts",
                message,
            })
        })?;
    let previous = session.graphs.get(project_id).cloned();
    let unchanged = previous
        .as_ref()
        .is_some_and(|graph| graph.facts_digest == facts_digest);
    let public_graph_version = match previous.as_ref() {
        Some(graph) if unchanged => graph.public_graph_version,
        Some(graph) => graph.public_graph_version + 1,
        None => 1,
    };
    let versioning_ms = elapsed_ms(started) - fact_validation_ms;
    let mut versioned = params.clone();
    versioned_native_lifecycle_params(&mut versioned, public_graph_version, facts_digest)?;
    let assembly_started = Instant::now();
    let payload = assemble_native_public_payload(&versioned)?;
    let public_assembly_ms = elapsed_ms(assembly_started);
    let snapshot_started = Instant::now();
    let mut graph = native_public_graph_snapshot(&payload)?;
    let snapshot_materialization_ms = elapsed_ms(snapshot_started);
    let delta_started = Instant::now();
    let reuses_public_collections = previous
        .as_ref()
        .is_some_and(|previous| previous.topology_digest == topology_digest);
    let adjacent_delta = if unchanged {
        None
    } else {
        previous
            .as_ref()
            .map(|previous| {
                if reuses_public_collections {
                    let previous_graph = native_public_graph_snapshot(&previous.payload)?;
                    native_public_graph_delta_with_reused_collections(
                        &previous.payload,
                        &previous_graph,
                        &payload,
                        &graph,
                        &previous_graph,
                    )
                } else {
                    native_public_graph_delta(&previous.payload, &payload)
                }
            })
            .transpose()?
    };
    let delta_ms = elapsed_ms(delta_started);
    graph["state"]["status"] = Value::String(
        if unchanged {
            "session-current"
        } else {
            "session-advanced"
        }
        .to_string(),
    );
    graph["analysis"]["latestDelta"] = adjacent_delta.clone().unwrap_or(Value::Null);
    graph["analysis"]["graphState"] = json!({
        "schemaVersion": "flopeek-native-graph-state/v1",
        "status": if unchanged { "unchanged" } else { "advanced" },
        "persistence": "session-memory",
        "nativeGraphVersion": Value::Null,
        "graphVersion": public_graph_version,
        "materialFingerprint": facts_digest,
        "sourceFingerprint": graph["state"]["sourceFingerprint"].clone(),
        "sourceRevision": graph["state"]["sourceRevision"].clone(),
        "updatedAt": graph["state"]["updatedAt"].clone(),
        "latestDelta": adjacent_delta.clone(),
        "limitation": "This graph is retained only in the native JSONL process for a cache-disabled session. It never creates repository metadata or a SQLite database and cannot resolve after the process closes.",
    });
    let session_graph = NativeSessionGraph {
        facts_digest: facts_digest.to_string(),
        topology_digest,
        public_graph_version,
        payload: Arc::new(payload),
        query_batch: Arc::new(params.clone()),
    };
    session
        .graphs
        .insert(project_id.to_string(), session_graph.clone());
    session.session_query_graphs.insert(
        native_session_graph_key(project_id, public_graph_version),
        session_graph,
    );
    let mut response = json!({
        "schemaVersion": "flopeek-native-session-lifecycle/v1",
        "status": if unchanged { "reused" } else { "promoted" },
        "persistence": "session-memory",
        "publicGraphVersion": public_graph_version,
        "factsDigest": facts_digest,
        "graphHandle": {
            "schemaVersion": "flopeek-native-session-graph-handle/v1",
            "projectId": project_id,
            "factsDigest": facts_digest,
            "persistence": "session-memory",
            "publicGraphVersion": public_graph_version,
        },
        "profile": {
            "schemaVersion": "flopeek-native-session-lifecycle-profile/v1",
            "factValidationMs": fact_validation_ms,
            "versioningMs": versioning_ms,
            "publicAssemblyMs": public_assembly_ms,
            "snapshotMaterializationMs": snapshot_materialization_ms,
            "deltaMs": delta_ms,
            "totalMs": elapsed_ms(started),
        },
        "limitation": "Native cache-disabled lifecycle is process-local. JavaScript remains the public default and compatibility oracle until the rollout gate passes.",
    });
    if reuses_public_collections {
        // The public collections are immutable for this exact fact digest.
        // Keep the cache-disabled contract compact on an explicit no-op just
        // like the persistent SQLite lifecycle: Node owns the previous public
        // snapshot and receives only a versioned envelope for its mutable
        // state/analysis fields.
        response["publicGraphReuse"] = json!({
            "schemaVersion": "flopeek-native-public-graph-reuse/v1",
            "envelope": native_public_graph_envelope(&graph),
        });
    } else {
        response["graph"] = graph;
    }
    Ok(response)
}

fn get_native_structural_delta(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativeStructuralDelta requires params.projectId.".to_string(),
        })?;
    let parse_version = |name: &str| -> Result<i64, NativeProtocolError> {
        params
            .get(name)
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-params",
                message: format!(
                    "getNativeStructuralDelta requires a non-negative integer params.{name}."
                ),
            })
    };
    let from_graph_version = parse_version("fromGraphVersion")?;
    let to_graph_version = parse_version("toGraphVersion")?;
    if to_graph_version <= from_graph_version {
        return Err(NativeProtocolError {
            code: "invalid-params",
            message:
                "getNativeStructuralDelta requires toGraphVersion greater than fromGraphVersion."
                    .to_string(),
        });
    }
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let delta = complete_graph_delta(
        &connection,
        project_id,
        from_graph_version,
        to_graph_version,
    )
    .map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    Ok(json!({
        "schemaVersion": "flopeek-native-structural-delta-result/v1",
        "projectId": project_id,
        "fromGraphVersion": from_graph_version,
        "toGraphVersion": to_graph_version,
        "available": delta.is_some(),
        "delta": delta,
        "limitation": "This reads a retained public-compatible graph delta by native storage version. It is a shadow verification surface, not the public changed-context API.",
    }))
}

fn native_public_node(node: &StructuralGraphNode) -> Value {
    let mut value = node
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    value.insert("id".to_string(), Value::String(node.id.clone()));
    value.insert("kind".to_string(), Value::String(node.kind.clone()));
    value.insert("type".to_string(), Value::String(node.node_type.clone()));
    value.insert(
        "path".to_string(),
        node.path
            .as_ref()
            .map(|path| Value::String(path.clone()))
            .unwrap_or(Value::Null),
    );
    Value::Object(value)
}

fn native_public_edge(edge: &crate::structural_graph::StructuralGraphEdge) -> Value {
    json!({
        "source": &edge.source,
        "target": &edge.target,
        "type": &edge.edge_type,
        "confidence": edge.confidence.clone().unwrap_or(Value::Null),
        "evidence": edge.evidence.clone().unwrap_or(Value::Null),
    })
}

// Counts are a projection of the topology the native core has just assembled,
// never a JavaScript graph hint. Coverage-only counters remain parser facts
// supplied in the public envelope.
fn native_public_stats(snapshot: &StructuralGraphSnapshot, analysis: &Value) -> Value {
    let summary = analysis
        .get("coverage")
        .and_then(Value::as_object)
        .and_then(|coverage| coverage.get("summary"))
        .and_then(Value::as_object);
    let coverage_count = |key: &str| {
        summary
            .and_then(|summary| summary.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    json!({
        "scannedFiles": coverage_count("scannedFiles"),
        "nodes": snapshot.nodes.len(),
        "edges": snapshot.edges.len(),
        "services": snapshot.nodes.iter().filter(|node| node.node_type == "service").count(),
        "classes": snapshot.nodes.iter().filter(|node| node.kind == "symbol" && node.node_type == "class").count(),
        "functions": snapshot.nodes.iter().filter(|node| node.kind == "symbol" && node.node_type == "function").count(),
        "calls": snapshot.edges.iter().filter(|edge| edge.edge_type == "calls").count(),
        "endpoints": snapshot.nodes.iter().filter(|node| node.kind == "endpoint").count(),
        "commandEntries": snapshot.nodes.iter().filter(|node| node.kind == "command"
            && matches!(metadata_string(node, "entryKind").as_deref(), Some("package-script") | Some("django-management-command") | Some("framework-command"))).count(),
        "scheduledEntries": snapshot.nodes.iter().filter(|node| node.kind == "schedule"
            && metadata_string(node, "entryKind").as_deref() == Some("node-cron-schedule")).count(),
        "tests": snapshot.nodes.iter().filter(|node| node.node_type == "test").count(),
        "runtimeDependencies": snapshot.nodes.iter().filter(|node| metadata_string(node, "layer").as_deref() == Some("runtime")).count(),
        "parsedFiles": coverage_count("parsedFiles"),
        "inventoryOnlyFiles": coverage_count("inventoryOnlyFiles"),
        "parseFailedFiles": coverage_count("parseFailedFiles"),
    })
}

fn native_public_graph_snapshot_with_public_context(
    payload: &Value,
    public_graph_context: Option<&Value>,
) -> Result<Value, NativeProtocolError> {
    let snapshot = structural_graph_snapshot(payload).map_err(|message| NativeProtocolError {
        code: "store-read-failed",
        message,
    })?;
    native_public_graph_snapshot_from_snapshot(&snapshot, payload, public_graph_context)
}

// This is deliberately separate from collection materialization. A
// source-only lifecycle advances project/state/refresh metadata while its
// public node, edge, and flow collections are already proven reusable.
fn native_public_graph_context(
    payload: &Value,
    public_graph_context: Option<&Value>,
) -> Result<Value, NativeProtocolError> {
    let flow_context = payload.get("flowContext").cloned().unwrap_or(Value::Null);
    let lifecycle = payload
        .get("lifecycleContext")
        .cloned()
        .unwrap_or(Value::Null);
    let project_id = payload
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Native snapshot is missing projectId.".to_string(),
        })?;
    let graph_version = flow_context
        .get("graphVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Native snapshot is missing flowContext.graphVersion.".to_string(),
        })?;
    Ok(public_graph_context
        .filter(|context| context.is_object())
        .or_else(|| {
            payload
                .get("publicGraphContext")
                .filter(|context| context.is_object())
        })
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "project": { "projectId": project_id },
                "state": {
                    "graphVersion": graph_version,
                    "sourceFingerprint": lifecycle["sourceFingerprint"].clone(),
                    "sourceRevision": flow_context["sourceRevision"].clone(),
                    "updatedAt": lifecycle["updatedAt"].clone(),
                },
                "analysis": {
                    "refresh": lifecycle["refresh"].clone(),
                    "coverage": lifecycle["coverage"].clone(),
                },
            })
        }))
}

fn native_public_graph_snapshot_from_snapshot(
    snapshot: &StructuralGraphSnapshot,
    payload: &Value,
    public_graph_context: Option<&Value>,
) -> Result<Value, NativeProtocolError> {
    let mut result = native_public_graph_context(payload, public_graph_context)?;
    let mut nodes = snapshot.nodes.iter().collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        javascript_ascii_locale_cmp(
            &metadata_string(left, "label").unwrap_or_else(|| left.id.clone()),
            &metadata_string(right, "label").unwrap_or_else(|| right.id.clone()),
        )
        .then_with(|| javascript_ascii_cmp(&left.id, &right.id))
    });
    let traversal_order = payload
        .get("nativeTraversalOrder")
        .and_then(Value::as_object)
        .map(|order| {
            order
                .iter()
                .filter_map(|(key, index)| {
                    index.as_u64().map(|index| (key.as_str(), index as usize))
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut edges = snapshot.edges.iter().collect::<Vec<_>>();
    edges.sort_by(|left, right| {
        let left_key = native_edge_key(left);
        let right_key = native_edge_key(right);
        traversal_order
            .get(left_key.as_str())
            .copied()
            .unwrap_or(usize::MAX)
            .cmp(
                &traversal_order
                    .get(right_key.as_str())
                    .copied()
                    .unwrap_or(usize::MAX),
            )
            .then_with(|| javascript_ascii_cmp(&left_key, &right_key))
    });
    result["nodes"] = Value::Array(
        nodes
            .into_iter()
            .map(native_public_node)
            .collect::<Vec<_>>(),
    );
    result["edges"] = Value::Array(
        edges
            .into_iter()
            .map(native_public_edge)
            .collect::<Vec<_>>(),
    );
    result["stats"] = native_public_stats(snapshot, &result["analysis"]);
    result["flows"] = payload["flows"].clone();
    result["diagnosticFlows"] = payload["diagnosticFlows"].clone();
    Ok(result)
}

fn native_public_graph_snapshot(payload: &Value) -> Result<Value, NativeProtocolError> {
    native_public_graph_snapshot_with_public_context(payload, None)
}

// Build the source-safe native projection directly from a verified fact batch.
// This deliberately opens no SQLite store and is shared by the ephemeral
// public-graph probe and the process-local cache-disabled lifecycle.
fn assemble_native_public_payload(params: &Value) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let projection = build_structural_graph(batch).map_err(|message| NativeProtocolError {
        code: "structural-graph-failed",
        message,
    })?;
    let traversal_order = structural_edge_traversal_order(batch, &projection);
    let mut payload = serde_json::to_value(&projection).map_err(|error| NativeProtocolError {
        code: "structural-graph-serialize-failed",
        message: error.to_string(),
    })?;
    payload["projectId"] = batch["projectId"].clone();
    payload["flowContext"] = batch["flowContext"].clone();
    payload["lifecycleContext"] = batch["lifecycleContext"].clone();
    payload["publicGraphContext"] = batch["publicGraphContext"].clone();
    payload["nativeTraversalOrder"] =
        serde_json::to_value(traversal_order).map_err(|error| NativeProtocolError {
            code: "structural-graph-serialize-failed",
            message: error.to_string(),
        })?;
    // This cache-disabled path must derive the same public result as the
    // persistent lifecycle, but it does not need to rebuild the identical
    // structural projection for primary flows, every Flow Lens, and diagnostic
    // flows. Reuse the one verified projection throughout this request.
    let (primary_tests, primary_fixtures) = configured_flow_scope(batch, "primary");
    let flows =
        assemble_native_flows_from_projection(batch, &projection, primary_tests, primary_fixtures);
    let flow_entries = flows.as_array().ok_or_else(|| NativeProtocolError {
        code: "flow-assembly-failed",
        message: "Native primary flows must be an array.".to_string(),
    })?;
    let flow_lenses = flow_entries
        .iter()
        .filter_map(|flow| flow["id"].as_str())
        .map(|flow_id| {
            native_flow_lens_from_assembled(batch, flow_entries, &projection, flow_id, 12)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (diagnostic_tests, diagnostic_fixtures) = configured_flow_scope(batch, "diagnostic");
    let diagnostic_flows = assemble_native_flows_from_projection(
        batch,
        &projection,
        diagnostic_tests,
        diagnostic_fixtures,
    );
    payload["flows"] = flows;
    payload["diagnosticFlows"] = diagnostic_flows;
    payload["flowLenses"] = Value::Array(flow_lenses);
    Ok(payload)
}

// Build the complete public graph directly from a verified fact batch. This is
// deliberately ephemeral: it opens no SQLite store and is therefore safe for
// --no-cache/package-scoped sessions as well as shadow parity probes.
fn assemble_native_public_graph(params: &Value) -> Result<Value, NativeProtocolError> {
    let payload = assemble_native_public_payload(params)?;
    Ok(json!({
        "schemaVersion": "flopeek-native-public-graph/v1",
        "graph": native_public_graph_snapshot(&payload)?,
        "persistence": "ephemeral-jsonl-only",
        "limitation": "This is a native graph reconstruction for shadow parity and cache-disabled sessions. JavaScript remains the public default until the rollout gate passes.",
    }))
}

fn same_canonical_json(left: &Value, right: &Value) -> bool {
    // `serde_json::Value` equality retains JSON semantics: object members are
    // compared as a map (regardless of insertion order), while array order is
    // significant. The former recursive canonicalizer only cloned complete
    // graph values before asking this same question, making adjacent-delta
    // calculation scale with payload size without changing its answer.
    left == right
}

fn same_json_object_fields(left: &Value, right: &Value, fields: &[&str]) -> bool {
    fields.iter().all(|field| left[*field] == right[*field])
}

fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn member_summary_value(node: &Value) -> Value {
    json!({
        "id": node["id"].clone(),
        "label": node["label"].clone(),
        "type": node["type"].clone(),
        "kind": node["kind"].clone(),
        "path": node["path"].clone(),
    })
}

fn edge_summary_value(edge: &Value) -> Value {
    json!({
        "source": edge["source"].clone(),
        "target": edge["target"].clone(),
        "type": edge["type"].clone(),
        "confidence": edge["confidence"].clone(),
    })
}

fn flow_summary_value(flow: &Value) -> Value {
    json!({
        "id": flow["id"].clone(),
        "title": flow["title"].clone(),
        "entryId": flow["entryId"].clone(),
        "entry": flow["entry"].clone(),
        "steps": flow["steps"].as_array().into_iter().flatten().map(|step| json!({"id":step["id"].clone(),"depth":step["depth"].clone()})).collect::<Vec<_>>(),
    })
}

fn compared_items(
    previous: &[Value],
    current: &[Value],
    key: impl Fn(&Value) -> String,
    summarize: impl Fn(&Value) -> Value,
) -> ComparedItems {
    let previous_by_key = previous
        .iter()
        .map(|value| (key(value), value))
        .collect::<std::collections::BTreeMap<_, _>>();
    let current_by_key = current
        .iter()
        .map(|value| (key(value), value))
        .collect::<std::collections::BTreeMap<_, _>>();
    let added_keys = current_by_key
        .keys()
        .filter(|key| !previous_by_key.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    let removed_keys = previous_by_key
        .keys()
        .filter(|key| !current_by_key.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    let changed_keys = current_by_key
        .keys()
        .filter(|key| {
            previous_by_key
                .get(*key)
                .is_some_and(|previous| !same_canonical_json(previous, current_by_key[*key]))
        })
        .cloned()
        .collect::<Vec<_>>();
    let limited = |keys: &[String], values: &std::collections::BTreeMap<String, &Value>| {
        keys.iter()
            .take(100)
            .map(|key| summarize(values[key]))
            .collect::<Vec<_>>()
    };
    let truncated = added_keys.len() > 100 || removed_keys.len() > 100 || changed_keys.len() > 100;
    (
        limited(&added_keys, &current_by_key),
        limited(&removed_keys, &previous_by_key),
        limited(&changed_keys, &current_by_key),
        (added_keys.len(), removed_keys.len(), changed_keys.len()),
        truncated,
    )
}

fn unique_sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn transition_ids(step: &Value) -> Vec<String> {
    let primary = step["transition"]["id"].as_str().map(ToString::to_string);
    let alternatives = step["alternativeIncomingTransitions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value["id"].as_str().map(ToString::to_string));
    let branches = step["branch"]["transitions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value["id"].as_str().map(ToString::to_string));
    unique_sorted(primary.into_iter().chain(alternatives).chain(branches))
}

fn flow_lens_snapshot(payload: &Value, flow_id: &str) -> Option<Value> {
    let lens = payload["flowLenses"]
        .as_array()?
        .iter()
        .find(|lens| lens["flow"]["id"] == flow_id)?;
    Some(
        json!({"schemaVersion":"flopeek-flow-lens-snapshot/v1","id":lens["id"].clone(),"project":lens["project"].clone(),"flow":lens["flow"].clone(),"knowledgeClass":lens["knowledgeClass"].clone(),"confidence":lens["confidence"].clone(),"steps":lens["steps"].clone(),"staticBoundaries":lens["staticBoundaries"].clone(),"truncation":lens["truncation"].clone(),"limitations":lens["limitations"].clone()}),
    )
}

fn flow_comparison_changes(
    before: Option<&Value>,
    current: Option<&Value>,
    changed_step_ids: &[String],
) -> Value {
    let steps = |lens: Option<&Value>| {
        lens.and_then(|lens| lens["steps"].as_array())
            .cloned()
            .unwrap_or_default()
    };
    let before_by_id = steps(before)
        .into_iter()
        .map(|step| (value_string(&step, "id"), step))
        .collect::<std::collections::BTreeMap<_, _>>();
    let current_by_id = steps(current)
        .into_iter()
        .map(|step| (value_string(&step, "id"), step))
        .collect::<std::collections::BTreeMap<_, _>>();
    let added = current_by_id
        .keys()
        .filter(|id| !before_by_id.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let removed = before_by_id
        .keys()
        .filter(|id| !current_by_id.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let shared = current_by_id
        .keys()
        .filter(|id| before_by_id.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let moved = shared
        .iter()
        .filter(|id| before_by_id[*id]["depth"] != current_by_id[*id]["depth"])
        .cloned()
        .collect::<Vec<_>>();
    let transitions = shared
        .iter()
        .filter(|id| transition_ids(&before_by_id[*id]) != transition_ids(&current_by_id[*id]))
        .cloned()
        .collect::<Vec<_>>();
    let metadata = shared
        .iter()
        .filter(|id| {
            !same_json_object_fields(
                &before_by_id[*id],
                &current_by_id[*id],
                &["node", "role", "staticBoundary"],
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let source_changed = unique_sorted(
        changed_step_ids
            .iter()
            .filter(|id| current_by_id.contains_key(*id))
            .cloned(),
    );
    let changed = unique_sorted(
        added
            .iter()
            .chain(removed.iter())
            .chain(moved.iter())
            .chain(transitions.iter())
            .chain(metadata.iter())
            .chain(source_changed.iter())
            .cloned(),
    );
    let unchanged = shared
        .into_iter()
        .filter(|id| !changed.contains(id))
        .collect::<Vec<_>>();
    let all_transitions = |map: &std::collections::BTreeMap<String, Value>| {
        unique_sorted(map.values().flat_map(transition_ids))
    };
    let before_transitions = all_transitions(&before_by_id);
    let current_transitions = all_transitions(&current_by_id);
    let added_transitions = current_transitions
        .iter()
        .filter(|id| !before_transitions.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    let removed_transitions = before_transitions
        .iter()
        .filter(|id| !current_transitions.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    let flow_metadata_changed = match (before, current) {
        (Some(before), Some(current)) => !same_json_object_fields(
            &before["flow"],
            &current["flow"],
            &["id", "title", "entryId", "entry"],
        ),
        _ => false,
    };
    let static_structure_changed = !added.is_empty()
        || !removed.is_empty()
        || !moved.is_empty()
        || !transitions.is_empty()
        || !metadata.is_empty()
        || !added_transitions.is_empty()
        || !removed_transitions.is_empty()
        || flow_metadata_changed;
    json!({"addedStepIds":added,"removedStepIds":removed,"movedStepIds":moved,"nodeMetadataChangedStepIds":metadata,"transitionChangedStepIds":transitions,"sourceChangedStepIds":source_changed,"unchangedStepIds":unchanged,"addedTransitionIds":added_transitions,"removedTransitionIds":removed_transitions,"flowMetadataChanged":flow_metadata_changed,"staticStructureChanged":static_structure_changed,"sourceChangedOnly":!source_changed.is_empty() && !static_structure_changed})
}

fn native_public_graph_delta(
    previous_payload: &Value,
    current_payload: &Value,
) -> Result<Value, NativeProtocolError> {
    let previous = native_public_graph_snapshot(previous_payload)?;
    let current = native_public_graph_snapshot(current_payload)?;
    native_public_graph_delta_from_public_snapshots(
        previous_payload,
        &previous,
        current_payload,
        &current,
    )
}

fn native_public_graph_delta_from_public_snapshots(
    previous_payload: &Value,
    previous: &Value,
    current_payload: &Value,
    current: &Value,
) -> Result<Value, NativeProtocolError> {
    native_public_graph_delta_with_collection_baseline(
        previous_payload,
        previous,
        current_payload,
        current,
        None,
    )
}

// Structural projection reuse is a stronger invariant than a matching count:
// the regular lifecycle has already proved that all four public collections
// are reusable. Reuse the cached collections for both sides of the delta while
// comparing the old/new public envelopes independently.
fn native_public_graph_delta_with_reused_collections(
    previous_payload: &Value,
    previous: &Value,
    current_payload: &Value,
    current: &Value,
    collections: &Value,
) -> Result<Value, NativeProtocolError> {
    native_public_graph_delta_with_collection_baseline(
        previous_payload,
        previous,
        current_payload,
        current,
        Some(collections),
    )
}

fn native_public_graph_delta_with_collection_baseline(
    previous_payload: &Value,
    previous: &Value,
    current_payload: &Value,
    current: &Value,
    collection_baseline: Option<&Value>,
) -> Result<Value, NativeProtocolError> {
    // Delta calculation only reads these public arrays. Borrowing avoids a
    // second full graph-sized clone on every refresh before comparison and
    // preserves the exact canonical summaries emitted below.
    let baseline = collection_baseline.unwrap_or(previous);
    let previous_nodes = baseline["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let current_nodes = collection_baseline.unwrap_or(current)["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let previous_edges = baseline["edges"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let current_edges = collection_baseline.unwrap_or(current)["edges"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let previous_flows = baseline["flows"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let current_flows = collection_baseline.unwrap_or(current)["flows"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let (node_added, node_removed, node_changed, node_total, node_truncated) = compared_items(
        previous_nodes,
        current_nodes,
        |node| value_string(node, "id"),
        member_summary_value,
    );
    let edge_key = |edge: &Value| {
        format!(
            "{}\0{}\0{}",
            value_string(edge, "source"),
            value_string(edge, "target"),
            value_string(edge, "type")
        )
    };
    let (edge_added, edge_removed, edge_changed, edge_total, edge_truncated) =
        compared_items(previous_edges, current_edges, edge_key, edge_summary_value);
    let (flow_added, flow_removed, flow_changed, flow_total, flow_truncated) = compared_items(
        previous_flows,
        current_flows,
        |flow| value_string(flow, "id"),
        flow_summary_value,
    );
    let mut changed_paths = current["analysis"]["refresh"]["changedPaths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|path| path.replace('\\', "/").trim().to_string())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    changed_paths.sort();
    changed_paths.dedup();
    let changed_node_ids = node_added
        .iter()
        .chain(node_changed.iter())
        .filter_map(|node| node["id"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut affected_nodes = current_nodes
        .iter()
        .filter(|node| {
            changed_node_ids.contains(node["id"].as_str().unwrap_or_default())
                || node["path"]
                    .as_str()
                    .is_some_and(|path| changed_paths.iter().any(|changed| changed == path))
        })
        .map(member_summary_value)
        .collect::<Vec<_>>();
    affected_nodes.sort_by_key(|node| value_string(node, "id"));
    let affected_truncated = affected_nodes.len() > 100;
    affected_nodes.truncate(100);
    let mut context_nodes = std::collections::BTreeMap::<String, Value>::new();
    for node in &node_added {
        context_nodes.insert(
            value_string(node, "id"),
            json!({"status":"added","changeScope":"topology","node":node}),
        );
    }
    for node in &node_changed {
        context_nodes.insert(
            value_string(node, "id"),
            json!({"status":"changed","changeScope":"node-structure","node":node}),
        );
    }
    for node in &node_removed {
        context_nodes.insert(
            value_string(node, "id"),
            json!({"status":"removed","changeScope":"topology","node":node}),
        );
    }
    for node in &affected_nodes {
        context_nodes.entry(value_string(node, "id")).or_insert_with(|| json!({"status":"source-changed","changeScope":if node["kind"] == "file" { "file-content-only" } else { "node-content-only" },"node":node}));
    }
    let context_nodes_all = context_nodes.into_values().collect::<Vec<_>>();
    let context_nodes_truncated = context_nodes_all.len() > 100 || affected_truncated;
    let context_nodes = context_nodes_all
        .iter()
        .take(100)
        .cloned()
        .collect::<Vec<_>>();
    let changed_context_node_ids = context_nodes
        .iter()
        .filter_map(|item| item["node"]["id"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut context_flows = std::collections::BTreeMap::<String, Value>::new();
    for flow in &flow_added {
        context_flows.insert(
            value_string(flow, "id"),
            json!({"status":"added","flow":flow,"changedStepIds":[]}),
        );
    }
    for flow in &flow_changed {
        context_flows.insert(
            value_string(flow, "id"),
            json!({"status":"changed","flow":flow,"changedStepIds":[]}),
        );
    }
    for flow in &flow_removed {
        context_flows.insert(
            value_string(flow, "id"),
            json!({"status":"removed","flow":flow,"changedStepIds":[]}),
        );
    }
    let current_nodes_by_id = current_nodes
        .iter()
        .map(|node| (value_string(node, "id"), node))
        .collect::<std::collections::BTreeMap<_, _>>();
    for flow in current_flows {
        let changed_steps = flow["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|step| {
                changed_context_node_ids.contains(step["id"].as_str().unwrap_or_default())
                    || current_nodes_by_id
                        .get(step["id"].as_str().unwrap_or_default())
                        .and_then(|node| node["path"].as_str())
                        .is_some_and(|path| changed_paths.iter().any(|changed| changed == path))
            })
            .filter_map(|step| step["id"].as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        if !changed_steps.is_empty() {
            context_flows.entry(value_string(flow, "id")).or_insert_with(|| json!({"status":"affected","flow":flow_summary_value(flow),"changedStepIds":changed_steps.clone()}))["changedStepIds"] = Value::Array(changed_steps.clone().into_iter().map(Value::String).collect());
        }
    }
    let context_flows_all = context_flows.into_values().collect::<Vec<_>>();
    let context_flows_truncated = context_flows_all.len() > 100 || flow_truncated;
    let context_flows = context_flows_all
        .iter()
        .take(100)
        .cloned()
        .collect::<Vec<_>>();
    let previous_flow_map = previous_flows
        .iter()
        .map(|flow| (value_string(flow, "id"), flow))
        .collect::<std::collections::BTreeMap<_, _>>();
    let current_flow_map = current_flows
        .iter()
        .map(|flow| (value_string(flow, "id"), flow))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut comparisons = Vec::new();
    for item in &context_flows {
        if comparisons.len() >= 12 {
            break;
        }
        let id = value_string(&item["flow"], "id");
        let before = flow_lens_snapshot(previous_payload, &id);
        let after = flow_lens_snapshot(current_payload, &id);
        let flow = current_flow_map
            .get(&id)
            .copied()
            .or_else(|| previous_flow_map.get(&id).copied())
            .unwrap_or(&item["flow"]);
        let changed_steps = item["changedStepIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        comparisons.push(json!({"id":format!("flow-comparison:{id}@{}-{}",previous["state"]["graphVersion"],current["state"]["graphVersion"]),"flow":{"id":flow["id"].clone(),"title":flow["title"].clone(),"entryId":flow["entryId"].clone(),"entry":flow["entry"].clone()},"status":item["status"].clone(),"before":before,"current":after,"changes":flow_comparison_changes(before.as_ref(), after.as_ref(), &changed_steps),"evidence":{"kind":"adjacent-graph-delta","fromGraphVersion":previous["state"]["graphVersion"].clone(),"toGraphVersion":current["state"]["graphVersion"].clone()}}));
    }
    let comparisons_truncated =
        context_flows_all.len() > comparisons.len() || context_flows_truncated;
    let topology_changed =
        node_total.0 + node_total.1 + edge_total.0 + edge_total.1 + flow_total.0 + flow_total.1 > 0;
    let coverage_changed = !same_canonical_json(
        &previous["analysis"]["coverage"],
        &current["analysis"]["coverage"],
    );
    Ok(
        json!({"schemaVersion":"flopeek-delta/v1","projectId":current["project"]["projectId"].clone(),"fromGraphVersion":previous["state"]["graphVersion"].clone(),"toGraphVersion":current["state"]["graphVersion"].clone(),"reason":"refresh","generatedAt":current["state"]["updatedAt"].clone(),"changedPaths":changed_paths,"changedPathProvenance":{"status":"available","source":"scanner-refresh","reason":null},"refresh":{"mode":current["analysis"]["refresh"]["mode"].clone(),"analyzedFiles":current["analysis"]["refresh"]["analyzedFiles"].clone(),"reusedFiles":current["analysis"]["refresh"]["reusedFiles"].clone(),"removedFiles":current["analysis"]["refresh"]["removedFiles"].clone()},"sourceChanged":previous["state"]["sourceFingerprint"] != current["state"]["sourceFingerprint"] || previous["state"]["sourceRevision"] != current["state"]["sourceRevision"],"topologyChanged":topology_changed,"nodes":{"added":node_added,"removed":node_removed,"changed":node_changed},"edges":{"added":edge_added,"removed":edge_removed,"changed":edge_changed},"flows":{"added":flow_added,"removed":flow_removed,"changed":flow_changed},"affectedNodes":affected_nodes,"affectedContexts":{"nodes":context_nodes,"flows":context_flows,"truncated":context_nodes_truncated || context_flows_truncated},"flowComparisons":{"items":comparisons,"truncated":comparisons_truncated},"coverageChanged":coverage_changed,"truncated":node_truncated || edge_truncated || flow_truncated || affected_truncated || context_nodes_truncated || context_flows_truncated || comparisons_truncated,"summary":{"addedNodes":node_total.0,"removedNodes":node_total.1,"changedNodes":node_total.2,"addedEdges":edge_total.0,"removedEdges":edge_total.1,"changedEdges":edge_total.2,"addedFlows":flow_total.0,"removedFlows":flow_total.1,"changedFlows":flow_total.2,"affectedNodes":affected_nodes.len(),"affectedContexts":context_nodes.len()+context_flows.len(),"flowComparisons":comparisons.len()},"limitation":"Affected contexts and bounded Flow Lens comparisons identify supported static entry evidence from one adjacent delta. They do not prove command invocation, runtime execution, control flow, business behavior, or a full historical Context Card."}),
    )
}

fn get_native_public_graph_snapshot(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativePublicGraphSnapshot requires params.projectId.".to_string(),
        })?;
    let graph_version = params
        .get("graphVersion")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativePublicGraphSnapshot requires a positive native params.graphVersion."
                .to_string(),
        })?;
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let payload = complete_graph_payload(&connection, project_id, graph_version)
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| NativeProtocolError {
            code: "missing-native-graph",
            message: "No complete native graph matches params.graphVersion.".to_string(),
        })?;
    Ok(json!({
        "schemaVersion": "flopeek-native-public-graph-snapshot/v1",
        "nativeGraphVersion": graph_version,
        "graph": native_public_graph_snapshot_with_public_context(
            &payload.payload,
            params.get("publicGraphContext"),
        )?,
        "limitation": "This is a source-safe native reconstruction used for shadow parity. JavaScript remains authoritative for public graph lifecycle until the complete compatibility gate passes.",
    }))
}

// Read only the project pointer to the last transactionally complete graph.
// This is the native last-complete fallback: it never consults graph.json and
// never serves a `building` version after a failed refresh.
fn get_native_current_public_graph(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativeCurrentPublicGraph requires params.projectId.".to_string(),
        })?;
    let mut connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    recover_incomplete_graph_builds(&mut connection, project_id).map_err(|error| {
        NativeProtocolError {
            code: "store-recovery-failed",
            message: error.to_string(),
        }
    })?;
    let current = current_complete_graph(&connection, project_id)
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| NativeProtocolError {
            code: "missing-native-graph",
            message: "No complete native graph is available for this project.".to_string(),
        })?;
    let payload = complete_graph_payload(&connection, project_id, current.graph_version)
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| NativeProtocolError {
            code: "missing-native-graph",
            message: "The current complete native graph payload is unavailable.".to_string(),
        })?;
    let mut graph = native_public_graph_snapshot(&payload.payload)?;
    graph["state"]["status"] = Value::String("native-last-complete".to_string());
    graph["analysis"]["latestDelta"] = Value::Null;
    graph["analysis"]["graphState"] = json!({
        "schemaVersion": "flopeek-native-graph-state/v1",
        "status": "last-complete",
        "persistence": "sqlite",
        "nativeGraphVersion": current.graph_version,
        "graphVersion": current.public_graph_version,
        "materialFingerprint": current.material_fingerprint,
        "sourceFingerprint": current.source_fingerprint,
        "sourceRevision": graph["state"]["sourceRevision"].clone(),
        "updatedAt": graph["state"]["updatedAt"].clone(),
        "latestDelta": Value::Null,
        "limitation": "This is the last transactionally complete native graph. It may be stale relative to current source and does not prove runtime behavior.",
    });
    Ok(json!({
        "schemaVersion": "flopeek-native-current-public-graph/v1",
        "nativeGraphVersion": current.graph_version,
        "publicGraphVersion": current.public_graph_version,
        "graph": graph,
        "graphHandle": {
            "schemaVersion": "flopeek-native-graph-handle/v1",
            "projectId": project_id,
            "factsDigest": current.material_fingerprint,
            "persistence": "sqlite",
            "publicGraphVersion": current.public_graph_version,
        },
        "limitation": "This fallback serves only the SQLite last-complete graph after recovery of incomplete builds. It returns a verified graph handle, never a duplicate StructuralFactBatch; JavaScript graph.json is not read.",
    }))
}

fn get_native_public_graph_delta(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativePublicGraphDelta requires params.projectId.".to_string(),
        })?;
    let version = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-params",
                message: format!(
                    "getNativePublicGraphDelta requires a positive native params.{name}."
                ),
            })
    };
    let from = version("fromGraphVersion")?;
    let to = version("toGraphVersion")?;
    if to <= from {
        return Err(NativeProtocolError {
            code: "invalid-params",
            message:
                "getNativePublicGraphDelta requires toGraphVersion greater than fromGraphVersion."
                    .to_string(),
        });
    }
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let load = |version| {
        complete_graph_payload(&connection, project_id, version)
            .map_err(|error| NativeProtocolError {
                code: "store-read-failed",
                message: error.to_string(),
            })?
            .ok_or_else(|| NativeProtocolError {
                code: "missing-native-graph",
                message: format!("No complete native graph matches params.graphVersion {version}."),
            })
    };
    let previous = load(from)?;
    let current = load(to)?;
    native_public_graph_delta(&previous.payload, &current.payload)
}

fn public_context_ref(
    project_id: &str,
    kind: &str,
    context_id: &str,
    graph_version: &Value,
) -> String {
    format!(
        "fp://local/{}/{}/{}@{}",
        encode_context_part(project_id),
        encode_context_part(kind),
        encode_context_part(context_id),
        graph_version.as_u64().unwrap_or(0),
    )
}

fn get_native_changed_contexts(params: &Value) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativeChangedContexts requires params.projectId.".to_string(),
        })?;
    let parse_version = |name: &str| -> Result<i64, NativeProtocolError> {
        params
            .get(name)
            .and_then(Value::as_i64)
            .filter(|version| *version >= 0)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-params",
                message: format!(
                    "getNativeChangedContexts requires a non-negative integer params.{name}."
                ),
            })
    };
    let from_graph_version = parse_version("fromGraphVersion")?;
    let to_graph_version = parse_version("toGraphVersion")?;
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let current =
        complete_graph_payload_by_public_version(&connection, project_id, to_graph_version)
            .map_err(|error| NativeProtocolError {
                code: "store-read-failed",
                message: error.to_string(),
            })?
            .ok_or_else(|| NativeProtocolError {
                code: "missing-native-graph",
                message: "No complete native graph matches params.toGraphVersion.".to_string(),
            })?;
    let graph = native_public_graph_snapshot(&current.payload)?;
    let base = json!({
        "schemaVersion": "flopeek-changed-contexts/v1",
        "project": {
            "projectId": project_id,
            "graphVersion": graph["state"]["graphVersion"].clone(),
            "sourceRevision": graph["state"]["sourceRevision"].clone(),
        },
        "fromGraphVersion": from_graph_version,
        "toGraphVersion": to_graph_version,
    });
    let delta = complete_graph_delta_by_public_versions(
        &connection,
        project_id,
        from_graph_version,
        to_graph_version,
    )
    .map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let Some(delta) = delta else {
        let mut result = base;
        let object = result
            .as_object_mut()
            .expect("changed context base is an object");
        object.insert("available".to_string(), Value::Bool(false));
        object.insert("nodes".to_string(), json!([]));
        object.insert("flows".to_string(), json!([]));
        object.insert("summary".to_string(), json!({"nodes":0,"flows":0}));
        object.insert("limitation".to_string(), Value::String("No retained adjacent delta exists for these graph versions. Flopeek does not reconstruct changed contexts from runtime behavior or arbitrary history.".to_string()));
        return Ok(result);
    };
    let raw_nodes = delta["affectedContexts"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let raw_flows = delta["affectedContexts"]["flows"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let comparisons = delta["flowComparisons"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["flow"]["id"].as_str().map(|id| (id.to_string(), item)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let current_nodes = graph["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| node["id"].as_str().map(|id| (id.to_string(), node)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let current_flows = graph["flows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|flow| flow["id"].as_str().map(|id| (id.to_string(), flow)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut flows = Vec::new();
    let mut flow_ids_by_node = std::collections::BTreeMap::<String, Vec<String>>::new();
    for item in &raw_flows {
        let id = value_string(&item["flow"], "id");
        let current_flow = current_flows.get(&id).copied();
        let flow = current_flow.unwrap_or(&item["flow"]);
        let historical = item["status"] == "removed" || current_flow.is_none();
        let graph_version = if historical {
            Value::from(from_graph_version)
        } else {
            graph["state"]["graphVersion"].clone()
        };
        let changed_step_ids = item["changedStepIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        for node_id in &changed_step_ids {
            flow_ids_by_node
                .entry(node_id.clone())
                .or_default()
                .push(id.clone());
        }
        let comparison = comparisons.get(&id).copied();
        let entry_id = value_string(flow, "entryId");
        flows.push(json!({
            "id": id,
            "title": flow["title"].clone(),
            "entryId": entry_id,
            "status": item["status"].clone(),
            "changedStepIds": changed_step_ids,
            "graphVersion": graph_version,
            "entryContextRef": public_context_ref(project_id, "node", &value_string(flow, "entryId"), &graph_version),
            "flowContextRef": public_context_ref(project_id, "flow", &value_string(flow, "id"), &graph_version),
            "flowProjectionId": if historical { Value::Null } else { Value::String(format!("lens:{}@{}", value_string(flow, "id"), graph["state"]["graphVersion"].as_u64().unwrap_or(0))) },
            "flowComparisonId": comparison.and_then(|value| value["id"].as_str()).map(Value::from).unwrap_or(Value::Null),
            "flowComparisonAvailable": comparison.is_some(),
            "availability": if historical { "historical" } else { "current" },
            "evidence": { "kind":"adjacent-graph-delta", "fromGraphVersion": from_graph_version, "toGraphVersion": to_graph_version },
        }));
    }
    let nodes = raw_nodes
        .iter()
        .map(|item| {
            let id = value_string(&item["node"], "id");
            let current_node = current_nodes.get(&id).copied();
            let node = current_node.unwrap_or(&item["node"]);
            let historical = item["status"] == "removed" || current_node.is_none();
            let graph_version = if historical {
                Value::from(from_graph_version)
            } else {
                graph["state"]["graphVersion"].clone()
            };
            let mut result = member_summary_value(node);
            let object = result.as_object_mut().expect("node summary is an object");
            object.insert("status".to_string(), item["status"].clone());
            object.insert("changeScope".to_string(), item["changeScope"].clone());
            object.insert("graphVersion".to_string(), graph_version.clone());
            object.insert("contextRef".to_string(), Value::String(public_context_ref(project_id, "node", &id, &graph_version)));
            object.insert("availability".to_string(), Value::String(if historical { "historical" } else { "current" }.to_string()));
            object.insert("affectedFlowIds".to_string(), json!(flow_ids_by_node.get(&id).cloned().unwrap_or_default()));
            object.insert("evidence".to_string(), json!({"kind":"adjacent-graph-delta","fromGraphVersion":from_graph_version,"toGraphVersion":to_graph_version}));
            result
        })
        .collect::<Vec<_>>();
    let mut result = base;
    let object = result
        .as_object_mut()
        .expect("changed context base is an object");
    object.insert("available".to_string(), Value::Bool(true));
    object.insert("delta".to_string(), json!({"reason":delta["reason"].clone(),"sourceChanged":delta["sourceChanged"].clone(),"topologyChanged":delta["topologyChanged"].clone(),"changedPaths":delta["changedPaths"].clone(),"truncated":delta["truncated"].as_bool().unwrap_or(false) || delta["affectedContexts"]["truncated"].as_bool().unwrap_or(false)}));
    object.insert("nodes".to_string(), Value::Array(nodes.clone()));
    object.insert("flows".to_string(), Value::Array(flows.clone()));
    object.insert(
        "summary".to_string(),
        json!({"nodes":nodes.len(),"flows":flows.len()}),
    );
    object.insert("limitation".to_string(), Value::String("Changed contexts are bounded static evidence from one retained adjacent graph delta. A file-content-only context records an exact changed source file without claiming a declaration, static relationship, runtime behavior, or full historical Context Card.".to_string()));
    Ok(result)
}

fn handle_request(
    session: &mut NativeProtocolSession,
    mut request: NativeRequest,
) -> (NativeResponse, bool) {
    if request.protocol_version != NATIVE_PROTOCOL_VERSION {
        return (
            error_response(
                Some(request.request_id),
                "unsupported-protocol",
                format!("Expected {NATIVE_PROTOCOL_VERSION}."),
            ),
            false,
        );
    }
    if request.request_id.trim().is_empty() || request.request_id.len() > 240 {
        return (
            error_response(
                None,
                "invalid-request-id",
                "requestId must contain 1 to 240 characters.",
            ),
            false,
        );
    }
    let accepts_cached_fact_reference = matches!(
        request.method.as_str(),
        "getEntryFlows"
            | "getRequestFlows"
            | "findNodes"
            | "getNodeDetails"
            | "createContextRef"
            | "resolveNativeContextRef"
            | "getNativeFlowLensCore"
            | "getNativeNodeContextCard"
            | "getNativeFlowContextCard"
            | "getNativeScanStatus"
            | "getNativeProjectOverviewCore"
            | "getRelatedTests"
            | "getChangeImpact"
    );
    if accepts_cached_fact_reference && request.params.get("batch").is_none() {
        let hydrate = if request.params.get("sessionGraph").is_some() {
            hydrate_session_query_batch(session, &mut request.params)
        } else {
            hydrate_cached_query_batch(session, &mut request.params)
        };
        if let Err(error) = hydrate {
            return (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            );
        }
    }
    match request.method.as_str() {
        "health" => (
            success_response(
                request.request_id,
                json!({
                    "implementation": "rust",
                    "capabilities": ["health", "initialize", "nativeIncrementalManifest", "nativeBoundedDiscovery", "refreshNativeProject", "refreshNativePersistentProject", "nativeJsRecordCache", "nativeJsStructuralFacts", "submitStructuralFacts", "assembleStructuralGraph", "assembleNativePublicGraph", "assembleNativeFlows", "findNodes", "getNodeDetails", "getEntryFlows", "getRequestFlows", "createContextRef", "resolveNativeContextRef", "getNativeFlowLensCore", "getNativeNodeContextCard", "getNativeFlowContextCard", "getNativeScanStatus", "getNativeProjectOverviewCore", "getRelatedTests", "getChangeImpact", "persistStructuralGraph", "persistNativePublicGraph", "persistNativePublicGraphPatch", "refreshNativeSessionGraph", "refreshNativeJsSessionGraph", "getNativeStructuralDelta", "getNativePublicGraphSnapshot", "getNativeCurrentPublicGraph", "getNativePublicGraphDelta", "getNativeChangedContexts", "shutdown"],
                    "storeAuthoritative": false,
                    "publicNodeIdsEnabled": true,
                    "adapterCapabilities": native_adapter_registry(),
                }),
            ),
            false,
        ),
        "initialize" => match project_root(&request.params) {
            Ok(root) => match initialize_native_store(&root) {
                Ok(store) => (
                    success_response(
                        request.request_id,
                        json!({
                            "store": {
                                "relativePath": ".flopeek/native-core.sqlite3",
                                "schemaVersion": store.schema_version,
                                "journalMode": store.journal_mode,
                                "foreignKeysEnabled": store.foreign_keys_enabled,
                                "synchronousMode": store.synchronous_mode,
                                "busyTimeoutMs": store.busy_timeout_ms,
                                "quickCheck": store.quick_check,
                            },
                            "storeAuthoritative": false,
                            "publicNodeIdsEnabled": true,
                        }),
                    ),
                    false,
                ),
                Err(error) => (
                    error_response(
                        Some(request.request_id),
                        "store-initialize-failed",
                        error.to_string(),
                    ),
                    false,
                ),
            },
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "nativeIncrementalManifest" => match native_incremental_manifest(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "nativeBoundedDiscovery" => match native_bounded_discovery(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "refreshNativeProject" => match refresh_native_project(session, &request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "refreshNativePersistentProject" => {
            match refresh_native_persistent_project(session, &request.params) {
                Ok(result) => (success_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "nativeJsRecordCache"
            if request
                .params
                .pointer("/cacheRequest/operation")
                .and_then(Value::as_str)
                == Some("load") =>
        {
            match native_js_record_cache_load_raw(&request.params) {
                Ok(result) => (success_raw_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "nativeJsRecordCache" => match native_js_record_cache(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "nativeJsStructuralFacts" => match native_js_structural_facts(session, &request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "submitStructuralFacts" => match submit_structural_facts(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "assembleStructuralGraph" => match submit_structural_facts(&request.params)
            .and_then(|_| {
                build_structural_graph(structural_batch(&request.params)?).map_err(|message| {
                    NativeProtocolError {
                        code: "structural-graph-failed",
                        message,
                    }
                })
            })
            .and_then(|graph| {
                serde_json::to_value(graph).map_err(|error| NativeProtocolError {
                    code: "structural-graph-serialize-failed",
                    message: error.to_string(),
                })
            }) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "assembleNativePublicGraph" => match assemble_native_public_graph(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "assembleNativeFlows" => match assemble_native_flows(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getEntryFlows" => match get_native_entry_flows(&request.params, false) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getRequestFlows" => match get_native_entry_flows(&request.params, true) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "findNodes" => match get_native_find_nodes(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNodeDetails" => match get_native_node_details(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeScanStatus" => match native_agent_bootstrap(session, &request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeProjectOverviewCore" => {
            match native_project_overview_core(session, &request.params) {
                Ok(result) => (success_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "createContextRef" => match create_native_context_ref(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "resolveNativeContextRef" => match resolve_native_context_ref(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeFlowLensCore" => match native_flow_lens_core(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeNodeContextCard" => match native_node_context_card(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeFlowContextCard" => match native_flow_context_card(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getRelatedTests" => match get_related_tests(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getChangeImpact" => match get_change_impact(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "persistStructuralGraph" => match persist_structural_graph(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "persistNativePublicGraph" => {
            match persist_native_public_graph(session, &mut request.params) {
                Ok(result) => (success_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "persistNativePublicGraphPatch" => {
            match persist_native_public_graph_patch(session, &request.params) {
                Ok(result) => (success_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "refreshNativeSessionGraph" => match refresh_native_session_graph(session, &request.params)
        {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "refreshNativeJsSessionGraph" => {
            match refresh_native_js_session_graph(session, &request.params) {
                Ok(result) => (success_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "getNativeStructuralDelta" => match get_native_structural_delta(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativePublicGraphSnapshot" => match get_native_public_graph_snapshot(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeCurrentPublicGraph" => match get_native_current_public_graph(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativePublicGraphDelta" => match get_native_public_graph_delta(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNativeChangedContexts" => match get_native_changed_contexts(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "shutdown" => (
            success_response(request.request_id, json!({ "accepted": true })),
            true,
        ),
        _ => (
            error_response(
                Some(request.request_id),
                "unknown-method",
                "Supported methods are health, initialize, nativeIncrementalManifest, nativeBoundedDiscovery, refreshNativeProject, refreshNativePersistentProject, nativeJsRecordCache, nativeJsStructuralFacts, submitStructuralFacts, assembleStructuralGraph, assembleNativePublicGraph, assembleNativeFlows, findNodes, getNodeDetails, getEntryFlows, getRequestFlows, createContextRef, resolveNativeContextRef, getNativeFlowLensCore, getNativeNodeContextCard, getNativeFlowContextCard, getNativeScanStatus, getNativeProjectOverviewCore, getRelatedTests, getChangeImpact, persistStructuralGraph, persistNativePublicGraph, persistNativePublicGraphPatch, refreshNativeSessionGraph, refreshNativeJsSessionGraph, getNativeStructuralDelta, getNativePublicGraphSnapshot, getNativeCurrentPublicGraph, getNativePublicGraphDelta, getNativeChangedContexts, and shutdown.",
            ),
            false,
        ),
    }
}

pub fn serve_jsonl<R: BufRead, W: Write>(reader: R, mut writer: W) -> Result<(), String> {
    let mut session = NativeProtocolSession::default();
    for line in reader.lines() {
        let line =
            line.map_err(|error| format!("Unable to read native protocol request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let dispatch_started = Instant::now();
        let (mut response, should_shutdown) = match serde_json::from_str::<NativeRequest>(&line) {
            Ok(request) => handle_request(&mut session, request),
            Err(error) => (
                error_response(
                    None,
                    "invalid-request",
                    format!("Request must be valid JSON for {NATIVE_PROTOCOL_VERSION}: {error}"),
                ),
                false,
            ),
        };
        if let Some(NativeProtocolResult::Value(result)) = response.result.as_mut() {
            if let Some(profile) = result
                .get_mut("receipt")
                .and_then(|receipt| receipt.get_mut("profile"))
                .and_then(Value::as_object_mut)
            {
                profile.insert(
                    "nativeProtocolDispatchMs".to_string(),
                    json!(elapsed_ms(dispatch_started)),
                );
            }
        }
        serde_json::to_writer(&mut writer, &response)
            .map_err(|error| format!("Unable to encode native protocol response: {error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("Unable to write native protocol response: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Unable to flush native protocol response: {error}"))?;
        if should_shutdown {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        NATIVE_PROTOCOL_VERSION, NativeProtocolSession, STRUCTURAL_FACT_BATCH_SCHEMA,
        build_isolated_incremental_graph, hydrate_cached_query_batch, hydrate_session_query_batch,
        isolated_structural_change_path, native_entry_source_nodes,
        refresh_native_js_session_graph, refresh_native_persistent_project, same_canonical_json,
        serve_jsonl, structural_facts_canonical_json, structural_facts_digest,
        structural_topology_digest,
    };
    use crate::structural_graph::build_structural_graph;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn responses(input: &str) -> Vec<Value> {
        let mut output = Vec::new();
        serve_jsonl(Cursor::new(input.as_bytes()), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
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
        let mut session = NativeProtocolSession::default();
        let initial =
            refresh_native_persistent_project(&mut session, &json!({ "projectRoot": root }))
                .unwrap();
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
        fs::write(&source, "export const changed = true;\n").unwrap();
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
        assert!(refreshed["receipt"]["profile"]["factPatchReconstructionMs"].is_number());
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
            refresh_native_persistent_project(&mut session, &json!({ "projectRoot": root }))
                .unwrap();
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
    fn structural_fact_digest_serialization_matches_the_legacy_material_projection() {
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
        let expected = serde_json::to_string(&Value::Object(legacy)).unwrap();
        let actual = structural_facts_canonical_json(batch.as_object().unwrap()).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(
            structural_facts_digest(batch.as_object().unwrap()).unwrap(),
            format!("sha256:{:x}", Sha256::digest(expected)),
        );
    }

    #[test]
    fn structural_topology_digest_serialization_matches_the_legacy_projection() {
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
        let expected = serde_json::to_string(&Value::Object(legacy)).unwrap();
        assert_eq!(
            structural_topology_digest(batch.as_object().unwrap()).unwrap(),
            format!("sha256:{:x}", Sha256::digest(expected)),
        );
    }

    #[test]
    fn structural_topology_digest_ignores_source_identity_but_not_parser_facts() {
        let first =
            structural_facts(json!({ "symbols": [{ "type": "function", "name": "same" }] }));
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
        let path = isolated_structural_change_path(
            first.as_object().unwrap(),
            current.as_object().unwrap(),
        );
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
        current["records"][0]["result"]["symbols"] =
            json!([{ "type": "function", "name": "after" }]);
        assert_eq!(
            isolated_structural_change_path(
                first.as_object().unwrap(),
                current.as_object().unwrap(),
            ),
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
        assert_eq!(result[1]["result"]["accepted"], true);
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
        second["lifecycleContext"]["updatedAt"] =
            Value::String("2026-01-01T00:00:01.000Z".to_string());
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
        second["lifecycleContext"]["updatedAt"] =
            Value::String("2026-01-01T00:00:01.000Z".to_string());
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
}
