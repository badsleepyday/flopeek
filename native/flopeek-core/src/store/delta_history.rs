use super::*;

pub fn complete_graph_delta_by_public_versions(
    connection: &Connection,
    project_id: &str,
    from_public_graph_version: i64,
    to_public_graph_version: i64,
) -> rusqlite::Result<Option<serde_json::Value>> {
    connection
        .query_row(
            "SELECT deltas.payload_json
             FROM projects
             JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
             JOIN graph_versions AS source ON source.project_pk = projects.project_pk AND source.graph_version = deltas.from_graph_version
             JOIN graph_versions AS target ON target.project_pk = projects.project_pk AND target.graph_version = deltas.to_graph_version
             WHERE projects.project_id = ?1
               AND source.status = 'complete' AND target.status = 'complete'
               AND source.public_graph_version = ?2 AND target.public_graph_version = ?3",
            rusqlite::params![project_id, from_public_graph_version, to_public_graph_version],
            |row| {
                let payload_json: String = row.get(0)?;
                serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            },
        )
        .optional()
}

pub fn retained_public_delta_range(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Option<(i64, i64)>> {
    connection
        .query_row(
            "SELECT MIN(source.public_graph_version), MAX(target.public_graph_version)
             FROM projects
             JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
             JOIN graph_versions AS source ON source.project_pk = projects.project_pk AND source.graph_version = deltas.from_graph_version
             JOIN graph_versions AS target ON target.project_pk = projects.project_pk AND target.graph_version = deltas.to_graph_version
             WHERE projects.project_id = ?1
               AND source.status = 'complete' AND target.status = 'complete'",
            [project_id],
            |row| {
                let oldest: Option<i64> = row.get(0)?;
                let newest: Option<i64> = row.get(1)?;
                Ok(oldest.zip(newest))
            },
        )
        .optional()
        .map(|range| range.flatten())
}

fn native_delta_history_entries(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<NativeDeltaHistoryEntry>> {
    let mut statement = connection.prepare(
        "SELECT deltas.from_graph_version, deltas.to_graph_version,
                source.public_graph_version, target.public_graph_version,
                LENGTH(deltas.payload_json)
         FROM projects
         JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
         JOIN graph_versions AS source ON source.project_pk = projects.project_pk AND source.graph_version = deltas.from_graph_version
         JOIN graph_versions AS target ON target.project_pk = projects.project_pk AND target.graph_version = deltas.to_graph_version
         WHERE projects.project_id = ?1
           AND source.status = 'complete' AND target.status = 'complete'
         ORDER BY deltas.to_graph_version DESC, deltas.from_graph_version DESC",
    )?;
    statement
        .query_map([project_id], |row| {
            Ok(NativeDeltaHistoryEntry {
                from_graph_version: row.get(0)?,
                to_graph_version: row.get(1)?,
                from_public_graph_version: row.get(2)?,
                to_public_graph_version: row.get(3)?,
                bytes: row.get::<_, i64>(4)?.max(0) as usize,
            })
        })?
        .collect()
}

pub fn native_delta_retention_plan(
    connection: &Connection,
    project_id: &str,
    keep_deltas: usize,
    max_bytes: usize,
) -> rusqlite::Result<NativeDeltaRetentionPlan> {
    let keep_deltas = keep_deltas.max(1);
    let max_bytes = max_bytes.max(1);
    let entries = native_delta_history_entries(connection, project_id)?;
    let total_bytes = entries.iter().map(|entry| entry.bytes).sum();
    let mut retained = Vec::new();
    let mut prunable = Vec::new();
    let mut retained_bytes = 0;
    for entry in entries {
        let is_latest = retained.is_empty();
        let within_count = retained.len() < keep_deltas;
        let within_bytes = retained_bytes + entry.bytes <= max_bytes;
        if is_latest || (within_count && within_bytes) {
            retained_bytes += entry.bytes;
            retained.push(entry);
        } else {
            prunable.push(entry);
        }
    }
    let retention_exceeded_by_protected_latest = retained
        .first()
        .is_some_and(|entry| entry.bytes > max_bytes);
    Ok(NativeDeltaRetentionPlan {
        keep_deltas,
        max_bytes,
        total_deltas: retained.len() + prunable.len(),
        total_bytes,
        retained,
        prunable,
        retention_exceeded_by_protected_latest,
    })
}

pub fn prune_native_graph_deltas(
    connection: &mut Connection,
    project_id: &str,
    keep_deltas: usize,
    max_bytes: usize,
    dry_run: bool,
) -> rusqlite::Result<NativeDeltaPruneResult> {
    let plan = native_delta_retention_plan(connection, project_id, keep_deltas, max_bytes)?;
    let reclaimed_bytes = plan.prunable.iter().map(|entry| entry.bytes).sum();
    if !dry_run && !plan.prunable.is_empty() {
        let transaction = connection.transaction()?;
        let project_pk = project_pk(&transaction, project_id)?;
        for entry in &plan.prunable {
            transaction.execute(
                "DELETE FROM graph_deltas
                 WHERE project_pk = ?1 AND from_graph_version = ?2 AND to_graph_version = ?3",
                rusqlite::params![project_pk, entry.from_graph_version, entry.to_graph_version],
            )?;
        }
        transaction.commit()?;
    }
    Ok(NativeDeltaPruneResult {
        dry_run,
        pruned: plan.prunable,
        retained: plan.retained,
        reclaimed_bytes,
        retention_exceeded_by_protected_latest: plan.retention_exceeded_by_protected_latest,
    })
}

pub fn complete_graph_delta(
    connection: &Connection,
    project_id: &str,
    from_graph_version: i64,
    to_graph_version: i64,
) -> rusqlite::Result<Option<serde_json::Value>> {
    connection
        .query_row(
            "SELECT deltas.payload_json
             FROM projects JOIN graph_deltas AS deltas ON deltas.project_pk = projects.project_pk
             WHERE projects.project_id = ?1 AND deltas.from_graph_version = ?2 AND deltas.to_graph_version = ?3",
            rusqlite::params![project_id, from_graph_version, to_graph_version],
            |row| {
                let payload_json: String = row.get(0)?;
                serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            },
        )
        .optional()
}
