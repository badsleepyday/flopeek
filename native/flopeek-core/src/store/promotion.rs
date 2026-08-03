use super::*;

fn now_ms() -> rusqlite::Result<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

pub(super) fn project_pk(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
) -> rusqlite::Result<i64> {
    transaction.execute(
        "INSERT INTO projects(project_id, created_at_ms) VALUES (?1, ?2) ON CONFLICT(project_id) DO NOTHING",
        rusqlite::params![project_id, now_ms()?],
    )?;
    transaction.query_row(
        "SELECT project_pk FROM projects WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
    )
}

fn contains_source_body(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter().any(contains_source_body),
        serde_json::Value::Object(entries) => entries.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "content" | "contents" | "rawsource" | "sourcebody" | "sourcetext" | "text"
            ) || contains_source_body(value)
        }),
        _ => false,
    }
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn native_public_graph_cache(
    payload: &serde_json::Value,
    reuse_public_components: bool,
) -> rusqlite::Result<NativePublicGraphCache> {
    let payload = payload.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
    // Do not clone every public collection merely to remove it moments later.
    // On a large graph, cloning the full payload and then cloning node/edge/
    // flow arrays again made SQLite promotion do proportional allocation work
    // even when the component rows were unchanged.  Components are serialized
    // directly from the immutable projection below; only the envelope owns
    // clones of its non-component fields.
    let mut envelope = payload
        .iter()
        .filter(|(field, _)| {
            !NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS
                .iter()
                .any(|(component_field, _)| field == component_field)
        })
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    for (field, _) in NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS {
        let Some(values) = payload.get(field) else {
            continue;
        };
        let values = values.as_array().ok_or(rusqlite::Error::InvalidQuery)?;
        // Keeping empty arrays in the envelope preserves both an explicitly
        // empty public field and legacy payloads that omit the field entirely.
        // Only non-empty arrays are split into content-addressed components.
        if values.is_empty() {
            envelope.insert(field.to_string(), serde_json::Value::Array(Vec::new()));
            continue;
        }
        // A verified source-only refresh preserves every public collection
        // byte-for-byte.  Its next graph version still needs a new envelope
        // for source/version metadata, but the open component-history rows
        // already cover that version.  Avoid hashing and serializing every
        // public component again; callers may select this only after the
        // protocol has reused the preceding complete public projection.
        if reuse_public_components {
            continue;
        }
    }
    let envelope_json = serde_json::to_string(&serde_json::Value::Object(envelope))
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    Ok(NativePublicGraphCache { envelope_json })
}

