use super::*;

// Cache-disabled scans must retain a coherent graph lifecycle for the life of
// one native JSONL process, but must never create a repository store. This is
// intentionally small and process-local: shutdown drops every graph and a
// Context Ref issued here remains valid only in the owning CoreClient session.
#[derive(Clone)]
pub(super) struct NativeSessionGraph {
    pub(super) facts_digest: String,
    pub(super) topology_digest: String,
    pub(super) public_graph_version: i64,
    // The assembled native public payload is retained for adjacent public
    // graph deltas. It is not accepted by query handlers.
    pub(super) payload: Arc<Value>,
    // Query handlers accept the original StructuralFactBatch. Retain it once
    // in Rust so cache-disabled Node callers can refer to it by graph handle.
    pub(super) query_batch: Arc<Value>,
    // Materialization is an explicit compatibility operation. Retain only the
    // small mutable envelope fields needed to reconstruct the exact public
    // session graph from the already-owned native payload.
    pub(super) public_state: Value,
    pub(super) public_graph_state: Value,
    pub(super) latest_delta: Option<Value>,
}

// One bounded derived cache for the current complete persistent graph. SQLite
// remains authoritative: every use is gated by the current SQLite pointer's
// project ID and native graph version, and a different pointer replaces this
// value before it can be used. This avoids parsing the same multi-megabyte
// payload again solely to calculate the next adjacent delta.
#[derive(Clone)]
pub(super) struct NativePersistentGraph {
    pub(super) project_id: String,
    pub(super) graph_version: i64,
    pub(super) payload: Value,
    // A derived process-local snapshot avoids rebuilding the previous public
    // graph solely for an adjacent source-only delta. SQLite remains the
    // authority: callers may use this only after matching the project and
    // complete graph version selected by SQLite.
    pub(super) public_snapshot: Option<Value>,
}

// The complete fact batch is larger than the public graph snapshot, but it is
// immutable for one complete graph version. Keep one process-local copy so a
// persistent JSONL client does not reread and parse it on every fact patch.
// SQLite's current pointer is checked before every reuse; this cache is never
// authoritative and is discarded when another process advances the graph.
#[derive(Clone)]
pub(super) struct NativePersistentFactHeader {
    pub(super) relative_path: String,
    pub(super) source_hash: String,
    pub(super) source_scope: String,
    pub(super) record_order: u64,
}

#[derive(Clone)]
pub(super) struct NativePersistentFacts {
    pub(super) project_id: String,
    pub(super) graph_version: i64,
    pub(super) facts_digest: String,
    pub(super) topology_digest: String,
    pub(super) payload: Value,
    pub(super) record_headers: Vec<NativePersistentFactHeader>,
    pub(super) compact_records: bool,
}

// A process-local provenance marker for the SQLite fact cache.  It is created
// only after an atomic promotion of a fully validated batch and is checked
// against both the complete graph version and SQLite's external-write
// watermark before a later patch reuses the cache.  A restarted process has
// no marker and therefore performs the full cache validation again.
#[derive(Clone)]
pub(super) struct NativePersistentFactProof {
    pub(super) project_id: String,
    pub(super) graph_version: i64,
    pub(super) facts_digest: String,
    pub(super) topology_digest: String,
    pub(super) sqlite_data_version: i64,
}

pub(super) struct NativeProtocolSession {
    pub(super) graphs: BTreeMap<String, NativeSessionGraph>,
    // Every graph returned by a cache-disabled CoreClient can still be queried
    // during this JSONL process.  Store its complete batch once in Rust and
    // identify it to Node by a versioned handle, rather than retaining a
    // duplicate StructuralFactBatch in Node for each public graph object.
    pub(super) session_query_graphs: BTreeMap<String, NativeSessionGraph>,
    pub(super) session_history_limit: usize,
    // One watermark per project distinguishes a deliberately expired handle
    // from a handle that never belonged to this process without retaining
    // every historical digest or context-ref payload.
    pub(super) expired_session_versions: BTreeMap<String, i64>,
    pub(super) ephemeral_sources: BTreeMap<String, NativeJsFactsStatus>,
    pub(super) persistent_sources: BTreeMap<String, NativeJsFactsStatus>,
    // A durable CoreClient owns one JSONL process. Retain its SQLite handle by
    // canonical project root so schema preparation happens once per session,
    // not once per changed-path refresh. The map is deliberately process-local
    // and is dropped on shutdown; SQLite remains the authoritative store.
    pub(super) persistent_connections: BTreeMap<String, rusqlite::Connection>,
    pub(super) persistent_graph: Option<NativePersistentGraph>,
    pub(super) persistent_facts: Option<NativePersistentFacts>,
    pub(super) persistent_fact_proof: Option<NativePersistentFactProof>,
    // Git branch/revision metadata is repository-level observational context,
    // not parser evidence. A source-only incremental event cannot alter HEAD
    // or branch, and the source session already retains its matching graph
    // lineage. Reuse this bounded snapshot to avoid spawning `git status` on
    // every changed file; a reconciled source acquisition refreshes it.
    pub(super) persistent_git_metadata: BTreeMap<String, Value>,
    // Query results are immutable for an exact graph handle. Keep a bounded
    // process-local memo so repeated MCP/HTTP reads do not clone the complete
    // fact batch and rebuild the same structural graph on every request.
    // The key includes the verified facts digest (or session graph handle),
    // so advancing a graph can never return a result from an older authority.
    query_results: BTreeMap<String, NativeResponse>,
    query_result_order: VecDeque<String>,
}

