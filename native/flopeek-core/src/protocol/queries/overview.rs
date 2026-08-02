use super::super::*;

pub(in crate::protocol) fn native_agent_bootstrap(
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

pub(in crate::protocol) fn native_agent_entry_reason_counts(entries: Option<&Vec<Value>>) -> Value {
    let mut counts = BTreeMap::<String, usize>::new();
    for entry in entries.into_iter().flatten() {
        if let Some(reason) = entry.get("reason").and_then(Value::as_str) {
            *counts.entry(reason.to_string()).or_default() += 1;
        }
    }
    json!(counts)
}

pub(in crate::protocol) fn native_agent_entry_inventory(graph: &Value) -> Value {
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

pub(in crate::protocol) fn native_agent_context_core(
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
        "executionAdapterCapabilities": graph.pointer("/analysis/executionAdapterCapabilities").cloned().unwrap_or(Value::Null),
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

pub(in crate::protocol) fn native_view_graph(
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

pub(in crate::protocol) fn native_view_option<'a>(
    params: &'a Value,
    key: &str,
    fallback: &'a str,
) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

pub(in crate::protocol) fn native_scope_visible(node: &Value, scope: &str) -> bool {
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

pub(in crate::protocol) fn native_capitalise(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), characters.as_str()),
        None => String::new(),
    }
}

pub(in crate::protocol) fn native_humanize_segment(value: &str) -> String {
    if value == "api" {
        return "API".to_string();
    }
    value
        .split('-')
        .map(native_capitalise)
        .collect::<Vec<_>>()
        .join(" ")
}

pub(in crate::protocol) fn native_feature_key(node: &Value) -> String {
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

pub(in crate::protocol) fn native_domain_key(node: &Value) -> String {
    value_string(node, "domain").if_empty("project")
}

pub(in crate::protocol) fn native_component_key(node: &Value) -> String {
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

pub(in crate::protocol) fn native_feature_label(key: &str) -> String {
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

pub(in crate::protocol) fn native_uri_component(value: &str) -> String {
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

pub(in crate::protocol) fn native_hierarchy_id(level: &str, parts: &[String]) -> String {
    format!(
        "{level}:{}",
        parts
            .iter()
            .map(|part| native_uri_component(part))
            .collect::<Vec<_>>()
            .join(":")
    )
}

pub(in crate::protocol) fn native_hierarchy_parts(key: &str) -> Vec<String> {
    key.split('\0').map(ToString::to_string).collect()
}

pub(in crate::protocol) fn native_semantic_label(level: &str, key: &str) -> String {
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

pub(in crate::protocol) fn native_parent_hierarchy_id(level: &str, key: &str) -> Value {
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

pub(in crate::protocol) fn native_decode_component(value: &str) -> String {
    let mut bytes = Vec::new();
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%'
            && index + 2 < input.len()
            && let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            bytes.push(byte);
            index += 3;
            continue;
        }
        bytes.push(input[index]);
        index += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_string())
}

pub(in crate::protocol) fn native_focus_matches(node: &Value, focus: Option<&str>) -> bool {
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

pub(in crate::protocol) fn native_supported_flow_entry(node: &Value) -> bool {
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
pub(in crate::protocol) fn native_entry_source_nodes(
    graph: &Value,
    visible: &[Value],
) -> Vec<Value> {
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

pub(in crate::protocol) fn native_summary_type(members: &[Value], key: &str) -> String {
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

pub(in crate::protocol) fn native_aggregate_projection(
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

pub(in crate::protocol) fn native_projection_limit(
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

pub(in crate::protocol) fn native_bounded_projection(
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

pub(in crate::protocol) fn native_project_overview_core(
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

pub(in crate::protocol) fn impact_node(
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

pub(in crate::protocol) fn get_change_impact(params: &Value) -> Result<Value, NativeProtocolError> {
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
