use super::*;

pub fn recover_incomplete_graph_builds(
    connection: &mut Connection,
    project_id: &str,
) -> rusqlite::Result<usize> {
    let transaction = connection.transaction()?;
    let project_pk = project_pk(&transaction, project_id)?;
    let removed = transaction.execute(
        "DELETE FROM graph_versions WHERE project_pk = ?1 AND status = 'building'",
        [project_pk],
    )?;
    transaction.commit()?;
    Ok(removed)
}

pub fn current_complete_graph(
    connection: &Connection,
    project_id: &str,
) -> rusqlite::Result<Option<NativeGraphVersion>> {
    connection
        .query_row(
            "SELECT versions.graph_version, versions.public_graph_version, versions.material_fingerprint, versions.source_fingerprint, versions.compatibility_digest
             FROM projects JOIN graph_versions AS versions
               ON versions.project_pk = projects.project_pk AND versions.graph_version = projects.current_graph_version
             WHERE projects.project_id = ?1 AND versions.status = 'complete'",
            [project_id],
            |row| {
                Ok(NativeGraphVersion {
                    graph_version: row.get(0)?,
                    public_graph_version: row.get(1)?,
                    material_fingerprint: row.get(2)?,
                    source_fingerprint: row.get(3)?,
                    compatibility_digest: row.get(4)?,
                })
            },
        )
        .optional()
}

fn stored_public_graph_payload(
    connection: &Connection,
    project_pk: i64,
    graph_version: i64,
    legacy_payload_json: Option<String>,
) -> rusqlite::Result<serde_json::Value> {
    if let Some(raw) = legacy_payload_json {
        return serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        });
    }
    let envelope_json: String = connection.query_row(
        "SELECT payload_json FROM native_public_graph_envelopes
         WHERE project_pk = ?1 AND graph_version = ?2",
        rusqlite::params![project_pk, graph_version],
        |row| row.get(0),
    )?;
    let mut payload: serde_json::Value = serde_json::from_str(&envelope_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let object = payload
        .as_object_mut()
        .ok_or(rusqlite::Error::InvalidQuery)?;
    let uses_history: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM native_public_graph_component_history
           WHERE project_pk = ?1 AND first_graph_version <= ?2
             AND (last_graph_version IS NULL OR last_graph_version >= ?2)
         )",
        rusqlite::params![project_pk, graph_version],
        |row| row.get(0),
    )?;
    for (field, kind) in NATIVE_PUBLIC_GRAPH_COMPONENT_KINDS {
        let query = if uses_history {
            "SELECT components.payload_json
             FROM native_public_graph_component_history history
             JOIN native_public_graph_components components
               ON components.component_digest = history.component_digest
             WHERE history.project_pk = ?1
               AND history.component_kind = ?3
               AND history.first_graph_version <= ?2
               AND (history.last_graph_version IS NULL OR history.last_graph_version >= ?2)
             ORDER BY history.ordinal"
        } else {
            "SELECT components.payload_json
             FROM native_public_graph_memberships memberships
             JOIN native_public_graph_components components
               ON components.component_digest = memberships.component_digest
             WHERE memberships.project_pk = ?1
               AND memberships.graph_version = ?2
               AND memberships.component_kind = ?3
             ORDER BY memberships.ordinal"
        };
        let mut statement = connection.prepare(query)?;
        let values = statement
            .query_map(rusqlite::params![project_pk, graph_version, kind], |row| {
                row.get::<_, String>(0)
            })?
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
        if !values.is_empty() {
            object.insert(field.to_string(), serde_json::Value::Array(values));
        }
    }
    Ok(payload)
}

pub fn complete_graph_payload(
    connection: &Connection,
    project_id: &str,
    graph_version: i64,
) -> rusqlite::Result<Option<NativeCompleteGraphPayload>> {
    let row = connection
        .query_row(
            "SELECT projects.project_pk, versions.graph_version, versions.public_graph_version, versions.payload_json, versions.compatibility_digest
             FROM projects JOIN graph_versions AS versions
               ON versions.project_pk = projects.project_pk
             WHERE projects.project_id = ?1 AND versions.graph_version = ?2 AND versions.status = 'complete'",
            rusqlite::params![project_id, graph_version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    row.map(
        |(project_pk, graph_version, public_graph_version, payload_json, compatibility_digest)| {
            Ok(NativeCompleteGraphPayload {
                graph_version,
                public_graph_version,
                payload: stored_public_graph_payload(
                    connection,
                    project_pk,
                    graph_version,
                    payload_json,
                )?,
                compatibility_digest,
            })
        },
    )
    .transpose()
}

pub fn complete_graph_payload_by_public_version(
    connection: &Connection,
    project_id: &str,
    public_graph_version: i64,
) -> rusqlite::Result<Option<NativeCompleteGraphPayload>> {
    let row = connection
        .query_row(
            "SELECT projects.project_pk, versions.graph_version, versions.public_graph_version, versions.payload_json, versions.compatibility_digest
             FROM projects JOIN graph_versions AS versions
               ON versions.project_pk = projects.project_pk
             WHERE projects.project_id = ?1 AND versions.public_graph_version = ?2 AND versions.status = 'complete'
             ORDER BY versions.graph_version DESC LIMIT 1",
            rusqlite::params![project_id, public_graph_version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    row.map(
        |(project_pk, graph_version, public_graph_version, payload_json, compatibility_digest)| {
            Ok(NativeCompleteGraphPayload {
                graph_version,
                public_graph_version,
                payload: stored_public_graph_payload(
                    connection,
                    project_pk,
                    graph_version,
                    payload_json,
                )?,
                compatibility_digest,
            })
        },
    )
    .transpose()
}