pub(super) const DEFAULT_NATIVE_SESSION_HISTORY: usize = 2;
const MAX_NATIVE_QUERY_RESULTS: usize = 256;
const MAX_NATIVE_SESSION_HISTORY: usize = 1_000;

pub(super) fn parse_session_history_limit(value: Option<&str>) -> Result<usize, String> {
    let Some(value) = value else {
        return Ok(DEFAULT_NATIVE_SESSION_HISTORY);
    };
    let limit = value.parse::<usize>().map_err(|_| {
        "FLOPEEK_NATIVE_SESSION_HISTORY must be an integer from 1 through 1000.".to_string()
    })?;
    if !(1..=MAX_NATIVE_SESSION_HISTORY).contains(&limit) {
        return Err(
            "FLOPEEK_NATIVE_SESSION_HISTORY must be an integer from 1 through 1000.".to_string(),
        );
    }
    Ok(limit)
}

impl NativeProtocolSession {
    pub(super) fn with_history_limit(session_history_limit: usize) -> Self {
        Self {
            graphs: BTreeMap::new(),
            session_query_graphs: BTreeMap::new(),
            session_history_limit,
            expired_session_versions: BTreeMap::new(),
            ephemeral_sources: BTreeMap::new(),
            persistent_sources: BTreeMap::new(),
            persistent_connections: BTreeMap::new(),
            persistent_graph: None,
            persistent_facts: None,
            persistent_fact_proof: None,
            persistent_git_metadata: BTreeMap::new(),
            query_results: BTreeMap::new(),
            query_result_order: VecDeque::new(),
        }
    }

    pub(super) fn query_result(&self, key: &str) -> Option<NativeResponse> {
        self.query_results.get(key).cloned()
    }

    pub(super) fn retain_query_result(&mut self, key: String, result: NativeResponse) {
        if let std::collections::btree_map::Entry::Occupied(mut entry) =
            self.query_results.entry(key.clone())
        {
            entry.insert(result);
            return;
        }
        while self.query_results.len() >= MAX_NATIVE_QUERY_RESULTS {
            let Some(expired) = self.query_result_order.pop_front() else {
                break;
            };
            self.query_results.remove(&expired);
        }
        self.query_result_order.push_back(key.clone());
        self.query_results.insert(key, result);
    }

    pub(super) fn from_env() -> Result<Self, String> {
        let value = std::env::var_os("FLOPEEK_NATIVE_SESSION_HISTORY")
            .map(|value| {
                value.into_string().map_err(|_| {
                    "FLOPEEK_NATIVE_SESSION_HISTORY must contain valid Unicode.".to_string()
                })
            })
            .transpose()?;
        let limit = parse_session_history_limit(value.as_deref())?;
        Ok(Self::with_history_limit(limit))
    }

    pub(super) fn expire_session_history(&mut self, project_id: &str, current_version: i64) {
        let first_retained =
            current_version.saturating_sub(self.session_history_limit.saturating_sub(1) as i64);
        let prefix = format!("{project_id}\0");
        let expired = self
            .session_query_graphs
            .iter()
            .filter(|(key, graph)| {
                key.starts_with(&prefix) && graph.public_graph_version < first_retained
            })
            .map(|(key, graph)| (key.clone(), graph.public_graph_version))
            .collect::<Vec<_>>();
        for (key, version) in expired {
            self.session_query_graphs.remove(&key);
            self.expired_session_versions
                .entry(project_id.to_string())
                .and_modify(|watermark| *watermark = (*watermark).max(version))
                .or_insert(version);
        }
    }

