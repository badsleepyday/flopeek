use super::super::*;

pub(in crate::protocol) fn get_native_structural_delta(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn native_public_node(node: &StructuralGraphNode) -> Value {
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

pub(in crate::protocol) fn native_public_edge(
    edge: &crate::structural_graph::StructuralGraphEdge,
) -> Value {
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
pub(in crate::protocol) fn native_public_stats(
    snapshot: &StructuralGraphSnapshot,
    analysis: &Value,
) -> Value {
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

pub(in crate::protocol) fn native_public_graph_snapshot_with_public_context(
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
pub(in crate::protocol) fn native_public_graph_context(
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

pub(in crate::protocol) fn native_public_graph_snapshot_from_snapshot(
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

/// Materialize the public compatibility graph directly from the already
/// transferred JSON projection. This avoids reconstructing a second complete
/// typed graph solely to clone it into a public `Value`.
pub(in crate::protocol) fn native_public_graph_snapshot_from_projection(
    payload: &Value,
    public_graph_context: Option<&Value>,
) -> Result<Value, NativeProtocolError> {
    let nodes = payload
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Native projection is missing nodes.".to_string(),
        })?;
    let edges = payload
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Native projection is missing edges.".to_string(),
        })?;
    let mut ordered_nodes = nodes.iter().collect::<Vec<_>>();
    ordered_nodes.sort_by(|left, right| {
        let left_label = left
            .pointer("/metadata/label")
            .and_then(Value::as_str)
            .or_else(|| left.get("id").and_then(Value::as_str))
            .unwrap_or_default();
        let right_label = right
            .pointer("/metadata/label")
            .and_then(Value::as_str)
            .or_else(|| right.get("id").and_then(Value::as_str))
            .unwrap_or_default();
        javascript_ascii_locale_cmp(left_label, right_label).then_with(|| {
            javascript_ascii_cmp(
                left.get("id").and_then(Value::as_str).unwrap_or_default(),
                right.get("id").and_then(Value::as_str).unwrap_or_default(),
            )
        })
    });
    let traversal_order = payload
        .get("nativeTraversalOrder")
        .and_then(Value::as_object)
        .map(|order| {
            order
                .iter()
                .filter_map(|(key, index)| index.as_u64().map(|index| (key.as_str(), index)))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let edge_key = |edge: &Value| {
        format!(
            "{}\0{}\0{}",
            edge.get("source")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            edge.get("target")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            edge.get("type").and_then(Value::as_str).unwrap_or_default(),
        )
    };
    let mut ordered_edges = edges.iter().collect::<Vec<_>>();
    ordered_edges.sort_by(|left, right| {
        let left_key = edge_key(left);
        let right_key = edge_key(right);
        traversal_order
            .get(left_key.as_str())
            .copied()
            .unwrap_or(u64::MAX)
            .cmp(
                &traversal_order
                    .get(right_key.as_str())
                    .copied()
                    .unwrap_or(u64::MAX),
            )
            .then_with(|| javascript_ascii_cmp(&left_key, &right_key))
    });
    let public_nodes = ordered_nodes
        .into_iter()
        .map(|node| {
            let mut value = node
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            value.insert("id".to_string(), node["id"].clone());
            value.insert("kind".to_string(), node["kind"].clone());
            value.insert("type".to_string(), node["nodeType"].clone());
            value.insert("path".to_string(), node["path"].clone());
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    let public_edges = ordered_edges
        .into_iter()
        .map(|edge| {
            json!({
                "source": edge["source"].clone(),
                "target": edge["target"].clone(),
                "type": edge["type"].clone(),
                "confidence": edge.get("confidence").cloned().unwrap_or(Value::Null),
                "evidence": edge.get("evidence").cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    let summary = payload
        .pointer("/lifecycleContext/coverage/summary")
        .and_then(Value::as_object);
    let coverage_count = |key: &str| {
        summary
            .and_then(|summary| summary.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let node_count =
        |predicate: &dyn Fn(&Value) -> bool| nodes.iter().filter(|node| predicate(node)).count();
    let stats = json!({
        "scannedFiles": coverage_count("scannedFiles"),
        "nodes": nodes.len(),
        "edges": edges.len(),
        "services": node_count(&|node| node["nodeType"] == "service"),
        "classes": node_count(&|node| node["kind"] == "symbol" && node["nodeType"] == "class"),
        "functions": node_count(&|node| node["kind"] == "symbol" && node["nodeType"] == "function"),
        "calls": edges.iter().filter(|edge| edge["type"] == "calls").count(),
        "endpoints": node_count(&|node| node["kind"] == "endpoint"),
        "commandEntries": node_count(&|node| node["kind"] == "command" && matches!(node.pointer("/metadata/entryKind").and_then(Value::as_str), Some("package-script") | Some("django-management-command") | Some("framework-command"))),
        "scheduledEntries": node_count(&|node| node["kind"] == "schedule" && node.pointer("/metadata/entryKind").and_then(Value::as_str) == Some("node-cron-schedule")),
        "tests": node_count(&|node| node["nodeType"] == "test"),
        "runtimeDependencies": node_count(&|node| node.pointer("/metadata/layer").and_then(Value::as_str) == Some("runtime")),
        "parsedFiles": coverage_count("parsedFiles"),
        "inventoryOnlyFiles": coverage_count("inventoryOnlyFiles"),
        "parseFailedFiles": coverage_count("parseFailedFiles"),
    });
    let mut result = native_public_graph_context(payload, public_graph_context)?;
    result["nodes"] = Value::Array(public_nodes);
    result["edges"] = Value::Array(public_edges);
    result["stats"] = stats;
    result["flows"] = payload["flows"].clone();
    result["diagnosticFlows"] = payload["diagnosticFlows"].clone();
    Ok(result)
}

pub(in crate::protocol) fn take_native_public_graph_snapshot_from_projection(
    payload: &mut Value,
) -> Result<Value, NativeProtocolError> {
    let mut result = native_public_graph_context(payload, None)?;
    let mut nodes = payload["nodes"]
        .take()
        .as_array_mut()
        .map(std::mem::take)
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Native projection is missing nodes.".to_string(),
        })?;
    let mut edges = payload["edges"]
        .take()
        .as_array_mut()
        .map(std::mem::take)
        .ok_or_else(|| NativeProtocolError {
            code: "store-read-failed",
            message: "Native projection is missing edges.".to_string(),
        })?;
    nodes.sort_by(|left, right| {
        let left_label = left
            .pointer("/metadata/label")
            .and_then(Value::as_str)
            .or_else(|| left.get("id").and_then(Value::as_str))
            .unwrap_or_default();
        let right_label = right
            .pointer("/metadata/label")
            .and_then(Value::as_str)
            .or_else(|| right.get("id").and_then(Value::as_str))
            .unwrap_or_default();
        javascript_ascii_locale_cmp(left_label, right_label).then_with(|| {
            javascript_ascii_cmp(
                left.get("id").and_then(Value::as_str).unwrap_or_default(),
                right.get("id").and_then(Value::as_str).unwrap_or_default(),
            )
        })
    });
    let traversal_order = payload
        .get("nativeTraversalOrder")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let edge_key = |edge: &Value| {
        format!(
            "{}\0{}\0{}",
            edge["source"].as_str().unwrap_or_default(),
            edge["target"].as_str().unwrap_or_default(),
            edge["type"].as_str().unwrap_or_default(),
        )
    };
    edges.sort_by(|left, right| {
        let left_key = edge_key(left);
        let right_key = edge_key(right);
        traversal_order
            .get(&left_key)
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
            .cmp(
                &traversal_order
                    .get(&right_key)
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX),
            )
            .then_with(|| javascript_ascii_cmp(&left_key, &right_key))
    });
    let summary = payload
        .pointer("/lifecycleContext/coverage/summary")
        .and_then(Value::as_object);
    let coverage_count = |key: &str| {
        summary
            .and_then(|summary| summary.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let node_count =
        |predicate: &dyn Fn(&Value) -> bool| nodes.iter().filter(|node| predicate(node)).count();
    result["stats"] = json!({
        "scannedFiles": coverage_count("scannedFiles"),
        "nodes": nodes.len(),
        "edges": edges.len(),
        "services": node_count(&|node| node["nodeType"] == "service"),
        "classes": node_count(&|node| node["kind"] == "symbol" && node["nodeType"] == "class"),
        "functions": node_count(&|node| node["kind"] == "symbol" && node["nodeType"] == "function"),
        "calls": edges.iter().filter(|edge| edge["type"] == "calls").count(),
        "endpoints": node_count(&|node| node["kind"] == "endpoint"),
        "commandEntries": node_count(&|node| node["kind"] == "command" && matches!(node.pointer("/metadata/entryKind").and_then(Value::as_str), Some("package-script") | Some("django-management-command") | Some("framework-command"))),
        "scheduledEntries": node_count(&|node| node["kind"] == "schedule" && node.pointer("/metadata/entryKind").and_then(Value::as_str) == Some("node-cron-schedule")),
        "tests": node_count(&|node| node["nodeType"] == "test"),
        "runtimeDependencies": node_count(&|node| node.pointer("/metadata/layer").and_then(Value::as_str) == Some("runtime")),
        "parsedFiles": coverage_count("parsedFiles"),
        "inventoryOnlyFiles": coverage_count("inventoryOnlyFiles"),
        "parseFailedFiles": coverage_count("parseFailedFiles"),
    });
    result["nodes"] = Value::Array(
        nodes
            .into_iter()
            .map(|mut node| {
                let object = node
                    .as_object_mut()
                    .expect("validated structural node remains an object");
                let mut public = object
                    .remove("metadata")
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                public.insert("id".to_string(), object.remove("id").unwrap_or(Value::Null));
                public.insert(
                    "kind".to_string(),
                    object.remove("kind").unwrap_or(Value::Null),
                );
                public.insert(
                    "type".to_string(),
                    object.remove("nodeType").unwrap_or(Value::Null),
                );
                public.insert(
                    "path".to_string(),
                    object.remove("path").unwrap_or(Value::Null),
                );
                Value::Object(public)
            })
            .collect(),
    );
    result["edges"] = Value::Array(
        edges
            .into_iter()
            .map(|mut edge| {
                let object = edge
                    .as_object_mut()
                    .expect("validated structural edge remains an object");
                json!({
                    "source": object.remove("source").unwrap_or(Value::Null),
                    "target": object.remove("target").unwrap_or(Value::Null),
                    "type": object.remove("type").unwrap_or(Value::Null),
                    "confidence": object.remove("confidence").unwrap_or(Value::Null),
                    "evidence": object.remove("evidence").unwrap_or(Value::Null),
                })
            })
            .collect(),
    );
    result["flows"] = payload["flows"].take();
    result["diagnosticFlows"] = payload["diagnosticFlows"].take();
    Ok(result)
}

pub(in crate::protocol) fn native_public_graph_snapshot(
    payload: &Value,
) -> Result<Value, NativeProtocolError> {
    native_public_graph_snapshot_with_public_context(payload, None)
}

// Build the source-safe native projection directly from a verified fact batch.
// This deliberately opens no SQLite store and is shared by the ephemeral
// public-graph probe and the process-local cache-disabled lifecycle.
pub(in crate::protocol) fn assemble_native_public_payload(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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
pub(in crate::protocol) fn assemble_native_public_graph(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let payload = assemble_native_public_payload(params)?;
    Ok(json!({
        "schemaVersion": "flopeek-native-public-graph/v1",
        "graph": native_public_graph_snapshot(&payload)?,
        "persistence": "ephemeral-jsonl-only",
        "limitation": "This is a native graph reconstruction for shadow parity and cache-disabled sessions. JavaScript remains the public default until the rollout gate passes.",
    }))
}

pub(in crate::protocol) fn same_canonical_json(left: &Value, right: &Value) -> bool {
    // `serde_json::Value` equality retains JSON semantics: object members are
    // compared as a map (regardless of insertion order), while array order is
    // significant. The former recursive canonicalizer only cloned complete
    // graph values before asking this same question, making adjacent-delta
    // calculation scale with payload size without changing its answer.
    left == right
}

pub(in crate::protocol) fn same_json_object_fields(
    left: &Value,
    right: &Value,
    fields: &[&str],
) -> bool {
    fields.iter().all(|field| left[*field] == right[*field])
}

pub(in crate::protocol) fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub(in crate::protocol) fn member_summary_value(node: &Value) -> Value {
    json!({
        "id": node["id"].clone(),
        "label": node["label"].clone(),
        "type": node["type"].clone(),
        "kind": node["kind"].clone(),
        "path": node["path"].clone(),
    })
}

pub(in crate::protocol) fn edge_summary_value(edge: &Value) -> Value {
    json!({
        "source": edge["source"].clone(),
        "target": edge["target"].clone(),
        "type": edge["type"].clone(),
        "confidence": edge["confidence"].clone(),
    })
}

pub(in crate::protocol) fn flow_summary_value(flow: &Value) -> Value {
    json!({
        "id": flow["id"].clone(),
        "title": flow["title"].clone(),
        "entryId": flow["entryId"].clone(),
        "entry": flow["entry"].clone(),
        "steps": flow["steps"].as_array().into_iter().flatten().map(|step| json!({"id":step["id"].clone(),"depth":step["depth"].clone()})).collect::<Vec<_>>(),
    })
}

pub(in crate::protocol) fn compared_items(
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

pub(in crate::protocol) fn unique_sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(in crate::protocol) fn transition_ids(step: &Value) -> Vec<String> {
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

pub(in crate::protocol) fn flow_lens_snapshot(payload: &Value, flow_id: &str) -> Option<Value> {
    let lens = payload["flowLenses"]
        .as_array()?
        .iter()
        .find(|lens| lens["flow"]["id"] == flow_id)?;
    Some(
        json!({"schemaVersion":"flopeek-flow-lens-snapshot/v1","id":lens["id"].clone(),"project":lens["project"].clone(),"flow":lens["flow"].clone(),"knowledgeClass":lens["knowledgeClass"].clone(),"confidence":lens["confidence"].clone(),"steps":lens["steps"].clone(),"staticBoundaries":lens["staticBoundaries"].clone(),"truncation":lens["truncation"].clone(),"limitations":lens["limitations"].clone()}),
    )
}

pub(in crate::protocol) fn flow_comparison_changes(
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

pub(in crate::protocol) fn native_public_graph_delta(
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

pub(in crate::protocol) fn native_public_graph_delta_from_public_snapshots(
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
pub(in crate::protocol) fn native_public_graph_delta_with_reused_collections(
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

pub(in crate::protocol) fn native_public_graph_delta_with_collection_baseline(
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

pub(in crate::protocol) fn get_native_public_graph_snapshot(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

// Materialize only an exact, verified graph handle. Persistent handles must
// still match SQLite's current complete pointer; session handles must still
// exist in the owning JSONL process. This prevents a compatibility surface
// from silently reading a different graph version or falling back to
// JavaScript graph.json.
pub(in crate::protocol) fn materialize_native_graph(
    session: &NativeProtocolSession,
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    if let Some(handle) = params.get("sessionGraph").and_then(Value::as_object) {
        let schema = handle.get("schemaVersion").and_then(Value::as_str);
        let project_id = handle
            .get("projectId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let facts_digest = handle
            .get("factsDigest")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let public_graph_version = handle
            .get("publicGraphVersion")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0);
        if schema != Some("flopeek-native-session-graph-handle/v1")
            || handle.get("persistence").and_then(Value::as_str) != Some("session-memory")
            || project_id.is_none()
            || facts_digest.is_none()
            || public_graph_version.is_none()
        {
            return Err(NativeProtocolError {
                code: "invalid-params",
                message: "materializeNativeGraph received an invalid session graph handle."
                    .to_string(),
            });
        }
        let project_id = project_id.expect("validated session project ID");
        let facts_digest = facts_digest.expect("validated session facts digest");
        let public_graph_version = public_graph_version.expect("validated session graph version");
        let key = native_session_graph_key(project_id, public_graph_version);
        let retained = session
            .session_query_graphs
            .get(&key)
            .filter(|graph| graph.facts_digest == facts_digest)
            .ok_or_else(|| session.session_graph_error(project_id, public_graph_version))?;
        let mut graph = native_public_graph_snapshot(&retained.payload)?;
        graph["state"] = retained.public_state.clone();
        graph["analysis"]["graphState"] = retained.public_graph_state.clone();
        graph["analysis"]["latestDelta"] = retained.latest_delta.clone().unwrap_or(Value::Null);
        graph["analysis"]["graphState"]["transport"] = Value::String("materialized".to_string());
        if graph["project"]["projectId"].as_str() != Some(project_id)
            || graph["state"]["graphVersion"].as_i64() != Some(public_graph_version)
            || graph["analysis"]["graphState"]["materialFingerprint"].as_str() != Some(facts_digest)
        {
            return Err(NativeProtocolError {
                code: "native-materialization-identity-mismatch",
                message: "The retained session graph does not match its verified handle."
                    .to_string(),
            });
        }
        return Ok(json!({
            "schemaVersion": "flopeek-native-materialized-graph/v1",
            "persistence": "session-memory",
            "graph": graph,
            "limitation": "This explicit compatibility snapshot is valid only in the owning native JSONL session.",
        }));
    }

    let root = project_root(params)?;
    let handle = params
        .get("graphHandle")
        .and_then(Value::as_object)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "materializeNativeGraph requires params.graphHandle or params.sessionGraph."
                .to_string(),
        })?;
    let project_id = handle
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "materializeNativeGraph graphHandle.projectId is required.".to_string(),
        })?;
    let facts_digest = handle
        .get("factsDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "materializeNativeGraph graphHandle.factsDigest is required.".to_string(),
        })?;
    let public_graph_version = handle
        .get("publicGraphVersion")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "materializeNativeGraph graphHandle.publicGraphVersion must be positive."
                .to_string(),
        })?;
    if handle.get("schemaVersion").and_then(Value::as_str) != Some("flopeek-native-graph-handle/v1")
        || handle.get("persistence").and_then(Value::as_str) != Some("sqlite")
    {
        return Err(NativeProtocolError {
            code: "invalid-params",
            message: "materializeNativeGraph received an invalid persistent graph handle."
                .to_string(),
        });
    }
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let current = current_complete_graph(&connection, project_id)
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?
        .filter(|current| {
            current.public_graph_version == Some(public_graph_version)
                && current.material_fingerprint == facts_digest
        })
        .ok_or_else(|| NativeProtocolError {
            code: "native-materialization-handle-stale",
            message:
                "The persistent graph handle does not match SQLite's current complete pointer."
                    .to_string(),
        })?;
    let payload = complete_graph_payload(&connection, project_id, current.graph_version)
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| NativeProtocolError {
            code: "missing-native-graph",
            message: "The verified persistent graph payload is unavailable.".to_string(),
        })?;
    let mut graph = native_public_graph_snapshot(&payload.payload)?;
    graph["analysis"]["graphState"] = json!({
        "schemaVersion": "flopeek-native-graph-state/v1",
        "status": "materialized",
        "persistence": "sqlite",
        "nativeGraphVersion": current.graph_version,
        "graphVersion": public_graph_version,
        "materialFingerprint": facts_digest,
        "sourceFingerprint": current.source_fingerprint,
        "sourceRevision": graph["state"]["sourceRevision"].clone(),
        "updatedAt": graph["state"]["updatedAt"].clone(),
        "latestDelta": Value::Null,
        "limitation": "This state authenticates an explicit compatibility materialization of SQLite's exact current complete graph.",
    });
    graph["analysis"]["graphState"]["transport"] = Value::String("materialized".to_string());
    if graph["project"]["projectId"].as_str() != Some(project_id)
        || graph["state"]["graphVersion"].as_i64() != Some(public_graph_version)
        || graph["analysis"]["graphState"]["materialFingerprint"].as_str() != Some(facts_digest)
    {
        return Err(NativeProtocolError {
            code: "native-materialization-identity-mismatch",
            message: "The persistent public graph does not match its verified handle.".to_string(),
        });
    }
    Ok(json!({
        "schemaVersion": "flopeek-native-materialized-graph/v1",
        "persistence": "sqlite",
        "graph": graph,
        "limitation": "This is an explicit compatibility snapshot of SQLite's exact current complete graph.",
    }))
}

// Read only the project pointer to the last transactionally complete graph.
// This is the native last-complete fallback: it never consults graph.json and
// never serves a `building` version after a failed refresh.
pub(in crate::protocol) fn get_native_current_public_graph(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

// Open SQLite afresh and read only the current complete-graph metadata row.
// This evidence path deliberately never calls complete_graph_payload or parses
// payload_json, so its counters are structural properties of this exact code
// path rather than caller-supplied attestations.
pub(in crate::protocol) fn get_native_database_open_evidence(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNativeDatabaseOpenEvidence requires params.projectId.".to_string(),
        })?;
    let canonical_root = fs::canonicalize(&root).unwrap_or(root);
    let connection = open_native_store(&canonical_root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let current = current_complete_graph(&connection, project_id)
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| NativeProtocolError {
            code: "missing-native-graph",
            message: "No complete native graph is available for database-open evidence."
                .to_string(),
        })?;
    Ok(json!({
        "schemaVersion": "flopeek-native-database-open-observation/v1",
        "operation": "open-current-graph",
        "fullPayloadDeserialized": false,
        "nativeGraphVersion": current.graph_version,
        "publicGraphVersion": current.public_graph_version,
        "observations": {
            "schemaVersion": "flopeek-native-database-open-observation/v1",
            "sqliteOperations": ["current-complete-graph-metadata"],
            "currentGraphFound": true,
            "graphPayloadRowsRead": 0,
            "graphPayloadBytesDeserialized": 0,
        },
    }))
}

pub(in crate::protocol) fn get_native_public_graph_delta(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn public_context_ref(
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

pub(in crate::protocol) fn get_native_changed_contexts(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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
