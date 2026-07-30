use crate::js_facts::NativeJsFacts;
use crate::js_resolver::NativeJsResolutionFacts;
use crate::source_text::read_source_text;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

fn extension(path: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    if filename.eq_ignore_ascii_case("makefile") {
        return ".makefile".to_string();
    }
    filename
        .rfind('.')
        .map(|index| filename[index..].to_ascii_lowercase())
        .unwrap_or_default()
}

fn without_extension(value: &str) -> &str {
    value
        .rfind('.')
        .map(|index| &value[..index])
        .unwrap_or(value)
}

fn title_case(value: &str) -> String {
    let mut result = String::new();
    let mut previous_was_lower = false;
    for character in value.chars() {
        let separator = ".-_/@".contains(character);
        let uppercase = character.is_ascii_uppercase();
        if separator {
            if !result.is_empty() && !result.ends_with(' ') {
                result.push(' ');
            }
        } else {
            if uppercase && previous_was_lower && !result.ends_with(' ') {
                result.push(' ');
            }
            if result.is_empty() || result.ends_with(' ') {
                // JavaScript titleCase uses String#toUpperCase for the first
                // character of each token, including Unicode letters.
                result.extend(character.to_uppercase());
            } else {
                result.push(character);
            }
        }
        previous_was_lower = character.is_ascii_lowercase();
    }
    result.trim().to_string()
}

fn path_parts(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

fn is_test_path(path: &str) -> bool {
    let parts = path_parts(path)
        .into_iter()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let stem = parts
        .last()
        .map(|value| without_extension(value))
        .unwrap_or("");
    parts.iter().any(|part| part == "__tests__")
        || stem.contains(".test")
        || stem.contains(".spec")
        || stem.ends_with("_test")
}

fn next_route(path: &str) -> Option<String> {
    let parts = path_parts(path);
    let filename = parts.last()?;
    if without_extension(filename) != "route" {
        return None;
    }
    let app_index = parts
        .iter()
        .enumerate()
        .find(|(index, part)| **part == "app" && (*index == 0 || parts[*index - 1] == "src"))?
        .0;
    let segments = parts[app_index + 1..parts.len() - 1]
        .iter()
        .filter(|segment| !(segment.starts_with('(') && segment.ends_with(')')))
        .map(|segment| {
            if segment.starts_with("[...") && segment.ends_with(']') {
                format!("*{}", &segment[4..segment.len() - 1])
            } else if segment.starts_with('[') && segment.ends_with(']') {
                format!(":{}", &segment[1..segment.len() - 1])
            } else {
                (*segment).to_string()
            }
        })
        .collect::<Vec<_>>();
    Some(if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    })
}

fn svelte_route(path: &str) -> Option<String> {
    let parts = path_parts(path);
    let routes_index = parts.iter().position(|part| *part == "routes")?;
    if routes_index < 1 || parts[routes_index - 1] != "src" {
        return None;
    }
    let filename = parts.last()?;
    if !filename.starts_with('+') {
        return None;
    }
    let kind = without_extension(filename)
        .strip_prefix('+')?
        .split('.')
        .next()?;
    if !["page", "layout", "server"].contains(&kind) {
        return None;
    }
    let segments = parts[routes_index + 1..parts.len() - 1]
        .iter()
        .filter(|segment| !(segment.starts_with('(') && segment.ends_with(')')))
        .map(|segment| {
            if segment.starts_with("[...") && segment.ends_with(']') {
                format!("*{}", &segment[4..segment.len() - 1])
            } else if segment.starts_with('[') && segment.ends_with(']') {
                format!(":{}", &segment[1..segment.len() - 1])
            } else {
                (*segment).to_string()
            }
        })
        .collect::<Vec<_>>();
    Some(if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    })
}

