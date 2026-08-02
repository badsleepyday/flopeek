use super::super::*;

pub(in crate::protocol) fn get_related_tests(params: &Value) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn query_changed_paths(params: &Value) -> Vec<String> {
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

pub(in crate::protocol) fn query_max_depth(params: &Value) -> usize {
    params
        .get("maxDepth")
        .and_then(Value::as_u64)
        .unwrap_or(6)
        .min(12) as usize
}