fn promote_native_public_graph_cache(
    transaction: &rusqlite::Transaction<'_>,
    project_pk: i64,
    graph_version: i64,
    previous_graph_version: Option<i64>,
    cache: &NativePublicGraphCache,
    payload: &serde_json::Value,
    reuse_public_components: bool,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO native_public_graph_envelopes(project_pk, graph_version, payload_json)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![project_pk, graph_version, cache.envelope_json],
    )?;
    // The component-history intervals from the previously complete graph are
    // deliberately left open.  Their version predicate reconstructs the same
    // public arrays for this new envelope without a full history SELECT or
    // any component/history writes.  Reject an impossible first-version reuse
    // rather than silently creating an envelope with no public collections.
    if reuse_public_components {
        if previous_graph_version.is_none() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        return Ok(());
    }
    // These maps are only a private membership-diff work set. Canonical public
    // ordering was established before persistence, so a hash index avoids
    // repeated lexical comparisons for thousands of internal component IDs.
    let mut active = HashMap::new();
    if previous_graph_version.is_some() {
        let mut statement = transaction.prepare(
            "SELECT component_kind, component_id, ordinal, component_digest
             FROM native_public_graph_component_history
             WHERE project_pk = ?1 AND last_graph_version IS NULL",
        )?;
        for row in statement.query_map([project_pk], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })? {
            let (kind, id, ordinal, digest) = row?;
            active.insert((kind, id), (ordinal, digest));
        }
    }
    // The interval table is the current-version membership index.  Do not
    // issue a no-op INSERT OR IGNORE for every unchanged component on an
    // incremental refresh: a large graph can otherwise turn one local edit
    // into thousands of SQLite statements despite content-addressed storage.
    // Components absent from the active set may be new or merely historical;
    // the SQL conflict clause preserves both cases without changing public
    // graph IDs or history semantics.
    let active_digests = active
        .values()
        .map(|(_, digest)| digest.as_str())
        .collect::<HashSet<_>>();
    let mut inserted_digests = HashSet::new();
    let mut incoming = HashMap::new();
    let mut component = transaction.prepare(
        "INSERT INTO native_public_graph_components(component_digest, component_kind, payload_json)
         VALUES (?1, ?2, ?3) ON CONFLICT(component_digest) DO NOTHING",
    )?;
    for (field, kind) in NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS {
        let Some(values) = payload.get(field) else {
            continue;
        };
        let values = values.as_array().ok_or(rusqlite::Error::InvalidQuery)?;
        let mut ids = BTreeSet::new();
        for (ordinal, value) in values.iter().enumerate() {
            let payload_json = serde_json::to_string(value)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let digest = format!(
                "blake3:{}",
                blake3::hash(format!("{kind}\0{payload_json}").as_bytes()).to_hex()
            );
            let base_id = value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| digest.clone());
            let id = if ids.insert(base_id.clone()) {
                base_id
            } else {
                format!("{base_id}@{ordinal}")
            };
            let ordinal = i64::try_from(ordinal).map_err(|_| rusqlite::Error::InvalidQuery)?;
            incoming.insert((kind.to_string(), id), (ordinal, digest.clone()));
            if active_digests.contains(digest.as_str()) || !inserted_digests.insert(digest.clone())
            {
                continue;
            }
            component.execute(rusqlite::params![digest, kind, payload_json])?;
        }
    }
    drop(component);
    let previous_graph_version = previous_graph_version.unwrap_or(graph_version.saturating_sub(1));
    let mut close = transaction.prepare(
        "UPDATE native_public_graph_component_history
         SET last_graph_version = ?1
         WHERE project_pk = ?2 AND component_kind = ?3 AND component_id = ?4
           AND last_graph_version IS NULL",
    )?;
    let mut open = transaction.prepare(
        "INSERT INTO native_public_graph_component_history(project_pk, component_kind, component_id, first_graph_version, last_graph_version, ordinal, component_digest)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)",
    )?;
    for (key, (ordinal, digest)) in &incoming {
        if active
            .get(key)
            .is_some_and(|(active_ordinal, active_digest)| {
                active_ordinal == ordinal && active_digest == digest
            })
        {
            continue;
        }
        if active.contains_key(key) {
            close.execute(rusqlite::params![
                previous_graph_version,
                project_pk,
                key.0,
                key.1
            ])?;
        }
        open.execute(rusqlite::params![
            project_pk,
            key.0,
            key.1,
            graph_version,
            ordinal,
            digest
        ])?;
    }
    for key in active.keys().filter(|key| !incoming.contains_key(*key)) {
        close.execute(rusqlite::params![
            previous_graph_version,
            project_pk,
            key.0,
            key.1
        ])?;
    }
    Ok(())
}

