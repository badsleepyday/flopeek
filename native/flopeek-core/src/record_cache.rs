use crate::store::open_native_store;
use rusqlite::{OptionalExtension, params, params_from_iter};
use serde_json::{Value, json};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const NATIVE_JS_RECORD_CACHE_SCHEMA: &str = "flopeek-native-js-record-cache/v1";

fn now_millis() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock precedes Unix epoch: {error}"))?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| "Current time exceeds SQLite integer range.".to_string())
}

fn valid_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains(':')
        && !path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

fn project_pk(connection: &rusqlite::Connection, project_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT project_pk FROM projects WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "Native incremental manifest must be prepared before accessing the JS record cache."
                .to_string()
        })
}

fn load_records(
    connection: &rusqlite::Connection,
    project_pk: i64,
    paths: &[String],
) -> Result<Value, String> {
    let mut records = Vec::new();
    if paths.is_empty() {
        return Ok(json!({
            "schemaVersion": NATIVE_JS_RECORD_CACHE_SCHEMA,
            "operation": "load",
            "records": records,
        }));
    }
    let placeholders = std::iter::repeat_n("?", paths.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT cache.path, cache.payload_json
         FROM js_file_records cache
         INNER JOIN inventory_files inventory
           ON inventory.project_pk = cache.project_pk
          AND inventory.path = cache.path
          AND inventory.content_hash = cache.source_hash
         WHERE cache.project_pk = ? AND cache.path IN ({placeholders})
         ORDER BY cache.path"
    );
    let mut parameters = Vec::with_capacity(paths.len() + 1);
    parameters.push(rusqlite::types::Value::Integer(project_pk));
    parameters.extend(paths.iter().cloned().map(rusqlite::types::Value::Text));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(parameters), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (path, payload_json) = row.map_err(|error| error.to_string())?;
        let payload: Value = serde_json::from_str(&payload_json).map_err(|error| {
            format!("Invalid cached JavaScript file record for {path}: {error}")
        })?;
        records.push(json!({ "path": path, "record": payload }));
    }
    Ok(json!({
        "schemaVersion": NATIVE_JS_RECORD_CACHE_SCHEMA,
        "operation": "load",
        "records": records,
    }))
}

fn store_records(
    connection: &mut rusqlite::Connection,
    project_pk: i64,
    records: &[Value],
) -> Result<Value, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let now = now_millis()?;
    let mut stored = 0usize;
    for item in records {
        let object = item
            .as_object()
            .ok_or("JS record cache entries must be objects.")?;
        let path = object
            .get("path")
            .and_then(Value::as_str)
            .ok_or("JS record cache entry path must be a string.")?;
        if !valid_relative_path(path) {
            return Err(
                "JS record cache entry path must be a safe repository-relative path.".to_string(),
            );
        }
        let record = object
            .get("record")
            .ok_or("JS record cache entry record is required.")?;
        let source_hash: Option<String> = transaction
            .query_row(
                "SELECT content_hash FROM inventory_files WHERE project_pk = ?1 AND path = ?2",
                params![project_pk, path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(source_hash) = source_hash else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO js_file_records(project_pk, path, source_hash, payload_json, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project_pk, path) DO UPDATE SET
                   source_hash = excluded.source_hash,
                   payload_json = excluded.payload_json,
                   updated_at_ms = excluded.updated_at_ms",
                params![project_pk, path, source_hash, serde_json::to_string(record).map_err(|error| error.to_string())?, now],
            )
            .map_err(|error| error.to_string())?;
        stored += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(json!({
        "schemaVersion": NATIVE_JS_RECORD_CACHE_SCHEMA,
        "operation": "store",
        "storedRecords": stored,
    }))
}

pub fn handle_native_js_record_cache(root: &Path, input: &str) -> Result<Value, String> {
    let request: Value = serde_json::from_str(input)
        .map_err(|error| format!("Native JS record cache input must be JSON: {error}"))?;
    let object = request
        .as_object()
        .ok_or("Native JS record cache input must be an object.")?;
    if object.get("schemaVersion").and_then(Value::as_str) != Some(NATIVE_JS_RECORD_CACHE_SCHEMA) {
        return Err("Native JS record cache input has an unsupported schemaVersion.".to_string());
    }
    let project_id = object
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Native JS record cache input projectId is required.")?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("Native JS record cache input operation is required.")?;
    let mut connection = open_native_store(root).map_err(|error| error.to_string())?;
    let project_pk = project_pk(&connection, project_id)?;
    match operation {
        "load" => {
            let paths = object
                .get("paths")
                .and_then(Value::as_array)
                .ok_or("Native JS record cache load requires paths.")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or("Native JS record cache paths must be strings.")
                })
                .collect::<Result<Vec<_>, _>>()?;
            if paths.iter().any(|path| !valid_relative_path(path)) {
                return Err(
                    "Native JS record cache paths must be safe repository-relative paths."
                        .to_string(),
                );
            }
            load_records(&connection, project_pk, &paths)
        }
        "store" => {
            let records = object
                .get("records")
                .and_then(Value::as_array)
                .ok_or("Native JS record cache store requires records.")?;
            store_records(&mut connection, project_pk, records)
        }
        _ => Err("Native JS record cache operation must be load or store.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{NATIVE_JS_RECORD_CACHE_SCHEMA, handle_native_js_record_cache};
    use crate::inventory::scan_native_incremental_manifest;
    use serde_json::json;
    use std::fs;

    #[test]
    fn stores_and_loads_only_records_matching_the_current_native_hash() {
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-record-cache-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/index.js"), "module.exports = 1;\n").unwrap();
        let manifest = scan_native_incremental_manifest(&root).unwrap();
        let request = json!({
            "schemaVersion": NATIVE_JS_RECORD_CACHE_SCHEMA,
            "operation": "store",
            "projectId": manifest.inventory.project_identity.project_id,
            "records": [{ "path": "src/index.js", "record": { "relativePath": "src/index.js", "result": { "analysis": { "status": "parsed" } } } }],
        });
        let stored = handle_native_js_record_cache(&root, &request.to_string()).unwrap();
        assert_eq!(stored["storedRecords"], 1);
        let load = json!({
            "schemaVersion": NATIVE_JS_RECORD_CACHE_SCHEMA,
            "operation": "load",
            "projectId": manifest.inventory.project_identity.project_id,
            "paths": ["src/index.js"],
        });
        assert_eq!(
            handle_native_js_record_cache(&root, &load.to_string()).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::write(root.join("src/index.js"), "module.exports = 2;\n").unwrap();
        scan_native_incremental_manifest(&root).unwrap();
        assert_eq!(
            handle_native_js_record_cache(&root, &load.to_string()).unwrap()["records"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        fs::remove_dir_all(root).unwrap();
    }
}