    pub(super) fn session_graph_error(
        &self,
        project_id: &str,
        public_graph_version: i64,
    ) -> NativeProtocolError {
        if self
            .expired_session_versions
            .get(project_id)
            .is_some_and(|watermark| public_graph_version <= *watermark)
        {
            NativeProtocolError {
                code: "native-session-graph-expired",
                message: format!(
                    "The requested cache-disabled graph version {public_graph_version} expired from this JSONL session's bounded history."
                ),
            }
        } else {
            NativeProtocolError {
                code: "native-session-graph-miss",
                message:
                    "The requested cache-disabled native graph is not retained by this JSONL session."
                        .to_string(),
            }
        }
    }
}

impl Default for NativeProtocolSession {
    fn default() -> Self {
        Self::with_history_limit(DEFAULT_NATIVE_SESSION_HISTORY)
    }
}

pub(super) fn native_session_graph_key(project_id: &str, public_graph_version: i64) -> String {
    format!("{project_id}\0{public_graph_version}")
}

pub(super) fn with_persistent_session_connection<T>(
    session: &mut NativeProtocolSession,
    root: &Path,
    operation: impl FnOnce(
        &mut NativeProtocolSession,
        &mut rusqlite::Connection,
    ) -> Result<T, NativeProtocolError>,
) -> Result<T, NativeProtocolError> {
    // macOS commonly exposes /var and /private/var aliases for the same
    // temporary directory. Key the session cache by filesystem identity so
    // one project cannot acquire duplicate SQLite handles through aliases.
    let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let key = canonical_root.to_string_lossy().to_string();
    let mut connection = match session.persistent_connections.remove(&key) {
        Some(connection) => connection,
        None => open_native_store(&canonical_root).map_err(|error| NativeProtocolError {
            code: "store-initialize-failed",
            message: error.to_string(),
        })?,
    };
    let result = operation(session, &mut connection);
    session.persistent_connections.insert(key, connection);
    result
}

pub(super) fn ensure_persistent_payload(
    session: &mut NativeProtocolSession,
    connection: &rusqlite::Connection,
    project_id: &str,
    graph_version: i64,
) -> Result<bool, NativeProtocolError> {
    let cache_hit = session.persistent_graph.as_ref().is_some_and(|cached| {
        cached.project_id == project_id && cached.graph_version == graph_version
    });
    let payload_ready = cache_hit
        && session
            .persistent_graph
            .as_ref()
            .is_some_and(|cached| !cached.payload.is_null());
    if !payload_ready {
        let stored = complete_graph_payload(connection, project_id, graph_version)
            .map_err(|error| NativeProtocolError {
                code: "store-read-failed",
                message: error.to_string(),
            })?
            .ok_or_else(|| NativeProtocolError {
                code: "store-read-failed",
                message: "Current complete native graph payload is unavailable.".to_string(),
            })?;
        let public_snapshot = session
            .persistent_graph
            .as_ref()
            .filter(|cached| {
                cached.project_id == project_id && cached.graph_version == graph_version
            })
            .and_then(|cached| cached.public_snapshot.clone());
        session.persistent_graph = Some(NativePersistentGraph {
            project_id: project_id.to_string(),
            graph_version,
            payload: stored.payload,
            public_snapshot,
        });
    }
    Ok(cache_hit)
}

pub(super) fn ensure_persistent_facts(
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
    let Some(current_graph) = current
        .as_ref()
        .filter(|graph| graph.material_fingerprint == facts_digest)
    else {
        return Err(NativeProtocolError {
            code: "structural-fact-patch-miss",
            message:
                "The SQLite current graph no longer matches the patch base; submit a full batch."
                    .to_string(),
        });
    };
    let sqlite_data_version = connection
        .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| NativeProtocolError {
            code: "store-read-failed",
            message: error.to_string(),
        })?;
    let proof_matches = session.persistent_fact_proof.as_ref().is_some_and(|proof| {
        proof.project_id == project_id
            && proof.graph_version == current_graph.graph_version
            && proof.facts_digest == facts_digest
            && proof.sqlite_data_version == sqlite_data_version
    });
    let cache_hit = session.persistent_facts.as_ref().is_some_and(|cached| {
        cached.project_id == project_id
            && cached.graph_version == current_graph.graph_version
            && cached.facts_digest == facts_digest
            && proof_matches
            && cached.topology_digest
                == session
                    .persistent_fact_proof
                    .as_ref()
                    .expect("proof match was checked")
                    .topology_digest
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
            graph_version: current_graph.graph_version,
            facts_digest: facts_digest.to_string(),
            topology_digest,
            payload,
            record_headers: Vec::new(),
            compact_records: false,
        });
    }
    Ok(())
}

