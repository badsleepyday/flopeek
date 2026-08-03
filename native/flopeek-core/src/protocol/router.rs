use super::*;

pub(super) fn native_query_cache_key(method: &str, params: &Value) -> Option<String> {
    (params.get("batch").is_none()
        && (params.get("factsDigest").is_some() || params.get("sessionGraph").is_some()))
    .then(|| {
        serde_json::to_string(&json!({ "method": method, "params": params }))
            .expect("validated native request parameters serialize")
    })
}

pub(super) fn handle_request(
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
    let identity_v2_requested = request
        .params
        .get("experimentalIdentityV2")
        .and_then(Value::as_bool)
        == Some(true);
    if matches!(
        request.method.as_str(),
        "createContextRefV2" | "getNodeIdentity" | "searchNodeIdentities"
    ) && !identity_v2_requested
    {
        return (
            error_response(
                Some(request.request_id),
                "experimental-capability-disabled",
                "Canonical identity v2 is experimental and requires params.experimentalIdentityV2=true.",
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
            | "createContextRefV2"
            | "getNodeIdentity"
            | "searchNodeIdentities"
            | "resolveNativeContextRef"
            | "getNativeFlowLensCore"
            | "getNativeNodeContextCard"
            | "getNativeFlowContextCard"
            | "getNativeScanStatus"
            | "getNativeProjectOverviewCore"
            | "getRelatedTests"
            | "getChangeImpact"
    );
    // Only reference-based immutable graph reads are memoized. Inline batches
    // remain one-shot protocol inputs: hashing their multi-megabyte payload to
    // manufacture a cache key would merely move the original bottleneck.
    let query_cache_key = accepts_cached_fact_reference
        .then(|| native_query_cache_key(&request.method, &request.params))
        .flatten();
    if let Some(mut cached) = query_cache_key
        .as_deref()
        .and_then(|key| session.query_result(key))
    {
        cached.request_id = Some(request.request_id);
        return (cached, false);
    }
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
    let routed = match request.method.as_str() {
        "health" => {
            let mut capabilities = vec![
                "health",
                "initialize",
                "nativeIncrementalManifest",
                "nativeBoundedDiscovery",
                "refreshNativeProject",
                "refreshNativePersistentProject",
                "nativeJsRecordCache",
                "nativeJsStructuralFacts",
                "submitStructuralFacts",
                "assembleStructuralGraph",
                "assembleNativePublicGraph",
                "assembleNativeFlows",
                "findNodes",
                "getNodeDetails",
                "getEntryFlows",
                "getRequestFlows",
                "createContextRef",
                "resolveNativeContextRef",
                "getNativeFlowLensCore",
                "getNativeNodeContextCard",
                "getNativeFlowContextCard",
                "getNativeScanStatus",
                "getNativeProjectOverviewCore",
                "getRelatedTests",
                "getChangeImpact",
                "persistStructuralGraph",
                "persistNativePublicGraph",
                "persistNativePublicGraphPatch",
                "refreshNativeSessionGraph",
                "refreshNativeJsSessionGraph",
                "getNativeStructuralDelta",
                "getNativePublicGraphSnapshot",
                "getNativeCurrentPublicGraph",
                "getNativeDatabaseOpenEvidence",
                "materializeNativeGraph",
                "getNativePublicGraphDelta",
                "getNativeChangedContexts",
                "shutdown",
            ];
            if identity_v2_requested {
                capabilities.extend([
                    "createContextRefV2",
                    "getNodeIdentity",
                    "searchNodeIdentities",
                ]);
            }
            (
                success_response(
                    request.request_id,
                    json!({
                    "implementation": "rust",
                    "capabilities": capabilities,
                    "experimentalCapabilities": if identity_v2_requested { json!(["canonical-identity-v2"]) } else { json!([]) },
                    "storeAuthoritative": false,
                    "publicNodeIdsEnabled": true,
                    "sessionGraphHistory": {
                        "limit": session.session_history_limit,
                        "configuration": "FLOPEEK_NATIVE_SESSION_HISTORY",
                        "default": DEFAULT_NATIVE_SESSION_HISTORY,
                    },
                    "adapterCapabilities": native_adapter_registry(),
                    "executionAdapterCapabilities": native_execution_adapter_registry(),
                    }),
                ),
                false,
            )
        }
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
                Ok(result) => {
                    delay_at_test_boundary("after-promotion-before-response");
                    (success_response(request.request_id, result), false)
                }
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
        "createContextRefV2" => match create_native_context_ref_v2(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "getNodeIdentity" => match get_native_node_identity(&request.params) {
            Ok(result) => (success_response(request.request_id, result), false),
            Err(error) => (
                error_response(Some(request.request_id), error.code, error.message),
                false,
            ),
        },
        "searchNodeIdentities" => match search_native_node_identities(&request.params) {
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
                Ok(result) => {
                    delay_at_test_boundary("after-promotion-before-response");
                    (success_response(request.request_id, result), false)
                }
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "persistNativePublicGraphPatch" => {
            match persist_native_public_graph_patch(session, &request.params) {
                Ok(result) => {
                    delay_at_test_boundary("after-promotion-before-response");
                    (success_response(request.request_id, result), false)
                }
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
        "getNativeDatabaseOpenEvidence" => {
            match get_native_database_open_evidence(&request.params) {
                Ok(result) => (success_response(request.request_id, result), false),
                Err(error) => (
                    error_response(Some(request.request_id), error.code, error.message),
                    false,
                ),
            }
        }
        "materializeNativeGraph" => match materialize_native_graph(session, &request.params) {
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
                "Supported methods are health, initialize, nativeIncrementalManifest, nativeBoundedDiscovery, refreshNativeProject, refreshNativePersistentProject, nativeJsRecordCache, nativeJsStructuralFacts, submitStructuralFacts, assembleStructuralGraph, assembleNativePublicGraph, assembleNativeFlows, findNodes, getNodeDetails, getEntryFlows, getRequestFlows, createContextRef, createContextRefV2, getNodeIdentity, resolveNativeContextRef, getNativeFlowLensCore, getNativeNodeContextCard, getNativeFlowContextCard, getNativeScanStatus, getNativeProjectOverviewCore, getRelatedTests, getChangeImpact, persistStructuralGraph, persistNativePublicGraph, persistNativePublicGraphPatch, refreshNativeSessionGraph, refreshNativeJsSessionGraph, getNativeStructuralDelta, getNativePublicGraphSnapshot, getNativeCurrentPublicGraph, getNativeDatabaseOpenEvidence, materializeNativeGraph, getNativePublicGraphDelta, getNativeChangedContexts, and shutdown.",
            ),
            false,
        ),
    };
    if let Some(key) = query_cache_key {
        session.retain_query_result(key, routed.0.clone());
    }
    routed
}
