use super::super::*;

pub(in crate::protocol) struct PersistedStructuralGraph {
    receipt: Value,
    projection: Value,
    public_snapshot: Value,
    public_collection_patch: Option<Value>,
    public_snapshot_materialization_ms: u64,
    projection_consumed: bool,
}

const NATIVE_PUBLIC_GRAPH_COLLECTIONS: [(&str, bool); 4] = [
    ("nodes", false),
    ("edges", true),
    ("flows", false),
    ("diagnosticFlows", false),
];

fn native_promotion_error(error: rusqlite::Error) -> NativeProtocolError {
    let message = error.to_string();
    // A completed newer graph is authoritative.  The older in-flight writer
    // is rejected at the locked SQLite boundary and must not be retried as a
    // full batch or allowed to move the pointer backwards.  `native-error`
    // is the established bounded-protocol conflict surface consumed by the
    // cross-process recovery contract.
    let code = if message.contains("concurrent native graph candidate superseded") {
        "native-error"
    } else {
        "store-promote-failed"
    };
    NativeProtocolError { code, message }
}

pub(in crate::protocol) fn native_public_graph_envelope(public_graph: &Value) -> Value {
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
pub(in crate::protocol) fn replace_public_graph_with_handle_envelope(
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

pub(in crate::protocol) fn requests_handle_only_public_graph(
    params: &Value,
) -> Result<bool, NativeProtocolError> {
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

pub(in crate::protocol) fn native_public_collection_key(
    value: &Value,
    is_edge: bool,
) -> Option<String> {
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
pub(in crate::protocol) fn native_public_collection_patch(
    previous: &Value,
    current: &Value,
) -> Option<Value> {
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

pub(in crate::protocol) fn persist_reused_structural_projection(
    params: &Value,
    connection: &mut rusqlite::Connection,
    receipt: Value,
    previous_projection: Option<&Value>,
    previous_projection_owned: Option<Value>,
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
    // A persistent handle-only refresh already retains the public snapshot.
    // Move the SQLite-hydrated projection out of the session cache instead of
    // cloning the complete JSON projection; on errors the cache is deliberately
    // left empty and the next refresh rehydrates the verified SQLite payload.
    let projection_was_owned = previous_projection_owned.is_some();
    let projection_clone_started = Instant::now();
    let mut projection = previous_projection_owned.unwrap_or_else(|| {
        previous_projection
            .expect("reused projection has an owned or borrowed previous payload")
            .clone()
    });
    let projection_clone_ms = if projection_was_owned {
        0
    } else {
        elapsed_ms(projection_clone_started)
    };
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
        let fallback_previous_context = if previous_public_snapshot.is_none() {
            Some(native_public_graph_context(
                previous_projection.expect("reused projection has a previous payload"),
                None,
            )?)
        } else {
            None
        };
        // `flowLenses` is part of the static projection and is unchanged on
        // this source-only reuse path. Borrow it from the moved projection
        // instead of cloning another lens-sized JSON value. The cached public
        // snapshot is the exact previous envelope, so it is also the previous
        // delta context without reconstructing a cloned context object.
        let previous_delta_payload = if projection_was_owned {
            &projection
        } else {
            previous_projection.expect("reused projection has a previous payload")
        };
        let previous_context = previous_public_snapshot
            .or(fallback_previous_context.as_ref())
            .expect("previous public context");
        let mut current_context = native_public_graph_context(&projection, None)?;
        current_context["stats"] = cached["stats"].clone();
        let delta = native_public_graph_delta_with_reused_collections(
            previous_delta_payload,
            previous_context,
            &projection,
            &current_context,
            cached,
        )?;
        (current_context, delta)
    } else {
        let public_snapshot = native_public_graph_snapshot(&projection)?;
        let previous_projection =
            previous_projection.expect("reused projection has a previous payload");
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
    .map_err(native_promotion_error)?;
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
        projection_consumed: false,
    })
}

pub(in crate::protocol) struct PersistStructuralGraphOptions<'a> {
    validated_receipt: Option<Value>,
    previous_projection: Option<&'a Value>,
    previous_projection_owned: Option<Value>,
    previous_public_snapshot: Option<&'a Value>,
    reuse_previous_projection: bool,
    isolated_incremental_path: Option<&'a str>,
    changed_record_paths: Option<&'a BTreeSet<String>>,
    consume_cold_projection_into_public: bool,
}

pub(in crate::protocol) fn persist_structural_graph_internal(
    params: &mut Value,
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
        let previous_projection_owned = options.previous_projection_owned;
        if options.previous_projection.is_none() && previous_projection_owned.is_none() {
            return Err(NativeProtocolError {
                code: "store-integrity-failed",
                message:
                    "A structural projection reuse request requires the current complete projection."
                        .to_string(),
            });
        }
        return persist_reused_structural_projection(
            params,
            connection,
            receipt,
            options.previous_projection,
            previous_projection_owned,
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
    let flow_context = batch["flowContext"].clone();
    let lifecycle_context = batch["lifecycleContext"].clone();
    let public_graph_context = batch["publicGraphContext"].clone();
    if options.consume_cold_projection_into_public && options.previous_projection.is_none() {
        let batch = if params.get("batch").is_some() {
            params.get_mut("batch")
        } else {
            Some(&mut *params)
        }
        .and_then(Value::as_object_mut)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 must be an object.".to_string(),
        })?;
        let records = batch
            .get_mut("records")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-facts",
                message: "StructuralFactBatch/v1 requires records[].".to_string(),
            })?;
        for record in records {
            let payload = serde_json::to_string(record).map_err(|error| NativeProtocolError {
                code: "structural-graph-serialize-failed",
                message: error.to_string(),
            })?;
            *record = Value::String(payload);
        }
    }
    let serialization_started = Instant::now();
    let mut projection =
        structural_graph_projection_into_value(graph).map_err(|message| NativeProtocolError {
            code: "structural-graph-serialize-failed",
            message,
        })?;
    projection["flowContext"] = flow_context;
    projection["lifecycleContext"] = lifecycle_context;
    projection["publicGraphContext"] = public_graph_context;
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
    let consume_cold_projection_into_public = options.consume_cold_projection_into_public;
    let public_snapshot_started = Instant::now();
    let mut public_snapshot = if consume_cold_projection_into_public {
        Value::Null
    } else {
        native_public_graph_snapshot_from_projection(&projection, None)?
    };
    let mut public_snapshot_materialization_ms = if consume_cold_projection_into_public {
        0
    } else {
        elapsed_ms(public_snapshot_started)
    };
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
            if public_snapshot.is_null() {
                let materialization_started = Instant::now();
                public_snapshot = native_public_graph_snapshot_from_projection(&projection, None)?;
                public_snapshot_materialization_ms = elapsed_ms(materialization_started);
            }
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
                projection_consumed: false,
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
    // The compact public patch and adjacent delta now own every value needed
    // from the previous public snapshot. Release that full derived graph
    // before SQLite component promotion so an incremental refresh does not
    // hold previous projection + previous public graph + next public graph at
    // the same peak.
    drop(previous_public_snapshot);
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
    .map_err(native_promotion_error)?;
    let projection_consumed = consume_cold_projection_into_public && previous.is_none();
    if projection_consumed {
        let materialization_started = Instant::now();
        public_snapshot = take_native_public_graph_snapshot_from_projection(&mut projection)?;
        public_snapshot_materialization_ms = elapsed_ms(materialization_started);
    }
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
        projection_consumed,
    })
}