pub(super) fn remember_persistent_fact_proof(
    session: &mut NativeProtocolSession,
    connection: &rusqlite::Connection,
    project_id: &str,
    graph_version: i64,
    facts_digest: &str,
    topology_digest: &str,
) {
    let Ok(sqlite_data_version) =
        connection.query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
    else {
        session.persistent_fact_proof = None;
        return;
    };
    session.persistent_fact_proof = Some(NativePersistentFactProof {
        project_id: project_id.to_string(),
        graph_version,
        facts_digest: facts_digest.to_string(),
        topology_digest: topology_digest.to_string(),
        sqlite_data_version,
    });
}

// A persistent query may name an already-promoted StructuralFactBatch instead
// of serializing it again over JSONL. SQLite remains the authority for this
// cache: the current complete graph must still have the requested digest, and
// a mismatch is deliberately reported so the caller can retry with its exact
// in-memory batch for a historical graph or concurrent promotion.
#[cfg(test)]
pub(super) fn hydrate_cached_query_batch(
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

pub(super) fn move_cached_query_batch(
    session: &mut NativeProtocolSession,
    params: &mut Value,
) -> Result<(), NativeProtocolError> {
    let root = project_root(params)?;
    with_persistent_session_connection(session, &root, |session, connection| {
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
        if let Err(error) = ensure_persistent_facts(session, connection, &project_id, &facts_digest)
        {
            if error.code == "structural-fact-patch-miss" {
                return Err(NativeProtocolError {
                    code: "native-query-fact-cache-miss",
                    message: "The requested graph is not the current verified native fact cache."
                        .to_string(),
                });
            }
            return Err(error);
        }
        let cached = session
            .persistent_facts
            .as_mut()
            .filter(|cached| cached.project_id == project_id && cached.facts_digest == facts_digest)
            .ok_or_else(|| NativeProtocolError {
                code: "store-read-failed",
                message: "Verified native fact cache was unavailable after lookup.".to_string(),
            })?;
        params
            .as_object_mut()
            .ok_or_else(|| NativeProtocolError {
                code: "invalid-params",
                message: "Cached native query params must be an object.".to_string(),
            })?
            .insert("batch".to_string(), std::mem::take(&mut cached.payload));
        Ok(())
    })
}

pub(super) fn restore_moved_cached_query_batch(
    session: &mut NativeProtocolSession,
    params: &mut Value,
) {
    let Some(batch) = params
        .as_object_mut()
        .and_then(|object| object.remove("batch"))
    else {
        return;
    };
    if let Some(cached) = session.persistent_facts.as_mut()
        && cached.payload.is_null()
    {
        cached.payload = batch;
    }
}

#[cfg(test)]
pub(super) fn hydrate_cached_query_batch_using_connection(
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
pub(super) fn hydrate_session_query_batch(
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
    let project_id = project_id
        .expect("validated non-empty project ID")
        .to_string();
    let facts_digest = facts_digest
        .expect("validated non-empty facts digest")
        .to_string();
    let public_graph_version = public_graph_version.expect("validated graph version");
    let key = native_session_graph_key(&project_id, public_graph_version);
    let graph = session
        .session_query_graphs
        .get(&key)
        .filter(|graph| graph.facts_digest == facts_digest)
        .ok_or_else(|| session.session_graph_error(&project_id, public_graph_version))?;
    let object = params.as_object_mut().ok_or_else(|| NativeProtocolError {
        code: "invalid-params",
        message: "Native session query params must be an object.".to_string(),
    })?;
    object.remove("sessionGraph");
    object.insert("batch".to_string(), (*graph.query_batch).clone());
    object.insert(
        "sessionContextHistory".to_string(),
        json!({
            "schemaVersion": "flopeek-native-session-context-history/v1",
            "expiredThroughVersion": session.expired_session_versions.get(&project_id).copied(),
            "adjacentDelta": graph.latest_delta.clone(),
            "currentGraphVersion": graph.public_graph_version,
        }),
    );
    Ok(())
}
