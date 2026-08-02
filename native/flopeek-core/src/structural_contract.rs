use serde::Deserialize;
use serde_json::Value;

const MAX_FACT_STRING_BYTES: usize = 4_096;
const MAX_FACT_DEPTH: usize = 20;
const MAX_NESTED_ARRAY_ITEMS: usize = 20_000;
const MAX_OBJECT_FIELDS: usize = 96;

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuralRecordAllowlist {
    record_order: u64,
    relative_path: String,
    #[serde(default)]
    extension: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    source_scope: Option<String>,
    #[serde(default)]
    file_node_type: Option<String>,
    #[serde(default)]
    file_metadata: Option<FileMetadataAllowlist>,
    source_hash: String,
    result: StructuralResultAllowlist,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileMetadataAllowlist {
    #[serde(default)]
    domain: Option<Value>,
    #[serde(default)]
    feature: Option<Value>,
    #[serde(default)]
    label: Option<Value>,
    #[serde(default)]
    layer: Option<Value>,
    #[serde(default)]
    detected_responsibility: Option<Value>,
    #[serde(default)]
    source_scope: Option<Value>,
    #[serde(default)]
    methods: Option<Value>,
    #[serde(default)]
    language: Option<Value>,
    #[serde(default)]
    analysis: Option<Value>,
    #[serde(default)]
    evidence: Option<Value>,
    #[serde(default)]
    manual_description: Option<Value>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuralResultAllowlist {
    #[serde(default)]
    imports: Option<Value>,
    #[serde(default)]
    endpoints: Option<Value>,
    #[serde(default)]
    requests: Option<Value>,
    #[serde(default)]
    calls: Option<Value>,
    #[serde(default)]
    methods: Option<Value>,
    #[serde(default)]
    symbols: Option<Value>,
    #[serde(default)]
    identity_symbols: Option<Value>,
    #[serde(default)]
    integrations: Option<Value>,
    #[serde(default)]
    framework_commands: Option<Value>,
    #[serde(default)]
    unsupported_framework_commands: Option<Value>,
    #[serde(default)]
    runtime_actions: Option<Value>,
    #[serde(default)]
    schedules: Option<Value>,
    #[serde(default)]
    unsupported_schedules: Option<Value>,
    #[serde(default)]
    analysis: Option<Value>,
    #[serde(default)]
    resolved_imports: Option<Value>,
    #[serde(default)]
    resolved_packages: Option<Value>,
    #[serde(default)]
    external_imports: Option<Value>,
}

fn validate_bounded_metadata(value: &Value, depth: usize) -> Result<(), String> {
    if depth > MAX_FACT_DEPTH {
        return Err("structural facts exceed the maximum metadata nesting depth".to_string());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            if text.len() > MAX_FACT_STRING_BYTES {
                return Err("structural fact metadata contains an oversized string".to_string());
            }
            if text.contains(['\0', '\r', '\n']) {
                return Err(
                    "structural fact metadata must be bounded single-line metadata, not source text"
                        .to_string(),
                );
            }
            Ok(())
        }
        Value::Array(items) => {
            if items.len() > MAX_NESTED_ARRAY_ITEMS {
                return Err("structural fact metadata contains an oversized array".to_string());
            }
            for item in items {
                validate_bounded_metadata(item, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(entries) => {
            if entries.len() > MAX_OBJECT_FIELDS {
                return Err("structural fact metadata contains an oversized object".to_string());
            }
            for (key, nested) in entries {
                if key.len() > 80 {
                    return Err(
                        "structural fact metadata contains an oversized field name".to_string()
                    );
                }
                let lower = key.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "content"
                        | "contents"
                        | "rawsource"
                        | "sourcebody"
                        | "sourcecode"
                        | "sourcetext"
                        | "text"
                        | "code"
                ) {
                    return Err(format!(
                        "structural fact metadata field {key:?} is not part of the source-free contract"
                    ));
                }
                validate_bounded_metadata(nested, depth + 1)?;
            }
            Ok(())
        }
    }
}

pub(crate) fn validate_structural_records(records: &[Value]) -> Result<(), String> {
    for record in records {
        StructuralRecordAllowlist::deserialize(record).map_err(|error| {
            format!("structural record does not match the typed source-free allowlist: {error}")
        })?;
        validate_bounded_metadata(record, 0)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_structural_records;
    use serde_json::json;

    fn record(result: serde_json::Value) -> serde_json::Value {
        json!({
            "recordOrder": 0,
            "relativePath": "src/a.js",
            "language": "javascript",
            "sourceHash": "a".repeat(64),
            "result": result
        })
    }

    #[test]
    fn accepts_declared_structural_fields() {
        validate_structural_records(&[record(json!({
            "symbols": [],
            "calls": [],
            "resolvedImports": []
        }))])
        .unwrap();
    }

    #[test]
    fn rejects_unknown_record_and_result_fields() {
        let mut unknown_record = record(json!({ "symbols": [] }));
        unknown_record["payload"] = json!("hidden");
        assert!(validate_structural_records(&[unknown_record]).is_err());
        assert!(
            validate_structural_records(&[record(json!({
                "symbols": [],
                "payload": "const hidden = true;"
            }))])
            .is_err()
        );
    }

    #[test]
    fn rejects_source_like_nested_fields_and_multiline_strings() {
        assert!(
            validate_structural_records(&[record(json!({
                "integrations": [{ "code": "const hidden = true;" }]
            }))])
            .is_err()
        );
        assert!(
            validate_structural_records(&[record(json!({
                "integrations": [{ "reason": "line one\nline two" }]
            }))])
            .is_err()
        );
    }
}
