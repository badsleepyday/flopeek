use super::super::*;

pub(in crate::protocol) fn native_member_summary(
    node: &crate::structural_graph::StructuralGraphNode,
) -> Value {
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

pub(in crate::protocol) fn metadata<'a>(
    node: &'a StructuralGraphNode,
    key: &str,
) -> Option<&'a Value> {
    node.metadata.as_ref()?.as_object()?.get(key)
}

pub(in crate::protocol) fn metadata_string(
    node: &StructuralGraphNode,
    key: &str,
) -> Option<String> {
    metadata(node, key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(in crate::protocol) fn node_label(node: &StructuralGraphNode) -> String {
    metadata_string(node, "label").unwrap_or_else(|| node.id.clone())
}

pub(in crate::protocol) fn flow_source_scope(node: &StructuralGraphNode) -> String {
    metadata_string(node, "sourceScope").unwrap_or_else(|| "application".to_string())
}

pub(in crate::protocol) fn flow_entry_kind(node: &StructuralGraphNode) -> Option<String> {
    metadata_string(node, "entryKind")
}

pub(in crate::protocol) fn is_native_flow_entry(node: &StructuralGraphNode) -> bool {
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

pub(in crate::protocol) fn native_edge_key(
    edge: &crate::structural_graph::StructuralGraphEdge,
) -> String {
    format!("{}\0{}\0{}", edge.source, edge.target, edge.edge_type)
}

/// JavaScript orders public graph nodes by display label. Entry ordering is
/// therefore a property of the native structural projection, not a graph-order
/// hint that the JavaScript oracle needs to send across the protocol boundary.
/// The shared comparator preserves the audited ASCII punctuation rules and
/// uses ICU-backed collation for non-ASCII labels and public IDs.
pub(in crate::protocol) fn native_entry_cmp(
    left: &&StructuralGraphNode,
    right: &&StructuralGraphNode,
) -> std::cmp::Ordering {
    javascript_ascii_cmp(&node_label(left), &node_label(right))
        .then_with(|| javascript_ascii_cmp(&left.id, &right.id))
}

pub(in crate::protocol) fn flow_contract(node: &StructuralGraphNode) -> Value {
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

pub(in crate::protocol) fn assemble_native_flows_from_projection(
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

pub(in crate::protocol) fn assemble_native_flows_for_scope(
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

pub(in crate::protocol) fn configured_flow_scope(batch: &Value, name: &str) -> (bool, bool) {
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

pub(in crate::protocol) fn assemble_native_flows(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let (include_tests, include_fixtures) = configured_flow_scope(batch, "primary");
    assemble_native_flows_for_scope(params, include_tests, include_fixtures)
}

pub(in crate::protocol) fn assemble_native_diagnostic_flows(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    let (include_tests, include_fixtures) = configured_flow_scope(batch, "diagnostic");
    assemble_native_flows_for_scope(params, include_tests, include_fixtures)
}

pub(in crate::protocol) fn get_native_entry_flows(
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

pub(in crate::protocol) fn native_scope_includes(scope: &str, layer: &str) -> bool {
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

pub(in crate::protocol) fn native_node_rank(node: &StructuralGraphNode) -> usize {
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

pub(in crate::protocol) fn get_native_find_nodes(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn get_native_node_details(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn encode_context_part(value: &str) -> String {
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

pub(in crate::protocol) fn create_native_context_ref(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn get_native_node_identity(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "getNodeIdentity requires params.projectId.".to_string(),
        })?;
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let identity = if let Some(node_uid) = params
        .get("nodeUid")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        node_identity_by_uid(&connection, project_id, node_uid)
    } else {
        let node_id = params
            .get("nodeId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-params",
                message: "getNodeIdentity requires params.nodeId or params.nodeUid.".to_string(),
            })?;
        node_identity_by_external_id(&connection, project_id, node_id)
    }
    .map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    serde_json::to_value(identity).map_err(|error| NativeProtocolError {
        code: "identity-serialize-failed",
        message: error.to_string(),
    })
}

pub(in crate::protocol) fn search_native_node_identities(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let root = project_root(params)?;
    let project_id = params
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "searchNodeIdentities requires params.projectId.".to_string(),
        })?;
    let query = params
        .get("query")
        .or_else(|| params.get("q"))
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "searchNodeIdentities requires params.query.".to_string(),
        })?;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .min(50) as usize;
    let connection = open_native_store(&root).map_err(|error| NativeProtocolError {
        code: "store-read-failed",
        message: error.to_string(),
    })?;
    let results =
        search_node_identities(&connection, project_id, query, limit).map_err(|error| {
            NativeProtocolError {
                code: "store-read-failed",
                message: error.to_string(),
            }
        })?;
    serde_json::to_value(json!({ "query": query, "results": results })).map_err(|error| {
        NativeProtocolError {
            code: "identity-serialize-failed",
            message: error.to_string(),
        }
    })
}

pub(in crate::protocol) fn create_native_context_ref_v2(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
    let batch = structural_batch(params)?;
    submit_structural_facts(batch)?;
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "createContextRefV2 requires params.kind.".to_string(),
        })?;
    if kind != "node" {
        return Err(NativeProtocolError {
            code: "unsupported-context-kind",
            message: "Context Ref v2 currently supports canonical node identities only."
                .to_string(),
        });
    }
    let node_id = params
        .get("contextId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-params",
            message: "createContextRefV2 requires params.contextId.".to_string(),
        })?;
    let project_id = batch["projectId"].as_str().unwrap_or_default();
    let version = batch["flowContext"]["graphVersion"]
        .as_u64()
        .ok_or_else(|| NativeProtocolError {
            code: "invalid-flow-context",
            message:
                "StructuralFactBatch/v1 flowContext.graphVersion must be a non-negative integer."
                    .to_string(),
        })?;
    let mut identity_params = params.clone();
    identity_params["projectId"] = Value::String(project_id.to_string());
    identity_params["nodeId"] = Value::String(node_id.to_string());
    let identity = get_native_node_identity(&identity_params)?;
    let node_uid = identity
        .get("nodeUid")
        .and_then(Value::as_str)
        .ok_or_else(|| NativeProtocolError {
            code: "node-identity-not-found",
            message: "No canonical node identity exists for the requested legacy node ID."
                .to_string(),
        })?;
    Ok(json!(format!(
        "fp://local/{}/node/{}@{version}",
        encode_context_part(project_id),
        encode_context_part(node_uid)
    )))
}

pub(in crate::protocol) fn flow_step_role(node: &StructuralGraphNode) -> &'static str {
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

pub(in crate::protocol) fn flow_static_boundary(
    node: &StructuralGraphNode,
) -> Option<&'static str> {
    match node.node_type.as_str() {
        "database" => Some("persistence"),
        "queue" => Some("async"),
        "external" => Some("external"),
        _ => None,
    }
}

pub(in crate::protocol) fn flow_edge_evidence(
    edge: &crate::structural_graph::StructuralGraphEdge,
) -> Value {
    json!({"id":format!("edge:{}|{}|{}",edge.source,edge.edge_type,edge.target),"sourceId":&edge.source,"targetId":&edge.target,"type":&edge.edge_type,"confidence":edge.confidence.clone().unwrap_or_else(||json!("unknown")),"evidence":edge.evidence.clone().unwrap_or(Value::Null)})
}

pub(in crate::protocol) fn native_flow_lens_from_assembled(
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

pub(in crate::protocol) fn native_flow_lens_core(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn native_context_relationship(
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

pub(in crate::protocol) fn native_node_context_card(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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

pub(in crate::protocol) fn native_flow_context_card(
    params: &Value,
) -> Result<Value, NativeProtocolError> {
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
        if let Some(path) = step["node"]["path"].as_str()
            && let Some(file_id) = file_ids_by_path.get(path)
        {
            step_ids.insert((*file_id).to_string());
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