pub(in crate::protocol) fn persist_structural_graph(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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
    let mut owned_params = params.clone();
    Ok(persist_structural_graph_internal(
        &mut owned_params,
        &mut connection,
        PersistStructuralGraphOptions {
            validated_receipt: None,
            previous_projection: None,
            previous_projection_owned: None,
            previous_public_snapshot: None,
            reuse_previous_projection: false,
            isolated_incremental_path: None,
            changed_record_paths: None,
            consume_cold_projection_into_public: false,
        },
    )?
    .receipt)
}

pub(in crate::protocol) fn versioned_native_lifecycle_params(
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
        // This owned batch is persisted atomically and is never observable
        // between candidate creation and commit. Store the post-commit public
        // state so SQLite-backed queries and the returned graph expose the
        // same lifecycle contract after a successful promotion.
        Value::String("native-advanced".to_string()),
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
pub(in crate::protocol) fn reconstruct_structural_fact_patch(
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
    // The common changed-source path preserves record membership and order.
    // Replace only its declared records in place; rebuilding a path map and a
    // second Vec for every unchanged record made one-file refresh O(project)
    // in allocations even though validation and hashing were already linear.
    let same_layout = cached_records.len() == manifest.len()
        && cached_records.iter().zip(manifest).all(|(record, header)| {
            record.get("relativePath").and_then(Value::as_str)
                == header.get("relativePath").and_then(Value::as_str)
        });
    let mut records = if same_layout {
        std::mem::take(cached_records)
    } else {
        Vec::with_capacity(manifest.len())
    };
    let mut cached_by_path = BTreeMap::new();
    if !same_layout {
        for record in std::mem::take(cached_records) {
            let path = record
                .get("relativePath")
                .and_then(Value::as_str)
                .ok_or_else(|| NativeProtocolError {
                    code: "store-integrity-failed",
                    message: "The cached StructuralFactBatch contains an invalid record."
                        .to_string(),
                })?;
            if cached_by_path.insert(path.to_string(), record).is_some() {
                return Err(NativeProtocolError {
                    code: "store-integrity-failed",
                    message: "The cached StructuralFactBatch repeats a record path.".to_string(),
                });
            }
        }
    }
    let mut manifest_paths = BTreeMap::new();
    for (index, header) in manifest.iter().enumerate() {
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
        let record = if same_layout {
            if let Some(changed) = changed_by_path.remove(path) {
                records[index] = changed.clone();
            }
            &records[index]
        } else {
            // A changed-path patch may add a file that had no prior cache row.
            // Consume its complete changed record directly; unchanged manifest
            // entries still require an exact cached record. This preserves the
            // strict cache-miss guard without forcing every new file through a
            // full-batch fallback.
            let changed_record = changed_by_path.remove(path).cloned();
            let record = match changed_record {
                Some(record) => record,
                None => cached_by_path.remove(path).ok_or_else(|| {
                    NativeProtocolError {
                        code: "structural-fact-patch-miss",
                        message: format!(
                            "Structural fact patch is missing cached record {path}; submit a full batch."
                        ),
                    }
                })?,
            };
            records.push(record);
            records.last().expect("record was appended")
        };
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
    if let Some(expected_digest) = expected_digest.as_ref()
        && expected_digest != &computed_digest
    {
        return Err(NativeProtocolError {
            code: "invalid-structural-fact-patch",
            message: "Structural fact patch digest verification failed.".to_string(),
        });
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

pub(in crate::protocol) fn persist_native_public_graph_patch(
    session: &mut NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    with_persistent_session_connection(session, &root, |session, connection| {
        persist_native_public_graph_patch_using_connection(session, params, connection)
    })
}

pub(in crate::protocol) fn persist_native_public_graph_patch_using_connection(
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
    if next.payload.get("projectRoot").is_none() {
        return Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "Reconstructed structural fact patch is missing projectRoot.".to_string(),
        });
    }
    // Keep the previous cache identity available during promotion. Its payload
    // was moved into `next`, so a failed promotion clears this derived cache
    // rather than risking stale process-local parser facts.
    session.persistent_facts = Some(previous);
    let persistence_started = Instant::now();
    // Patch membership is passed as an internal promotion override. The
    // reconstructed batch is already owned and validated, so wrapping it in a
    // second JSON object only to move it back out adds O(batch) allocator churn.
    let persistence_params_ms = 0;
    let native_lifecycle_started = Instant::now();
    let mut result = match persist_native_public_graph_with_receipt_using_connection(
        session,
        &mut next.payload,
        receipt,
        PersistNativePublicGraphOptions {
            retain_persistent_facts: false,
            verified_topology_digest: Some(next.topology_digest.clone()),
            changed_record_paths_override: Some(changed_paths),
            retain_public_snapshot: true,
        },
        connection,
    ) {
        Ok(result) => result,
        Err(error) => {
            session.persistent_facts = None;
            return Err(error);
        }
    };
    let native_lifecycle_ms = elapsed_ms(native_lifecycle_started);
    let session_cache_started = Instant::now();
    session.persistent_facts = None;
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

pub(in crate::protocol) fn native_fact_patch_changed_paths(
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
pub(in crate::protocol) fn persist_native_public_graph(
    session: &mut NativeProtocolSession,
    params: &mut Value,
) -> Result<Value, NativeProtocolError> {
    let receipt = submit_structural_facts(params)?;
    // The JSONL request is owned by this native process and is not observable
    // after its response. Versioning mutates only non-material context fields,
    // so avoid cloning a complete multi-megabyte fact batch solely to set them.
    persist_native_public_graph_with_receipt(session, params, receipt, true, None)
}

pub(in crate::protocol) fn persist_native_public_graph_with_receipt(
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
        PersistNativePublicGraphOptions {
            retain_persistent_facts,
            verified_topology_digest,
            changed_record_paths_override: None,
            retain_public_snapshot: true,
        },
        &mut connection,
    )
}

pub(in crate::protocol) struct PersistNativePublicGraphOptions {
    pub(in crate::protocol) retain_persistent_facts: bool,
    pub(in crate::protocol) verified_topology_digest: Option<String>,
    pub(in crate::protocol) changed_record_paths_override: Option<BTreeSet<String>>,
    pub(in crate::protocol) retain_public_snapshot: bool,
}

pub(in crate::protocol) fn persist_native_public_graph_with_receipt_using_connection(
    session: &mut NativeProtocolSession,
    params: &mut Value,
    receipt: Value,
    options: PersistNativePublicGraphOptions,
    connection: &mut rusqlite::Connection,
) -> Result<Value, NativeProtocolError> {
    let PersistNativePublicGraphOptions {
        retain_persistent_facts,
        verified_topology_digest,
        changed_record_paths_override,
        retain_public_snapshot,
    } = options;
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
        let can_reuse_public_collections = persistent.public_snapshot.is_some();
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
        let payload = take_owned_structural_batch(params)?;
        session.persistent_facts = Some(NativePersistentFacts {
            project_id: project_id.clone(),
            facts_digest: facts_digest.clone(),
            topology_digest: current_topology_digest,
            payload,
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
    if let Some(previous) = current.as_ref() {
        let cache_hit =
            ensure_persistent_payload(session, connection, &project_id, previous.graph_version)?;
        persistent_payload_cache_hit = cache_hit;
    }
    // `cached_or_load_persistent_payload` above may replace the cache. Read
    // its public snapshot only afterwards, when both references are immutable
    // and guaranteed to point at the SQLite-selected prior graph version.
    let has_previous_public_snapshot = current.as_ref().is_some_and(|previous| {
        session
            .persistent_graph
            .as_ref()
            .filter(|cached| {
                cached.project_id == project_id && cached.graph_version == previous.graph_version
            })
            .is_some_and(|cached| cached.public_snapshot.is_some())
    });
    let previous_projection_owned = if reuse_previous_projection && has_previous_public_snapshot {
        session
            .persistent_graph
            .as_mut()
            .map(|cached| std::mem::take(&mut cached.payload))
    } else {
        None
    };
    let previous_projection = if previous_projection_owned.is_none() {
        current.as_ref().map(|_| {
            &session
                .persistent_graph
                .as_ref()
                .expect("persistent payload is ensured")
                .payload
        })
    } else {
        None
    };
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
            previous_projection_owned,
            previous_public_snapshot,
            reuse_previous_projection,
            isolated_incremental_path: isolated_incremental_path.as_deref(),
            changed_record_paths: changed_record_paths.as_ref(),
            consume_cold_projection_into_public: !retain_public_snapshot && current.is_none(),
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
    let projection_consumed = stored.projection_consumed;
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
    } else if projection_consumed {
        // The complete projection was committed to SQLite before its public
        // collections were moved into the response. Reload it on demand for a
        // later refresh instead of retaining a second in-process copy now.
        session.persistent_graph = None;
    } else {
        session.persistent_graph = Some(NativePersistentGraph {
            project_id: project_id.clone(),
            graph_version: native_graph_version,
            payload: projection,
            public_snapshot: retain_public_snapshot.then(|| public_graph.clone()),
        });
    }
    let session_graph_cache_ms = elapsed_ms(session_graph_cache_started);
    let session_facts_cache_started = Instant::now();
    if retain_persistent_facts {
        let payload = take_owned_structural_batch(params)?;
        session.persistent_facts = Some(NativePersistentFacts {
            project_id: project_id.clone(),
            facts_digest: facts_digest.clone(),
            topology_digest,
            payload,
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

fn take_owned_structural_batch(params: &mut Value) -> Result<Value, NativeProtocolError> {
    if params.get("batch").is_some() {
        params
            .as_object_mut()
            .and_then(|object| object.remove("batch"))
            .filter(Value::is_object)
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-structural-facts",
                message:
                    "Native structural query params.batch must be a StructuralFactBatch/v1 object."
                        .to_string(),
            })
    } else if params.is_object() {
        Ok(std::mem::take(params))
    } else {
        Err(NativeProtocolError {
            code: "invalid-structural-facts",
            message: "StructuralFactBatch/v1 must be an object.".to_string(),
        })
    }
}

// The cache-disabled counterpart to persist_native_public_graph. It uses the
// same fact validation, public graph assembly, version-neutral material
// fingerprint, and adjacent-delta implementation, but deliberately never
// resolves projectRoot or opens SQLite. Its authority ends with this JSONL
// process, which is the exact lifetime advertised by cache-disabled Context
// Refs.