fn classify_file(path: &str) -> (String, String, String) {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let stem = without_extension(filename).to_ascii_lowercase();
    let configuration_prefix = stem.split('.').next().unwrap_or(&stem);
    let mut file_type = "module";
    let mut label = title_case(without_extension(filename));
    let mut responsibility = "Code module that participates in the application graph.";
    if filename.to_ascii_lowercase().ends_with(".d.ts") {
        file_type = "declaration";
        responsibility = "Type declaration that is not part of the runtime application flow.";
    } else if is_test_path(path) {
        file_type = "test";
        responsibility = "Verifies application component behavior.";
    } else if [
        "vite",
        "vitest",
        "tailwind",
        "postcss",
        "eslint",
        "prettier",
        "drizzle",
        "svelte",
        "playwright",
        "tsconfig",
        "jsconfig",
        "pgtyped",
    ]
    .contains(&configuration_prefix)
    {
        file_type = "config";
        responsibility = "Build, tooling, or project configuration.";
    } else if let Some(route) = svelte_route(path) {
        if stem.split('.').next() == Some("+layout") {
            file_type = "module";
            label = format!("Layout {route}");
        } else {
            file_type = "route";
            label = format!("Route {route}");
            responsibility = "Application entry point detected from the file structure or AST.";
        }
    } else if let Some(route) = next_route(path) {
        file_type = "route";
        label = format!("Route {route}");
        responsibility = "Application entry point detected from the file structure or AST.";
    } else if stem
        .split('.')
        .any(|token| ["route", "routes", "router"].contains(&token))
    {
        file_type = "route";
        responsibility = "Application entry point detected from the file structure or AST.";
    } else if stem.contains("controller") {
        file_type = "controller";
        responsibility = "Connects a transport request to application logic.";
    } else if stem.contains("service") || stem.contains("usecase") || stem.contains("handler") {
        file_type = "service";
        responsibility = "Orchestrates application logic and related dependencies.";
    } else if stem.contains("repository") || stem.ends_with(".repo") || stem.contains("dao") {
        file_type = "repository";
        responsibility = "Accesses or persists application data.";
    } else if stem.contains("entity")
        || stem.contains("model")
        || stem.contains("schema")
        || stem.contains("migration")
    {
        file_type = "database";
        responsibility = "Defines data structure or data access.";
    } else if ["queue", "worker", "consumer", "producer", "subscriber"]
        .iter()
        .any(|token| stem.contains(token))
    {
        file_type = "queue";
        responsibility = "Handles asynchronous work or events.";
    }
    (file_type.to_string(), label, responsibility.to_string())
}

fn derive_domain(path: &str) -> String {
    let parts = path_parts(path);
    let root = parts
        .iter()
        .position(|part| ["src", "apps", "packages", "modules", "services"].contains(part));
    let candidate = root
        .and_then(|index| parts.get(index + 1))
        .copied()
        .or_else(|| parts.first().copied());
    let Some(candidate) = candidate else {
        return "Project".to_string();
    };
    if candidate.contains('.')
        || ["index", "main", "app", "routes"]
            .contains(&without_extension(candidate).to_ascii_lowercase().as_str())
    {
        "Project".to_string()
    } else {
        title_case(candidate)
    }
}

fn derive_feature(path: &str) -> String {
    let parts = path_parts(path);
    let root = parts
        .iter()
        .position(|part| ["src", "apps", "packages", "modules", "services"].contains(part));
    let segments = root
        .map(|index| &parts[index + 1..])
        .unwrap_or(parts.as_slice());
    let first = segments.first().copied().unwrap_or("project");
    let second = segments.get(1).copied();
    if first.contains('.') {
        return "project".to_string();
    }
    match first {
        "app" if second == Some("api") => format!(
            "api/{}",
            segments
                .get(2)
                .filter(|part| !part.starts_with('['))
                .copied()
                .unwrap_or("root")
        ),
        "app" => format!(
            "pages/{}",
            second
                .filter(|part| !part.starts_with('['))
                .unwrap_or("root")
        ),
        "components" => format!(
            "ui/{}",
            second
                .filter(|part| !part.contains('.'))
                .unwrap_or("components")
        ),
        "actions" => "server-actions".to_string(),
        "db" => "data".to_string(),
        "hooks" => "hooks".to_string(),
        "lib" => format!(
            "library/{}",
            second
                .filter(|part| !part.contains('.'))
                .unwrap_or("shared")
        ),
        "types" => "types".to_string(),
        "__test__" => "tests".to_string(),
        _ => first.to_string(),
    }
}

fn package_script_field<'a>(entry: &'a Value, name: &str) -> &'a str {
    entry.get(name).and_then(Value::as_str).unwrap_or("")
}

fn package_script_entry_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    crate::js_facts::js_locale_compare(
        package_script_field(left, "manifest"),
        package_script_field(right, "manifest"),
    )
    .then_with(|| {
        crate::js_facts::js_locale_compare(
            package_script_field(left, "scriptName"),
            package_script_field(right, "scriptName"),
        )
    })
}

pub fn native_manual_descriptions(root: &Path, records: &[Value]) -> BTreeMap<String, String> {
    let all = descriptions(root);
    let mut allowed = BTreeSet::new();
    for record in records {
        let Some(path) = record.get("relativePath").and_then(Value::as_str) else {
            continue;
        };
        for symbol in record
            .pointer("/result/symbols")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(symbol_type), Some(name)) = (
                symbol.get("type").and_then(Value::as_str),
                symbol.get("name").and_then(Value::as_str),
            ) {
                allowed.insert(format!("symbol:{path}:{symbol_type}:{name}"));
            }
        }
        for endpoint in record
            .pointer("/result/endpoints")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(method), Some(route)) = (
                endpoint.get("method").and_then(Value::as_str),
                endpoint.get("route").and_then(Value::as_str),
            ) {
                allowed.insert(format!("endpoint:{path}:{method}:{route}"));
            }
        }
        for integration in record
            .pointer("/result/integrations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(kind), Some(instance)) = (
                integration.get("type").and_then(Value::as_str),
                integration.get("instance").and_then(Value::as_str),
            ) {
                allowed.insert(format!("runtime:{path}:{kind}:{instance}"));
            }
        }
    }
    all.into_iter()
        .filter(|(id, value)| allowed.contains(id) && !value.trim().is_empty())
        .collect()
}

