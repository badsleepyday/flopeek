use super::super::*;

pub(in crate::protocol) fn refresh_native_session_graph(
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
    let mut query_batch = params.clone();
    query_batch["flowContext"]["graphVersion"] = json!(public_graph_version);
    let session_graph = NativeSessionGraph {
        facts_digest: facts_digest.to_string(),
        topology_digest,
        public_graph_version,
        payload: Arc::new(payload),
        query_batch: Arc::new(query_batch),
        public_state: graph["state"].clone(),
        public_graph_state: graph["analysis"]["graphState"].clone(),
        latest_delta: adjacent_delta.clone(),
    };
    session
        .graphs
        .insert(project_id.to_string(), session_graph.clone());
    session.session_query_graphs.insert(
        native_session_graph_key(project_id, public_graph_version),
        session_graph,
    );
    session.expire_session_history(project_id, public_graph_version);
    let project_key_prefix = format!("{project_id}\0");
    let retained_session_graphs = session
        .session_query_graphs
        .keys()
        .filter(|key| key.starts_with(&project_key_prefix))
        .count();
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
            "sessionHistoryLimit": session.session_history_limit,
            "retainedSessionGraphs": retained_session_graphs,
            "expiredThroughVersion": session.expired_session_versions.get(project_id).copied(),
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
