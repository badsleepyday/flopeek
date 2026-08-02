use super::super::*;

pub(in crate::protocol) struct ParsedNativeContextRef {
    project_id: String,
    kind: String,
    context_id: String,
    graph_version: u64,
}

pub(in crate::protocol) fn decode_context_part(value: &str) -> Result<String, ()> {
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

pub(in crate::protocol) fn parse_native_context_ref(
    value: &str,
) -> Result<ParsedNativeContextRef, NativeProtocolError> {
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

pub(in crate::protocol) fn native_unresolved_context_ref(
    value: &str,
    reason: impl Into<String>,
    code: &str,
) -> Value {
    json!({
        "status": "unresolved",
        "requestedRef": value,
        "reason": reason.into(),
        "code": code,
        "card": Value::Null,
        "successorCandidates": [],
    })
}

pub(in crate::protocol) fn native_public_delta_history(
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
        let history = params.get("sessionContextHistory");
        let adjacent_delta = history
            .and_then(|value| value.get("adjacentDelta"))
            .filter(|value| {
                value.get("fromGraphVersion").and_then(Value::as_u64) == Some(from_version)
                    && value.get("toGraphVersion").and_then(Value::as_u64) == Some(to_version)
            })
            .cloned();
        let expired_through = history
            .and_then(|value| value.get("expiredThroughVersion"))
            .and_then(Value::as_i64);
        let current_version = history
            .and_then(|value| value.get("currentGraphVersion"))
            .and_then(Value::as_i64);
        let range = match (expired_through, current_version) {
            (Some(expired), Some(current)) => Some((expired.saturating_add(1), current)),
            _ => adjacent_delta.as_ref().and_then(|delta| {
                Some((
                    delta.get("fromGraphVersion")?.as_i64()?,
                    delta.get("toGraphVersion")?.as_i64()?,
                ))
            }),
        };
        return Ok((adjacent_delta, range));
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

pub(in crate::protocol) fn native_expired_history_resolution(
    requested: &str,
    kind: &str,
    retained: (i64, i64),
) -> Value {
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

pub(in crate::protocol) fn native_successor_candidates(
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

pub(in crate::protocol) fn resolve_native_context_ref(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let requested = params
        .get("contextRef")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "resolveNativeContextRef requires params.contextRef.".to_string(),
        })?;
    let mut parsed = match parse_native_context_ref(requested) {
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
    let mut canonical_node_ref = None;
    if parsed.kind == "node" && parsed.context_id.starts_with("n_") {
        let mut identity_params = params.clone();
        identity_params["projectId"] = Value::String(project_id.to_string());
        identity_params["nodeUid"] = Value::String(parsed.context_id.clone());
        let identity = get_native_node_identity(&identity_params)?;
        if identity.is_null() {
            return Ok(native_unresolved_context_ref(
                requested,
                "Canonical node UID is not present in this project identity store.",
                "node-uid-not-found",
            ));
        }
        let status = identity["status"].as_str().unwrap_or("ambiguous");
        let legacy_id = identity["legacyId"].as_str();
        if status != "active" || legacy_id.is_none() {
            return Ok(json!({
                "status": if status == "ambiguous" { "ambiguous" } else { "historical" },
                "requestedRef": requested,
                "resolvedRef": Value::Null,
                "card": Value::Null,
                "successorCandidates": [],
                "identity": identity,
                "reason": "The canonical node identity is retained, but it has no active public graph placement.",
            }));
        }
        canonical_node_ref = Some(format!(
            "fp://local/{}/node/{}@{current_version}",
            encode_context_part(project_id),
            encode_context_part(&parsed.context_id)
        ));
        parsed.context_id = legacy_id.expect("checked").to_string();
    }
    if parsed.kind == "node" && canonical_node_ref.is_none() && params.get("projectRoot").is_some()
    {
        let mut identity_params = params.clone();
        identity_params["projectId"] = Value::String(project_id.to_string());
        identity_params["nodeId"] = Value::String(parsed.context_id.clone());
        let identity = get_native_node_identity(&identity_params)?;
        let current_legacy_id = identity.get("legacyId").and_then(Value::as_str);
        if identity["status"] == "active"
            && current_legacy_id.is_some_and(|current| current != parsed.context_id)
        {
            let node_uid = identity["nodeUid"]
                .as_str()
                .expect("stored node identities always include a UID");
            canonical_node_ref = Some(format!(
                "fp://local/{}/node/{}@{current_version}",
                encode_context_part(project_id),
                encode_context_part(node_uid)
            ));
            parsed.context_id = current_legacy_id.expect("checked").to_string();
        }
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
    let mut card = match card {
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
    if let Some(context_ref) = canonical_node_ref {
        card["contextRef"] = Value::String(context_ref);
    }
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
    if let Some(object) = result.as_object_mut()
        && let Some(delta) = delta
    {
        object.insert("delta".to_string(), delta);
    }
    Ok(result)
}
