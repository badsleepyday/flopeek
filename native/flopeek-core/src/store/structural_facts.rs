use super::*;

/// Returns only the fact cache attached to the SQLite-selected complete graph.
/// A missing or mismatched row is an expected cache miss; callers must submit a
/// full batch instead of attempting partial reconstruction.
pub fn current_structural_batch(
    connection: &Connection,
    project_id: &str,
    facts_digest: &str,
) -> rusqlite::Result<Option<serde_json::Value>> {
    let current_cache: Option<(i64, String)> = connection
        .query_row(
            "SELECT projects.project_pk, cache.envelope_json
             FROM projects
             INNER JOIN graph_versions versions
               ON versions.project_pk = projects.project_pk
              AND versions.graph_version = projects.current_graph_version
              AND versions.status = 'complete'
             INNER JOIN native_structural_batch_cache cache
               ON cache.project_pk = versions.project_pk
              AND cache.graph_version = versions.graph_version
              AND cache.facts_digest = versions.material_fingerprint
             WHERE projects.project_id = ?1 AND cache.facts_digest = ?2",
            rusqlite::params![project_id, facts_digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((project_pk, envelope_json)) = current_cache {
        let mut batch: serde_json::Value =
            serde_json::from_str(&envelope_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
        let object = batch.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
        let mut statement = connection.prepare(
            "SELECT payload_json FROM native_structural_batch_records
             WHERE project_pk = ?1 ORDER BY record_order, path",
        )?;
        let records = statement
            .query_map([project_pk], |row| row.get::<_, String>(0))?
            .map(|row| {
                let raw = row?;
                serde_json::from_str(&raw).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .collect::<Result<Vec<serde_json::Value>, _>>()?;
        object.insert("records".to_string(), serde_json::Value::Array(records));
        object.insert(
            "factsDigest".to_string(),
            serde_json::Value::String(facts_digest.to_string()),
        );
        return Ok(Some(batch));
    }
    // v7 fallback for a database upgraded before the next complete v8 graph
    // promotion. It is intentionally read-only and disappears on promotion.
    connection
        .query_row(
            "SELECT cache.payload_json
             FROM projects
             INNER JOIN graph_versions versions
               ON versions.project_pk = projects.project_pk
              AND versions.graph_version = projects.current_graph_version
              AND versions.status = 'complete'
             INNER JOIN native_structural_batches cache
               ON cache.project_pk = versions.project_pk
              AND cache.graph_version = versions.graph_version
              AND cache.facts_digest = versions.material_fingerprint
             WHERE projects.project_id = ?1 AND cache.facts_digest = ?2",
            rusqlite::params![project_id, facts_digest],
            |row| {
                let raw: String = row.get(0)?;
                serde_json::from_str(&raw).map_err(|error| {
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