fn promote_native_structural_batch_cache(
    transaction: &rusqlite::Transaction<'_>,
    project_pk: i64,
    graph_version: i64,
    batch: &serde_json::Value,
    facts_digest: &str,
    changed_record_paths: Option<&BTreeSet<String>>,
) -> rusqlite::Result<()> {
    let object = batch.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
    if object
        .get("factsDigest")
        .and_then(serde_json::Value::as_str)
        != Some(facts_digest)
        || !is_sha256_digest(facts_digest)
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let records = object
        .get("records")
        .and_then(serde_json::Value::as_array)
        .ok_or(rusqlite::Error::InvalidQuery)?;
    // The records array is the dominant part of a fact batch.  Cloning the
    // whole object only to immediately remove it duplicates every parser fact
    // on each incremental promotion.  Build the persisted envelope directly
    // so the record payloads stay borrowed until the selective cache write.
    let envelope = object
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "records" | "factsDigest" | "projectRoot"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let envelope_json = serde_json::to_string(&serde_json::Value::Object(envelope))
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let mut parsed_records = Vec::with_capacity(records.len());
    let mut next_paths = BTreeSet::new();
    for record in records {
        let item = record.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
        let path = item
            .get("relativePath")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let source_hash = item
            .get("sourceHash")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
            })
            .ok_or(rusqlite::Error::InvalidQuery)?;
        let record_order = item
            .get("recordOrder")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value >= 0)
            .ok_or(rusqlite::Error::InvalidQuery)?;
        if !next_paths.insert(path.to_string()) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        parsed_records.push((path, source_hash, record_order, record));
    }
    let existing = {
        let mut statement = transaction
            .prepare("SELECT path FROM native_structural_batch_records WHERE project_pk = ?1")?;
        statement
            .query_map([project_pk], |row| row.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?
    };
    for path in existing.difference(&next_paths) {
        transaction.execute(
            "DELETE FROM native_structural_batch_records WHERE project_pk = ?1 AND path = ?2",
            rusqlite::params![project_pk, path],
        )?;
    }
    let mut upsert = transaction.prepare(
        "INSERT INTO native_structural_batch_records(project_pk, path, source_hash, record_order, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_pk, path) DO UPDATE SET
           source_hash = excluded.source_hash,
           record_order = excluded.record_order,
           payload_json = excluded.payload_json
         WHERE native_structural_batch_records.source_hash <> excluded.source_hash
            OR native_structural_batch_records.record_order <> excluded.record_order
            OR native_structural_batch_records.payload_json <> excluded.payload_json",
    )?;
    for (path, source_hash, record_order, record) in parsed_records {
        // A verified StructuralFactPatch explicitly identifies every record
        // whose header or payload may differ.  Avoid serializing and issuing
        // a guarded UPSERT for all of the other records; a full batch keeps
        // the conservative whole-record behavior.
        if changed_record_paths.is_some_and(|paths| !paths.contains(path)) {
            continue;
        }
        let payload_json = serde_json::to_string(record)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        upsert.execute(rusqlite::params![
            project_pk,
            path,
            source_hash,
            record_order,
            payload_json,
        ])?;
    }
    drop(upsert);
    transaction.execute(
        "INSERT INTO native_structural_batch_cache(project_pk, graph_version, facts_digest, envelope_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_pk) DO UPDATE SET
           graph_version = excluded.graph_version,
           facts_digest = excluded.facts_digest,
           envelope_json = excluded.envelope_json",
        rusqlite::params![project_pk, graph_version, facts_digest, envelope_json],
    )?;
    // The v7 monolithic cache remains readable for upgrades, but once v8 has
    // atomically promoted a record cache it is intentionally discarded.
    transaction.execute(
        "DELETE FROM native_structural_batches WHERE project_pk = ?1",
        [project_pk],
    )?;
    Ok(())
}

pub fn begin_graph_build(
    connection: &mut Connection,
    project_id: &str,
    material_fingerprint: &str,
    source_fingerprint: &str,
) -> rusqlite::Result<NativeGraphVersion> {
    let transaction = connection.transaction()?;
    let project_pk = project_pk(&transaction, project_id)?;
    let graph_version = transaction.query_row(
        "SELECT COALESCE(MAX(graph_version), 0) + 1 FROM graph_versions WHERE project_pk = ?1",
        [project_pk],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO graph_versions(project_pk, graph_version, status, material_fingerprint, source_fingerprint, created_at_ms)
         VALUES (?1, ?2, 'building', ?3, ?4, ?5)",
        rusqlite::params![project_pk, graph_version, material_fingerprint, source_fingerprint, now_ms()?],
    )?;
    transaction.commit()?;
    crash_at_test_boundary("after-begin-build");
    Ok(NativeGraphVersion {
        graph_version,
        public_graph_version: None,
        material_fingerprint: material_fingerprint.to_string(),
        source_fingerprint: source_fingerprint.to_string(),
        compatibility_digest: None,
    })
}

pub fn promote_graph_build(
    connection: &mut Connection,
    request: NativeGraphPromotionRequest<'_>,
) -> rusqlite::Result<()> {
    promote_graph_build_with_changed_records(connection, request).map(|_| ())
}