fn descriptions(root: &Path) -> BTreeMap<String, String> {
    for relative in [
        ".flopeek/descriptions.json",
        ".project-flow/descriptions.json",
    ] {
        if let Ok(contents) = fs::read_to_string(root.join(relative))
            && let Ok(values) = serde_json::from_str(&contents)
        {
            return values;
        }
    }
    BTreeMap::new()
}

fn public_source_hash(root: &Path, path: &str) -> Result<String, String> {
    let source = read_source_text(root.join(path))
        .map_err(|error| {
            format!("Unable to read {path} while creating a native structural record: {error}")
        })?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    Ok(native_public_source_hash(&source))
}

/// Flopeek's public graph contract uses a normalized SHA-256 source hash.
/// Keeping this separate from the inventory's BLAKE3 change detector lets a
/// long-lived native session retain contract hashes without reopening every
/// unchanged source file during an incremental refresh.
pub fn native_public_source_hash(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
}

fn projected_result(facts: &NativeJsFacts, resolution: &NativeJsResolutionFacts) -> Value {
    let structural = &facts.structural;
    let calls = structural
        .calls
        .iter()
        .map(|call| {
            let mut value = Map::new();
            value.insert("name".to_string(), json!(call.name));
            value.insert("evidence".to_string(), json!(call.evidence));
            if let Some(source) = &call.source {
                value.insert("source".to_string(), json!(source));
            }
            if let Some(imported) = &call.imported {
                value.insert("imported".to_string(), json!(imported));
            }
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    let schedules = structural
        .schedules
        .iter()
        .map(|schedule| json!({ "taskName": schedule.task_name, "evidence": schedule.evidence }))
        .collect::<Vec<_>>();
    json!({
        "symbols": structural.symbols,
        "imports": structural.imports,
        "integrations": structural.integrations,
        "endpoints": structural.endpoints,
        "frameworkCommands": structural.framework_commands,
        "schedules": schedules,
        "calls": calls,
        "runtimeActions": structural.runtime_actions,
        "requests": structural.requests,
        "resolvedImports": resolution.resolved_imports,
        "resolvedPackages": resolution.resolved_packages,
        "externalImports": resolution.external_imports,
    })
}

pub fn build_native_js_structural_records(
    root: &Path,
    facts: &BTreeMap<String, NativeJsFacts>,
    resolution: &BTreeMap<String, NativeJsResolutionFacts>,
    source_scopes: &BTreeMap<String, String>,
    record_orders: &BTreeMap<String, usize>,
) -> Result<Vec<Value>, String> {
    build_native_js_structural_records_with_source_hashes(
        root,
        facts,
        resolution,
        source_scopes,
        record_orders,
        None,
    )
}

pub fn build_native_js_structural_records_with_source_hashes(
    root: &Path,
    facts: &BTreeMap<String, NativeJsFacts>,
    resolution: &BTreeMap<String, NativeJsResolutionFacts>,
    source_scopes: &BTreeMap<String, String>,
    record_orders: &BTreeMap<String, usize>,
    source_hashes: Option<&BTreeMap<String, String>>,
) -> Result<Vec<Value>, String> {
    let descriptions = descriptions(root);
    let mut records = facts
        .iter()
        .map(|(path, facts)| {
            let scope = source_scopes.get(path).map(String::as_str).unwrap_or("application");
            let (mut file_type, label, mut responsibility) = classify_file(path);
            if facts.structural.analysis.status == "inventory-only" {
                responsibility = "Known static file retained as inventory only; no structural relationship is inferred.".to_string();
            } else if scope == "test" {
                file_type = "test".to_string();
                responsibility = "Verifies application component behavior.".to_string();
            } else if scope == "fixture" {
                responsibility = "Fixture source retained as static diagnostic evidence.".to_string();
            } else if scope == "generated" {
                responsibility = "Generated source retained as static diagnostic evidence.".to_string();
            }
            let extension = extension(path);
            let language = extension.trim_start_matches('.');
            let mut analysis = serde_json::to_value(&facts.structural.analysis)
                .map_err(|error| error.to_string())?;
            // The JavaScript inventory adapter intentionally has no parse
            // diagnostics field. Preserve that contract while retaining the
            // numeric field for structural adapters that expose it.
            if facts.structural.analysis.status == "inventory-only" {
                analysis
                    .as_object_mut()
                    .expect("Native analysis serializes as an object")
                    .remove("diagnostics");
            }
            let file_metadata = json!({
                "domain": derive_domain(path),
                "feature": derive_feature(path),
                "label": label,
                "layer": scope,
                "detectedResponsibility": responsibility,
                "sourceScope": scope,
                "methods": facts.structural.methods,
                "language": language,
                "analysis": analysis,
                "evidence": { "file": path },
                "manualDescription": descriptions.get(&format!("file:{path}")).cloned().unwrap_or_default(),
            });
            let result = projected_result(
                facts,
                resolution
                    .get(path)
                    .ok_or_else(|| format!("Native JavaScript resolution facts are missing for {path}."))?,
            );
            Ok(json!({
                "recordOrder": record_orders.get(path).copied().ok_or_else(|| format!("Native record order is missing for {path}."))?,
                "relativePath": path,
                "extension": extension,
                "language": language,
                "sourceScope": scope,
                "fileNodeType": file_type,
                "fileMetadata": file_metadata,
                "sourceHash": source_hashes
                    .and_then(|hashes| hashes.get(path).cloned())
                    .map(Ok)
                    .unwrap_or_else(|| public_source_hash(root, path))?,
                "result": result,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    records.sort_by_key(|record| {
        record
            .get("recordOrder")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
    Ok(records)
}

/// Normalize one complete public record collection at the batch boundary.
///
/// Builders can be invoked for only the changed records of an incremental
/// refresh. Reindexing inside a partial builder would collide with unchanged
/// records; the caller that owns the complete collection must do it after
/// merging instead.
pub fn normalize_structural_record_orders(records: &mut [Value]) {
    records.sort_by_key(|record| {
        record
            .get("recordOrder")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
    for (order, record) in records.iter_mut().enumerate() {
        record["recordOrder"] = json!(order);
    }
}

fn script_tokens_or_reason(value: &Value) -> Result<(&str, &str), &'static str> {
    let Some(value) = value.as_str() else {
        return Err("script-is-not-a-nonempty-string");
    };
    let value = value.trim();
    if value.is_empty() {
        return Err("script-is-not-a-nonempty-string");
    }
    if value.chars().any(|item| "|&;><`$'\"\\\r\n".contains(item)) {
        return Err("shell-syntax-or-quoting");
    }
    let tokens = value.split_ascii_whitespace().collect::<Vec<_>>();
    if tokens.len() != 2 {
        return Err("not-a-direct-runner-and-source-target");
    }
    if ![
        "node", "nodejs", "tsx", "ts-node", "bun", "python", "python3", "php",
    ]
    .contains(&tokens[0])
    {
        return Err("unsupported-direct-runner");
    }
    if tokens[1].is_empty() || tokens[1].starts_with('-') {
        return Err("missing-literal-source-target");
    }
    Ok((tokens[0], tokens[1]))
}

fn normalized_relative_path(base: &str, target: &str) -> Option<String> {
    let mut parts = base
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    let normalized_target = target.replace('\\', "/");
    for part in normalized_target.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop()?;
        } else {
            parts.push(part);
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn local_package_manifests(root: &Path, records: &[Value]) -> Vec<String> {
    let mut manifests = BTreeSet::new();
    for record in records {
        let Some(path) = record.get("relativePath").and_then(Value::as_str) else {
            continue;
        };
        let mut directory = path
            .rsplit_once('/')
            .map(|(directory, _)| directory)
            .unwrap_or("")
            .to_string();
        loop {
            let manifest = if directory.is_empty() {
                "package.json".to_string()
            } else {
                format!("{directory}/package.json")
            };
            if root.join(&manifest).is_file() {
                manifests.insert(manifest);
            }
            if directory.is_empty() {
                break;
            }
            directory = directory
                .rsplit_once('/')
                .map(|(parent, _)| parent.to_string())
                .unwrap_or_default();
        }
    }
    manifests.into_iter().collect()
}

pub fn build_native_js_entry_facts(
    root: &Path,
    facts: &BTreeMap<String, NativeJsFacts>,
    records: &[Value],
) -> Value {
    build_native_js_entry_facts_for_manifests(root, facts, records, None)
}

/// Package-scoped scans may deliberately constrain manifest-derived entries to
/// the selected package. File parsing still receives repository-relative
/// paths, while command facts never leak from an ancestor monorepo manifest.
pub fn build_native_js_entry_facts_for_manifests(
    root: &Path,
    facts: &BTreeMap<String, NativeJsFacts>,
    records: &[Value],
    allowed_manifests: Option<&BTreeSet<String>>,
) -> Value {
    let by_path = records
        .iter()
        .filter_map(|record| {
            record
                .get("relativePath")
                .and_then(Value::as_str)
                .map(|path| (path, record))
        })
        .collect::<BTreeMap<_, _>>();
    let descriptions = descriptions(root);
    let mut package_commands = Vec::new();
    let mut package_scripts = Vec::new();
    let mut unsupported_package_scripts = Vec::new();
    let mut schedules = Vec::new();
    let mut unsupported_schedules = Vec::new();
    let mut framework_commands = Vec::new();
    let mut unsupported_framework_commands = Vec::new();
    let mut entry_metadata = Map::new();
    let mut edge_metadata = Map::new();
    for manifest_path in local_package_manifests(root, records)
        .into_iter()
        .filter(|manifest| allowed_manifests.is_none_or(|allowed| allowed.contains(manifest)))
    {
        let Ok(content) = fs::read_to_string(root.join(&manifest_path)) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let Some(scripts) = manifest.get("scripts").and_then(Value::as_object) else {
            continue;
        };
        for (script_name, command) in scripts {
            let command = match script_tokens_or_reason(command) {
                Ok(command) => command,
                Err(reason) => {
                    unsupported_package_scripts.push(
                        json!({"manifest":manifest_path,"scriptName":script_name,"reason":reason}),
                    );
                    continue;
                }
            };
            let manifest_directory = manifest_path
                .rsplit_once('/')
                .map(|(directory, _)| directory)
                .unwrap_or("");
            let Some(target_path) = normalized_relative_path(manifest_directory, command.1) else {
                unsupported_package_scripts.push(json!({"manifest":manifest_path,"scriptName":script_name,"reason":"target-outside-repository"}));
                continue;
            };
            let Some(target) = by_path.get(target_path.as_str()) else {
                unsupported_package_scripts.push(json!({"manifest":manifest_path,"scriptName":script_name,"reason":"target-not-in-static-source-set","targetPath":target_path}));
                continue;
            };
            let id = format!("command:{manifest_path}:{script_name}");
            let target_id = format!("file:{target_path}");
            let metadata = target.get("fileMetadata").unwrap_or(&Value::Null);
            let evidence = json!({
                "parser": "package-json", "file": manifest_path, "kind": "literal-direct-runner-script",
                "scriptName": script_name, "runner": command.0, "targetPath": target_path,
            });
            entry_metadata.insert(id.clone(), json!({
                "entryKind": "package-script", "label": format!("npm run {script_name}"), "manifest": manifest_path,
                "scriptName": script_name, "runner": command.0, "targetPath": target_path,
                "domain": metadata.get("domain").cloned().unwrap_or(Value::String("Project".to_string())),
                "feature": metadata.get("feature").cloned().unwrap_or(Value::String("project".to_string())),
                "layer": metadata.get("layer").cloned().unwrap_or(Value::String("application".to_string())),
                "sourceScope": target.get("sourceScope").cloned().unwrap_or(Value::String("application".to_string())),
                "detectedResponsibility": "Literal package script declaration targeting one statically scanned source file.",
                "methods": [], "language": "json",
                "analysis": {"parser":"package-json","status":"literal-direct-runner","confidence":"exact"},
                "evidence": evidence, "manualDescription": descriptions.get(&id).cloned().unwrap_or_default(),
            }));
            edge_metadata.insert(
                format!("{id}\u{0}{target_id}\u{0}declares-command-target"),
                json!({"confidence":"exact","evidence":evidence}),
            );
            package_commands.push(
                json!({"manifest":manifest_path,"scriptName":script_name,"targetPath":target_path}),
            );
            package_scripts.push(json!({"id":id,"manifest":manifest_path,"scriptName":script_name,"runner":command.0,"targetPath":target_path,"targetId":target_id}));
        }
    }
    for (path, fact) in facts {
        let Some(record) = by_path.get(path.as_str()) else {
            continue;
        };
        let metadata = record.get("fileMetadata").unwrap_or(&Value::Null);
        let symbols = record
            .pointer("/result/symbols")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for unsupported in &fact.structural.unsupported_framework_commands {
            unsupported_framework_commands.push(unsupported.clone());
        }
        for command in &fact.structural.framework_commands {
            let (Some(adapter), Some(command_name), Some(target_name), Some(target_type)) = (
                command.get("adapter").and_then(Value::as_str),
                command.get("commandName").and_then(Value::as_str),
                command.get("targetName").and_then(Value::as_str),
                command.get("targetType").and_then(Value::as_str),
            ) else {
                continue;
            };
            let target_path = command.get("path").and_then(Value::as_str).unwrap_or(path);
            let exact_target = symbols.iter().any(|symbol| {
                symbol.get("type").and_then(Value::as_str) == Some(target_type)
                    && symbol.get("name").and_then(Value::as_str) == Some(target_name)
            });
            if !exact_target {
                unsupported_framework_commands.push(json!({"path":path,"adapter":adapter,"commandName":command_name,"reason":"exact-command-target-symbol-not-found"}));
                continue;
            }
            let id = format!("command:{target_path}:{adapter}:{command_name}");
            let target_id = format!("symbol:{target_path}:{target_type}:{target_name}");
            let entry_kind = if adapter == "django" {
                "django-management-command"
            } else {
                "framework-command"
            };
            let evidence = json!({
                "parser": command.pointer("/evidence/parser").and_then(Value::as_str).unwrap_or("python-lezer"),
                "file": command.pointer("/evidence/file").and_then(Value::as_str).unwrap_or(target_path),
                "range": command.get("evidence").and_then(|value| value.get("range")).cloned().unwrap_or(Value::Null),
                "kind": entry_kind, "adapter": adapter, "commandName": command_name, "targetId": target_id,
            });
            entry_metadata.insert(id.clone(), json!({
                "entryKind":entry_kind,
                "label":if adapter == "django" { format!("python manage.py {command_name}") } else { format!("{adapter} {command_name}") },
                "commandName":command_name,"targetPath":target_path,"targetId":target_id,"adapter":adapter,
                "domain":metadata.get("domain").cloned().unwrap_or(Value::String("Project".to_string())),
                "feature":metadata.get("feature").cloned().unwrap_or(Value::String("project".to_string())),
                "layer":metadata.get("layer").cloned().unwrap_or(Value::String("application".to_string())),
                "sourceScope":record.get("sourceScope").cloned().unwrap_or(Value::String("application".to_string())),
                "detectedResponsibility":if adapter == "django" { "Exact Django management command declaration targeting one top-level Command class with a direct handle method.".to_string() } else { format!("Exact {adapter} command decorator targeting one top-level function.") },
                "methods":[],"language":record.get("language").cloned().unwrap_or(Value::String("py".to_string())),
                "analysis":{"parser":"python-lezer","status":entry_kind,"confidence":"exact"},
                "evidence":evidence,"manualDescription":descriptions.get(&id).cloned().unwrap_or_default(),
            }));
            edge_metadata.insert(
                format!("{id}\u{0}{target_id}\u{0}declares-command-target"),
                json!({"confidence":"exact","evidence":evidence}),
            );
            framework_commands.push(if adapter == "django" {
                json!({"id":id,"path":target_path,"commandName":command_name,"targetPath":target_path,"targetId":target_id})
            } else {
                json!({"id":id,"adapter":adapter,"path":target_path,"commandName":command_name,"targetPath":target_path,"targetId":target_id})
            });
        }
        for schedule in &fact.structural.unsupported_schedules {
            let candidate_path = if schedule.path.is_empty() {
                path
            } else {
                &schedule.path
            };
            unsupported_schedules.push(json!({"path":candidate_path,"reason":schedule.reason}));
        }
        for schedule in &fact.structural.schedules {
            let Some(_symbol) = symbols.iter().find(|symbol| {
                symbol.get("type").and_then(Value::as_str) == Some("function")
                    && symbol.get("name").and_then(Value::as_str)
                        == Some(schedule.task_name.as_str())
            }) else {
                unsupported_schedules.push(json!({"path":path,"taskName":schedule.task_name,"reason":"task-is-not-an-exact-local-top-level-function"}));
                continue;
            };
            let target_id = format!("symbol:{path}:function:{}", schedule.task_name);
            let start = &schedule.evidence.range.start;
            let id = format!(
                "schedule:{path}:{}:{}:{}",
                schedule.task_name, start.line, start.column
            );
            let evidence = json!({
                "parser": schedule.evidence.parser, "file": schedule.evidence.file, "range": schedule.evidence.range,
                "kind":"node-cron-literal-schedule", "adapter":"node-cron", "expression":schedule.expression,
                "taskName":schedule.task_name, "targetId":target_id,
            });
            entry_metadata.insert(id.clone(), json!({
                "entryKind":"node-cron-schedule", "label":format!("node-cron {} → {}",schedule.expression,schedule.task_name),
                "scheduleExpression":schedule.expression, "taskName":schedule.task_name, "targetPath":path,
                "targetId":target_id, "adapter":"node-cron",
                "domain":metadata.get("domain").cloned().unwrap_or(Value::String("Project".to_string())),
                "feature":metadata.get("feature").cloned().unwrap_or(Value::String("project".to_string())),
                "layer":metadata.get("layer").cloned().unwrap_or(Value::String("application".to_string())),
                "sourceScope":record.get("sourceScope").cloned().unwrap_or(Value::String("application".to_string())),
                "detectedResponsibility":"Literal node-cron registration targeting one statically local top-level function.",
                "methods":[], "language":record.get("language").cloned().unwrap_or(Value::String("js".to_string())),
                "analysis":{"parser":"typescript-ast","status":"literal-node-cron-schedule","confidence":"exact"},
                "evidence":evidence, "manualDescription":descriptions.get(&id).cloned().unwrap_or_default(),
            }));
            edge_metadata.insert(
                format!("{id}\u{0}{target_id}\u{0}schedules"),
                json!({"confidence":"exact","evidence":evidence}),
            );
            schedules.push(json!({"id":id,"path":path,"expression":schedule.expression,"taskName":schedule.task_name,"targetPath":path,"targetId":target_id}));
        }
    }
    package_commands.sort_by(package_script_entry_order);
    package_scripts.sort_by(package_script_entry_order);
    unsupported_package_scripts.sort_by(package_script_entry_order);
    schedules.sort_by_key(|left| left.to_string());
    unsupported_schedules.sort_by_key(|left| left.to_string());
    framework_commands.sort_by_key(|left| left.to_string());
    unsupported_framework_commands.sort_by_key(|left| left.to_string());
    json!({
        "packageCommands": package_commands,
        "entryMetadata": entry_metadata,
        "edgeMetadata": edge_metadata,
        "entryPoints": {
            "schemaVersion":"flopeek-static-entry-inventory/v1",
            "supported":{"packageScripts":package_scripts,"djangoManagementCommands":framework_commands.iter().filter(|command| command.get("adapter").is_none()).cloned().collect::<Vec<_>>(),"frameworkCommands":framework_commands.iter().filter(|command| command.get("adapter").is_some()).cloned().collect::<Vec<_>>(),"nodeCronSchedules":schedules,"limitation":"Only an explicitly supported exact static subset becomes a Flow Lens entry: a direct package runner target, a supported Python framework command declaration, or a literal node-cron registration."},
            "unsupported":{"packageScripts":unsupported_package_scripts,"djangoManagementCommands":unsupported_framework_commands.iter().filter(|command| command.get("adapter").and_then(Value::as_str) == Some("django")).cloned().collect::<Vec<_>>(),"frameworkCommands":unsupported_framework_commands.iter().filter(|command| command.get("adapter").and_then(Value::as_str) != Some("django")).cloned().collect::<Vec<_>>(),"nodeCronSchedules":unsupported_schedules,"limitation":"Unsupported scripts, framework commands, and schedule registrations are static inventory only. Their absence from Flow Lenses does not prove they cannot run or have no behavior."},
            "limitations":[
                "Package scripts are not executed during discovery or scanning.",
                "Shell composition, quoting, environment expansion, package-manager indirection, runner flags, computed configuration, and runtime module loading are not command-entry facts in this version.",
                "Django discovery does not execute settings or app registration. Only a non-private management/commands module with one top-level Command class directly extending the imported BaseCommand binding and one direct handle method is projected.",
                "Click, Typer, and Flask CLI discovery does not import modules or initialize applications. Only direct module/import bindings, direct top-level decorator registrations, and one top-level function target are projected; computed decorators, factory indirection, and non-literal command names remain unsupported.",
                "Scheduler registration is not executed during discovery or scanning. Only the narrow node-cron default-import, literal-expression, exact-local-function subset is projected; scheduler initialization, task timing, callbacks, dynamic expressions, and other scheduler APIs remain unsupported."
            ]
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_native_js_entry_facts, build_native_js_structural_records, classify_file,
        normalize_structural_record_orders,
    };
    use crate::js_facts::parse_native_js_facts;
    use crate::js_resolver::resolve_native_js_imports;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;

    #[test]
    fn classifies_sveltekit_layout_as_a_module_not_a_route_entry() {
        assert_eq!(
            classify_file("src/routes/+layout.svelte"),
            (
                "module".to_string(),
                "Layout /".to_string(),
                "Code module that participates in the application graph.".to_string(),
            )
        );
        assert_eq!(classify_file("src/routes/orders/+page.svelte").0, "route");
    }

    #[test]
    fn classifies_javascript_oracle_configuration_prefixes_as_config() {
        for path in [
            "svelte.config.js",
            "vite.config.ts",
            "eslint.config.mjs",
            "tsconfig.json",
            "playwright.config.ts",
        ] {
            let classification = classify_file(path);
            assert_eq!(classification.0, "config", "{path}");
            assert_eq!(
                classification.2, "Build, tooling, or project configuration.",
                "{path}"
            );
        }
        assert_eq!(classify_file("src/config.ts").0, "module");
    }

    #[test]
    fn creates_compatibility_shaped_records_with_sha256_public_hashes() {
        let root =
            std::env::temp_dir().join(format!("flopeek-native-js-batch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/service.ts"), "export function run() {}\n").unwrap();
        let facts = BTreeMap::from([(
            "src/service.ts".to_string(),
            parse_native_js_facts("src/service.ts", "export function run() {}\n").unwrap(),
        )]);
        let known = BTreeSet::from(["src/service.ts".to_string()]);
        let resolution = resolve_native_js_imports(&root, &facts, &known);
        let records = build_native_js_structural_records(
            &root,
            &facts,
            &resolution,
            &BTreeMap::from([("src/service.ts".to_string(), "application".to_string())]),
            &BTreeMap::from([("src/service.ts".to_string(), 0)]),
        )
        .unwrap();
        assert_eq!(records[0]["fileNodeType"], "service");
        assert_eq!(records[0]["sourceHash"].as_str().unwrap().len(), 64);
        assert_eq!(records[0]["result"]["symbols"][0]["name"], "run");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_scope_marks_a_record_as_a_test_even_without_a_test_filename() {
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-js-test-scope-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::write(root.join("tests/bootstrap.php"), "<?php\n").unwrap();
        let facts = BTreeMap::from([(
            "tests/bootstrap.php".to_string(),
            parse_native_js_facts("tests/bootstrap.php", "<?php\n").unwrap(),
        )]);
        let resolution = resolve_native_js_imports(
            &root,
            &facts,
            &BTreeSet::from(["tests/bootstrap.php".to_string()]),
        );
        let records = build_native_js_structural_records(
            &root,
            &facts,
            &resolution,
            &BTreeMap::from([("tests/bootstrap.php".to_string(), "test".to_string())]),
            &BTreeMap::from([("tests/bootstrap.php".to_string(), 0)]),
        )
        .unwrap();
        assert_eq!(records[0]["fileNodeType"], "test");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compacts_record_order_after_unsupported_candidates_are_filtered() {
        let root =
            std::env::temp_dir().join(format!("flopeek-native-js-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/first.ts"), "export const first = true;\n").unwrap();
        fs::write(root.join("src/last.ts"), "export const last = true;\n").unwrap();
        let facts = BTreeMap::from([
            (
                "src/first.ts".to_string(),
                parse_native_js_facts("src/first.ts", "export const first = true;\n").unwrap(),
            ),
            (
                "src/last.ts".to_string(),
                parse_native_js_facts("src/last.ts", "export const last = true;\n").unwrap(),
            ),
        ]);
        let known = BTreeSet::from([
            "src/first.ts".to_string(),
            "src/ignored.go".to_string(),
            "src/last.ts".to_string(),
        ]);
        let resolution = resolve_native_js_imports(&root, &facts, &known);
        let mut records = build_native_js_structural_records(
            &root,
            &facts,
            &resolution,
            &BTreeMap::from([
                ("src/first.ts".to_string(), "application".to_string()),
                ("src/last.ts".to_string(), "application".to_string()),
            ]),
            &BTreeMap::from([
                ("src/first.ts".to_string(), 0),
                ("src/last.ts".to_string(), 2),
            ]),
        )
        .unwrap();
        normalize_structural_record_orders(&mut records);
        assert_eq!(records[0]["recordOrder"], 0);
        assert_eq!(records[1]["recordOrder"], 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_literal_package_scripts_and_node_cron_entries_from_native_facts() {
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-js-entry-facts-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"start":"node src/jobs.ts","shell":"node src/jobs.ts && echo nope"}}"#,
        )
        .unwrap();
        let source = "import cron from 'node-cron';\nexport function tick() {}\ncron.schedule('* * * * *', tick);\n";
        fs::write(root.join("src/jobs.ts"), source).unwrap();
        let facts = BTreeMap::from([(
            "src/jobs.ts".to_string(),
            parse_native_js_facts("src/jobs.ts", source).unwrap(),
        )]);
        let resolution =
            resolve_native_js_imports(&root, &facts, &BTreeSet::from(["src/jobs.ts".to_string()]));
        let records = build_native_js_structural_records(
            &root,
            &facts,
            &resolution,
            &BTreeMap::from([("src/jobs.ts".to_string(), "application".to_string())]),
            &BTreeMap::from([("src/jobs.ts".to_string(), 0)]),
        )
        .unwrap();
        let entries = build_native_js_entry_facts(&root, &facts, &records);
        assert_eq!(
            entries["entryPoints"]["supported"]["packageScripts"][0]["id"],
            "command:package.json:start"
        );
        assert_eq!(
            entries["entryPoints"]["unsupported"]["packageScripts"][0]["reason"],
            "shell-syntax-or-quoting"
        );
        assert_eq!(
            entries["entryPoints"]["supported"]["nodeCronSchedules"][0]["targetId"],
            "symbol:src/jobs.ts:function:tick"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orders_package_script_inventory_by_manifest_and_script_name() {
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-js-script-order-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"zeta":"node src/x.js | echo","beta":"npm src/x.js","alpha":"node src/x.js && echo"}}"#,
        )
        .unwrap();
        let records = [serde_json::json!({ "relativePath": "src/x.js" })];
        let entries = build_native_js_entry_facts(&root, &BTreeMap::new(), &records);
        let names = entries["entryPoints"]["unsupported"]["packageScripts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["scriptName"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["alpha", "beta", "zeta"]);
        fs::remove_dir_all(root).unwrap();
    }
}