pub fn promote_graph_build_with_changed_records(
    connection: &mut Connection,
    request: NativeGraphPromotionRequest<'_>,
) -> rusqlite::Result<NativeGraphPromotionTiming> {
    let started = Instant::now();
    if contains_source_body(request.payload)
        || request.adjacent_delta.is_some_and(contains_source_body)
        || request.structural_batch.is_some_and(contains_source_body)
        || !request
            .payload
            .get("schemaVersion")
            .is_some_and(|value| value.is_string())
        || !is_sha256_digest(request.compatibility_digest)
        || request.public_graph_version < 0
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let public_cache_started = Instant::now();
    let public_graph_cache =
        native_public_graph_cache(request.payload, request.reuse_public_components)?;
    let public_cache_ms = public_cache_started.elapsed().as_millis() as u64;
    if let Some(batch) = request.structural_batch {
        let facts_digest = request.facts_digest.ok_or(rusqlite::Error::InvalidQuery)?;
        if batch.get("factsDigest").and_then(serde_json::Value::as_str) != Some(facts_digest) {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    let transaction_started = Instant::now();
    let transaction = connection.transaction()?;
    let project_pk = project_pk(&transaction, request.project_id)?;
    let previous_graph_version: Option<i64> = transaction.query_row(
        "SELECT current_graph_version FROM projects WHERE project_pk = ?1",
        [project_pk],
        |row| row.get(0),
    )?;
    let changed = transaction.execute(
        "UPDATE graph_versions SET status = 'complete', compatibility_digest = ?1, public_graph_version = ?2, completed_at_ms = ?3
         WHERE project_pk = ?4 AND graph_version = ?5 AND status = 'building'",
        rusqlite::params![request.compatibility_digest, request.public_graph_version, now_ms()?, project_pk, request.graph_version],
    )?;
    if changed != 1 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let public_cache_write_started = Instant::now();
    promote_native_public_graph_cache(
        &transaction,
        project_pk,
        request.graph_version,
        previous_graph_version,
        &public_graph_cache,
        request.payload,
        request.reuse_public_components,
    )?;
    crash_at_test_boundary("after-graph-payload-write");
    let public_cache_write_ms = public_cache_write_started.elapsed().as_millis() as u64;
    let delta_write_started = Instant::now();
    if let (Some(from_graph_version), Some(delta)) =
        (previous_graph_version, request.adjacent_delta)
    {
        let delta_json = serde_json::to_string(delta)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        transaction.execute(
            "INSERT INTO graph_deltas(project_pk, from_graph_version, to_graph_version, payload_json)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![project_pk, from_graph_version, request.graph_version, delta_json],
        )?;
    }
    let delta_write_ms = delta_write_started.elapsed().as_millis() as u64;
    let structural_fact_cache_started = Instant::now();
    if let Some(batch) = request.structural_batch {
        // The old cache remains live until this transaction commits.  A
        // cancellation, validation failure, or crash therefore leaves the
        // previous complete graph and its matching batch untouched.
        promote_native_structural_batch_cache(
            &transaction,
            project_pk,
            request.graph_version,
            batch,
            request
                .facts_digest
                .expect("validated with structural batch"),
            request.changed_record_paths,
        )?;
    } else {
        transaction.execute(
            "DELETE FROM native_structural_batch_cache WHERE project_pk = ?1",
            [project_pk],
        )?;
        transaction.execute(
            "DELETE FROM native_structural_batch_records WHERE project_pk = ?1",
            [project_pk],
        )?;
        transaction.execute(
            "DELETE FROM native_structural_batches WHERE project_pk = ?1",
            [project_pk],
        )?;
    }
    let structural_fact_cache_ms = structural_fact_cache_started.elapsed().as_millis() as u64;
    // Identity v2 is an additive dual-write in schema v11. It participates in
    // the same transaction as the compatibility graph, so invalid canonical
    // identity input can never advance the project pointer independently.
    if request.reuse_public_components {
        if let Some(changed_record_paths) = request.changed_record_paths {
            sync_identity_v2_changed_records(
                &transaction,
                project_pk,
                request.project_id,
                request.graph_version,
                request.payload,
                request.structural_batch,
                changed_record_paths,
            )?;
        } else {
            sync_identity_v2(
                &transaction,
                project_pk,
                request.project_id,
                request.graph_version,
                request.payload,
                request.structural_batch,
            )?;
        }
    } else {
        sync_identity_v2(
            &transaction,
            project_pk,
            request.project_id,
            request.graph_version,
            request.payload,
            request.structural_batch,
        )?;
    }
    crash_at_test_boundary("after-fact-storage");
    let project_pointer_started = Instant::now();
    crash_at_test_boundary("before-current-pointer-promotion");
    transaction.execute(
        "UPDATE projects SET current_graph_version = ?1 WHERE project_pk = ?2",
        rusqlite::params![request.graph_version, project_pk],
    )?;
    let project_pointer_ms = project_pointer_started.elapsed().as_millis() as u64;
    delay_at_test_boundary("before-promotion");
    transaction.commit()?;
    Ok(NativeGraphPromotionTiming {
        public_cache_ms,
        public_cache_write_ms,
        delta_write_ms,
        structural_fact_cache_ms,
        project_pointer_ms,
        transaction_ms: transaction_started.elapsed().as_millis() as u64,
        total_ms: started.elapsed().as_millis() as u64,
    })
}
