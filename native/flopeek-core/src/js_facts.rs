use crate::inventory::scan_native_inventory_with_paths;
use crate::js_batch::{build_native_js_entry_facts, build_native_js_structural_records};
use crate::js_resolver::{NativeJsResolutionFacts, resolve_native_js_imports};
use crate::project_identity::ProjectIdentity;
use crate::scope::read_native_scope;
use crate::store::open_native_store;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser};

pub const NATIVE_JS_FACTS_SCHEMA: &str = "flopeek-native-js-facts/v2";
// This must advance when a cached fact's observable structural semantics change.
pub const NATIVE_JS_ADAPTER_VERSION: &str = "native-tree-sitter-js-ts/v13";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsFacts {
    pub schema_version: String,
    pub parser: String,
    pub status: String,
    pub diagnostics: usize,
    pub imports: Vec<String>,
    pub symbols: Vec<NativeJsSymbol>,
    pub direct_calls: Vec<String>,
    /// Compatibility-shaped parser output produced entirely by Rust. The
    /// legacy summary fields above remain diagnostic only; promotion is based
    /// on this ordered, evidence-bearing projection.
    pub structural: NativeJsStructuralFacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJsStructuralFacts {
    pub imports: Vec<NativeJsImport>,
    pub symbols: Vec<NativeJsStructuralSymbol>,
    pub calls: Vec<NativeJsCall>,
    pub endpoints: Vec<NativeJsEndpoint>,
    pub requests: Vec<NativeJsRequest>,
    pub integrations: Vec<serde_json::Value>,
    pub runtime_actions: Vec<serde_json::Value>,
    pub schedules: Vec<NativeJsSchedule>,
    pub unsupported_schedules: Vec<NativeJsUnsupportedSchedule>,
    pub methods: Vec<String>,
    pub analysis: NativeJsAnalysis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsPosition {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsRange {
    pub start: NativeJsPosition,
    pub end: NativeJsPosition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsEvidence {
    pub parser: String,
    pub file: String,
    pub range: NativeJsRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsImport {
    pub specifier: String,
    pub evidence: NativeJsEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsStructuralSymbol {
    #[serde(rename = "type")]
    pub symbol_type: String,
    pub name: String,
    pub methods: Vec<String>,
    pub evidence: NativeJsEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsSymbolReference {
    #[serde(rename = "type")]
    pub symbol_type: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJsImportedReference {
    pub specifier: String,
    pub exported_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsCall {
    pub name: String,
    pub source: Option<NativeJsSymbolReference>,
    pub imported: Option<NativeJsImportedReference>,
    pub evidence: NativeJsEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJsEndpoint {
    pub method: String,
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<serde_json::Value>,
    pub evidence: NativeJsEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsRequest {
    pub method: String,
    pub route: String,
    pub evidence: NativeJsEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJsSchedule {
    pub expression: String,
    pub task_name: String,
    pub evidence: NativeJsEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsUnsupportedSchedule {
    pub path: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<NativeJsEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsAnalysis {
    pub parser: String,
    pub status: String,
    pub confidence: String,
    pub diagnostics: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeJsSymbol {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeJsFactsStatus {
    pub project_root: PathBuf,
    pub project_identity: ProjectIdentity,
    pub adapter_version: String,
    pub parsed_files: usize,
    pub reused_files: usize,
    pub failed_files: usize,
    pub removed_facts: usize,
    pub candidate_files: usize,
    pub candidate_paths: Vec<String>,
    pub changed_paths: Vec<String>,
    pub reused_paths: Vec<String>,
    pub removed_paths: Vec<String>,
    pub source_scope_counts: BTreeMap<String, usize>,
    pub scope_source: String,
    pub flow_entries_tests: bool,
    pub flow_entries_fixtures: bool,
    pub facts: BTreeMap<String, NativeJsFacts>,
    pub resolution: BTreeMap<String, NativeJsResolutionFacts>,
    pub structural_records: Vec<serde_json::Value>,
    pub entry_facts: serde_json::Value,
}

fn language_for_path(path: &str) -> Option<Language> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "js" | "cjs" | "mjs" | "jsx" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        _ => None,
    }
}

fn source_text(node: Node<'_>, source: &str) -> Option<String> {
    node.utf8_text(source.as_bytes()).ok().map(str::to_string)
}

fn identifier_for(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .or_else(|| node.named_child(0))
        .and_then(|child| source_text(child, source))
        .filter(|value| !value.is_empty())
}

fn import_specifier(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| child.kind() == "string")
        .and_then(|child| source_text(child, source))
        .map(|value| value.trim_matches(['\'', '"']).to_string())
        .filter(|value| !value.is_empty())
}

fn direct_call_name(node: Node<'_>, source: &str) -> Option<String> {
    let function = node.child_by_field_name("function")?;
    // Match the JavaScript compatibility oracle's supported subset: only direct
    // identifier calls can create a static call relationship. Property/method
    // dispatch (`response.json()`, `router.post()`) is intentionally excluded
    // because its receiver cannot be resolved safely from this bounded fact.
    (function.kind() == "identifier")
        .then(|| source_text(function, source))
        .flatten()
        .filter(|name| name != "require")
}

fn commonjs_specifier(node: Node<'_>, source: &str) -> Option<String> {
    let value = node.child_by_field_name("value")?;
    if value.kind() != "call_expression" {
        return None;
    }
    let function = value.child_by_field_name("function")?;
    if function.kind() != "identifier"
        || source_text(function, source).as_deref() != Some("require")
    {
        return None;
    }
    let arguments = value.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    arguments
        .named_children(&mut cursor)
        .find(|argument| argument.kind() == "string")
        .and_then(|argument| source_text(argument, source))
        .map(|specifier| specifier.trim_matches(['\'', '"']).to_string())
        .filter(|specifier| !specifier.is_empty())
}

fn string_value(node: Node<'_>, source: &str) -> Option<String> {
    matches!(node.kind(), "string" | "template_string")
        .then(|| source_text(node, source))
        .flatten()
        .map(|value| value.trim_matches(['\'', '"', '`']).to_string())
        .filter(|value| !value.is_empty())
}

fn typescript_column(source: &str, byte_offset: usize) -> usize {
    let safe_offset = byte_offset.min(source.len());
    let line_start = source[..safe_offset]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    source[line_start..safe_offset].encode_utf16().count() + 1
}

// JavaScript's default localeCompare ordering is intentionally used by the
// source scanner for record order. Keep the ASCII subset here explicit rather
// than falling back to byte ordering, which puts `404` before `_app` and a
// `.js` suffix before underscore-qualified sibling names on Windows.
fn js_locale_char_weight(character: char) -> (u8, u32) {
    match character {
        ' ' => (0, 0),
        '_' => (0, 1),
        '-' => (0, 2),
        '.' => (0, 3),
        '[' => (0, 4),
        '@' => (0, 5),
        '/' => (0, 6),
        '0'..='9' => (1, character as u32 - '0' as u32),
        'a'..='z' => (2, character as u32 - 'a' as u32),
        'A'..='Z' => (2, character as u32 - 'A' as u32),
        _ => (3, character as u32),
    }
}

pub(crate) fn js_locale_compare(left: &str, right: &str) -> Ordering {
    let mut left_characters = left.chars();
    let mut right_characters = right.chars();
    loop {
        match (left_characters.next(), right_characters.next()) {
            (Some(left_character), Some(right_character)) => {
                let order = js_locale_char_weight(left_character)
                    .cmp(&js_locale_char_weight(right_character));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (None, None) => break,
        }
    }
    // ICU's default JavaScript collation compares the case-folded spelling
    // first, then uses case as a secondary tie-breaker. Therefore AppCheck
    // comes before auth, while a still comes before A.
    for (left_character, right_character) in left.chars().zip(right.chars()) {
        let left_case = usize::from(left_character.is_ascii_uppercase());
        let right_case = usize::from(right_character.is_ascii_uppercase());
        let order = left_case.cmp(&right_case);
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

fn evidence(path: &str, source: &str, node: Node<'_>) -> NativeJsEvidence {
    let start = node.start_position();
    let end = node.end_position();
    NativeJsEvidence {
        parser: "typescript-ast".to_string(),
        file: path.to_string(),
        range: NativeJsRange {
            start: NativeJsPosition {
                line: start.row + 1,
                column: typescript_column(source, node.start_byte()),
            },
            end: NativeJsPosition {
                line: end.row + 1,
                column: typescript_column(source, node.end_byte()),
            },
        },
    }
}

fn exported_declaration_evidence_node(node: Node<'_>) -> Node<'_> {
    node.parent()
        .filter(|parent| parent.kind() == "export_statement")
        .unwrap_or(node)
}

fn is_top_level(node: Node<'_>) -> bool {
    node.parent().is_some_and(|parent| {
        parent.kind() == "program"
            || (parent.kind() == "export_statement"
                && parent
                    .parent()
                    .is_some_and(|grandparent| grandparent.kind() == "program"))
    })
}

fn top_level_variable(node: Node<'_>) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "variable_declaration" | "lexical_declaration" => {
                return is_top_level(parent);
            }
            "export_statement" => {
                return parent.parent().is_some_and(|item| item.kind() == "program");
            }
            "program" => return false,
            _ => current = parent.parent(),
        }
    }
    false
}

fn class_methods(node: Node<'_>, source: &str) -> Vec<String> {
    let Some(body) = node.child_by_field_name("body") else {
        return Vec::new();
    };
    let mut cursor = body.walk();
    body.named_children(&mut cursor)
        .filter(|child| matches!(child.kind(), "method_definition" | "method_signature"))
        .filter_map(|child| child.child_by_field_name("name"))
        .filter_map(|name| source_text(name, source))
        .filter(|name| !name.starts_with('#') && name != "constructor")
        .collect()
}

fn function_like_variable(node: Node<'_>) -> bool {
    node.child_by_field_name("value").is_some_and(|value| {
        matches!(
            value.kind(),
            "arrow_function" | "function_expression" | "generator_function"
        )
    })
}

fn enclosing_top_level_symbol(node: Node<'_>, source: &str) -> Option<NativeJsSymbolReference> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_declaration" if is_top_level(parent) => {
                return identifier_for(parent, source).map(|name| NativeJsSymbolReference {
                    symbol_type: "class".to_string(),
                    name,
                });
            }
            "function_declaration" | "generator_function_declaration" if is_top_level(parent) => {
                return identifier_for(parent, source).map(|name| NativeJsSymbolReference {
                    symbol_type: "function".to_string(),
                    name,
                });
            }
            "variable_declarator" if top_level_variable(parent) => {
                return parent
                    .child_by_field_name("name")
                    .filter(|name| name.kind() == "identifier")
                    .and_then(|name| source_text(name, source))
                    .map(|name| NativeJsSymbolReference {
                        symbol_type: "function".to_string(),
                        name,
                    });
            }
            "program" => return None,
            _ => current = parent.parent(),
        }
    }
    None
}

fn binding_has_name(node: Node<'_>, name: &str, source: &str) -> bool {
    if node.kind() == "identifier" {
        return source_text(node, source).as_deref() == Some(name);
    }
    node.child_by_field_name("pattern")
        .or_else(|| node.child_by_field_name("name"))
        .filter(|binding| binding.kind() == "identifier")
        .and_then(|binding| source_text(binding, source))
        .as_deref()
        == Some(name)
}

fn declaration_has_name(node: Node<'_>, name: &str, source: &str) -> bool {
    match node.kind() {
        "lexical_declaration" | "variable_declaration" => named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "variable_declarator")
            .filter_map(|child| child.child_by_field_name("name"))
            .any(|binding| binding_has_name(binding, name, source)),
        "function_declaration" | "generator_function_declaration" | "class_declaration" => {
            identifier_for(node, source).as_deref() == Some(name)
        }
        _ => false,
    }
}

fn call_name_is_shadowed(node: Node<'_>, name: &str, source: &str) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "program" {
            return false;
        }
        if matches!(
            parent.kind(),
            "function_declaration"
                | "function_expression"
                | "arrow_function"
                | "generator_function"
                | "method_definition"
        ) && parent
            .child_by_field_name("parameters")
            .is_some_and(|parameters| {
                named_children(parameters)
                    .into_iter()
                    .any(|parameter| binding_has_name(parameter, name, source))
            })
        {
            return true;
        }
        if parent.kind() == "statement_block"
            && named_children(parent)
                .into_iter()
                .any(|statement| declaration_has_name(statement, name, source))
        {
            return true;
        }
        if parent.kind() == "catch_clause"
            && parent
                .child_by_field_name("parameter")
                .is_some_and(|parameter| binding_has_name(parameter, name, source))
        {
            return true;
        }
        if matches!(parent.kind(), "for_statement" | "for_in_statement")
            && parent
                .child_by_field_name("initializer")
                .is_some_and(|initializer| declaration_has_name(initializer, name, source))
        {
            return true;
        }
        current = parent.parent();
    }
    false
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn call_arguments(node: Node<'_>) -> Vec<Node<'_>> {
    node.child_by_field_name("arguments")
        .map(named_children)
        .unwrap_or_default()
}

fn member_receiver_and_name(node: Node<'_>, source: &str) -> Option<(String, String)> {
    let function = node.child_by_field_name("function")?;
    if function.kind() != "member_expression" {
        return None;
    }
    let receiver = function.child_by_field_name("object")?;
    let property = function.child_by_field_name("property")?;
    if receiver.kind() != "identifier" {
        return None;
    }
    Some((
        source_text(receiver, source)?,
        source_text(property, source)?,
    ))
}

fn import_bindings(
    node: Node<'_>,
    source: &str,
    specifier: &str,
    bindings: &mut BTreeMap<String, NativeJsImportedReference>,
) {
    fn visit(
        node: Node<'_>,
        source: &str,
        specifier: &str,
        bindings: &mut BTreeMap<String, NativeJsImportedReference>,
    ) {
        if node.kind() == "import_specifier" {
            let exported = node
                .child_by_field_name("name")
                .and_then(|item| source_text(item, source));
            let local = node
                .child_by_field_name("alias")
                .and_then(|item| source_text(item, source))
                .or_else(|| exported.clone());
            if let (Some(exported_name), Some(local_name)) = (exported, local) {
                bindings.insert(
                    local_name,
                    NativeJsImportedReference {
                        specifier: specifier.to_string(),
                        exported_name,
                    },
                );
            }
        }
        for child in named_children(node) {
            visit(child, source, specifier, bindings);
        }
    }
    visit(node, source, specifier, bindings);
}

fn default_import_name(node: Node<'_>, source: &str) -> Option<String> {
    let clause = named_children(node)
        .into_iter()
        .find(|child| child.kind() == "import_clause")?;
    named_children(clause)
        .into_iter()
        .find(|child| child.kind() == "identifier")
        .and_then(|child| source_text(child, source))
}

fn collect_bindings(
    node: Node<'_>,
    source: &str,
    imports: &mut BTreeMap<String, NativeJsImportedReference>,
    cron_receivers: &mut BTreeSet<String>,
    fastify_factories: &mut BTreeSet<String>,
) {
    if node.kind() == "import_statement"
        && let Some(specifier) = import_specifier(node, source)
    {
        import_bindings(node, source, &specifier, imports);
        if specifier == "node-cron"
            && let Some(name) = default_import_name(node, source)
        {
            cron_receivers.insert(name);
        }
        if specifier == "fastify"
            && let Some(name) = default_import_name(node, source)
        {
            fastify_factories.insert(name);
        }
        for (local, imported) in imports.iter() {
            if imported.specifier == "fastify" && imported.exported_name == "fastify" {
                fastify_factories.insert(local.clone());
            }
        }
    }
    if node.kind() == "variable_declarator"
        && top_level_variable(node)
        && let Some(specifier) = commonjs_specifier(node, source)
        && let Some(pattern) = node.child_by_field_name("name")
        && pattern.kind() == "object_pattern"
    {
        for item in named_children(pattern) {
            let pair = match item.kind() {
                "pair_pattern" | "pair" => {
                    let exported = item
                        .child_by_field_name("key")
                        .and_then(|value| source_text(value, source));
                    let local = item
                        .child_by_field_name("value")
                        .and_then(|value| source_text(value, source));
                    exported.zip(local)
                }
                "shorthand_property_identifier_pattern" | "shorthand_property_identifier" => {
                    source_text(item, source).map(|name| (name.clone(), name))
                }
                _ => None,
            };
            if let Some((exported_name, local_name)) = pair {
                imports.insert(
                    local_name,
                    NativeJsImportedReference {
                        specifier: specifier.clone(),
                        exported_name,
                    },
                );
            }
        }
    }
    for child in named_children(node) {
        collect_bindings(child, source, imports, cron_receivers, fastify_factories);
    }
}

fn next_route(path: &str) -> Option<String> {
    let parts = path.split('/').collect::<Vec<_>>();
    let filename = parts.last()?;
    if filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename)
        != "route"
    {
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

fn first_parameter_name(node: Node<'_>, source: &str) -> Option<String> {
    let parameters = node.child_by_field_name("parameters")?;
    let first = named_children(parameters).into_iter().next()?;
    if first.kind() == "identifier" {
        return source_text(first, source);
    }
    first
        .child_by_field_name("pattern")
        .or_else(|| first.child_by_field_name("name"))
        .filter(|item| item.kind() == "identifier")
        .and_then(|item| source_text(item, source))
}

fn unavailable_next_contract(handler_name: &str, request_name: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": "flopeek-next-route-contract/v1",
        "adapter": "next-route-handler",
        "handlerName": handler_name,
        "request": {
            "status": "unavailable",
            "fields": [],
            "reason": if request_name.is_some() {
                "No single inline TypeScript object-literal schema was found for this handler's request.json() call."
            } else {
                "The handler has no simple identifier request parameter for parser-backed payload extraction."
            },
        },
        "responses": {
            "status": "unavailable",
            "variants": [],
            "reason": "No returned Response.json/NextResponse.json call with an object-literal body and explicit numeric status was found in this handler.",
        },
    })
}

fn valid_cron_expression(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    let fields = value.split_whitespace().collect::<Vec<_>>();
    (fields.len() == 5 || fields.len() == 6)
        && fields.iter().all(|field| {
            !field.is_empty()
                && field.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "*/?,-".contains(character)
                })
        })
}

fn is_module_scope(node: Node<'_>) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "program" {
            return true;
        }
        if matches!(
            parent.kind(),
            "function_declaration"
                | "function_expression"
                | "arrow_function"
                | "generator_function"
                | "class_declaration"
                | "class"
                | "internal_module"
        ) {
            return false;
        }
        current = parent.parent();
    }
    false
}

fn object_string_property(node: Node<'_>, source: &str, property_name: &str) -> Option<String> {
    if node.kind() != "object" {
        return None;
    }
    for child in named_children(node) {
        if child.kind() != "pair" {
            continue;
        }
        let key = child
            .child_by_field_name("key")
            .and_then(|item| source_text(item, source));
        if key.as_deref().map(|item| item.trim_matches(['\'', '"'])) != Some(property_name) {
            continue;
        }
        return child
            .child_by_field_name("value")
            .and_then(|item| string_value(item, source));
    }
    None
}

fn collect_structural(
    node: Node<'_>,
    path: &str,
    source: &str,
    bindings: &BTreeMap<String, NativeJsImportedReference>,
    cron_receivers: &BTreeSet<String>,
    fastify_receivers: &BTreeSet<String>,
    facts: &mut NativeJsStructuralFacts,
) {
    if matches!(
        node.kind(),
        "function_declaration"
            | "generator_function_declaration"
            | "method_definition"
            | "method_signature"
    ) && facts.methods.len() < 12
        && let Some(name) = node
            .child_by_field_name("name")
            .and_then(|item| source_text(item, source))
        && !facts.methods.contains(&name)
        && !name.starts_with('#')
        && name != "constructor"
    {
        facts.methods.push(name);
    }
    match node.kind() {
        "import_statement" => {
            if let Some(specifier) = import_specifier(node, source) {
                facts.imports.push(NativeJsImport {
                    specifier,
                    evidence: evidence(path, source, node),
                });
            }
        }
        "export_statement" => {
            if let Some(specifier) = import_specifier(node, source) {
                facts.imports.push(NativeJsImport {
                    specifier,
                    evidence: evidence(path, source, node),
                });
            }
        }
        "class_declaration" if is_top_level(node) => {
            if let Some(name) = identifier_for(node, source) {
                facts.symbols.push(NativeJsStructuralSymbol {
                    symbol_type: "class".to_string(),
                    name,
                    methods: class_methods(node, source),
                    evidence: evidence(path, source, exported_declaration_evidence_node(node)),
                });
            }
        }
        "function_declaration" | "generator_function_declaration" if is_top_level(node) => {
            if let Some(name) = identifier_for(node, source) {
                facts.symbols.push(NativeJsStructuralSymbol {
                    symbol_type: "function".to_string(),
                    name: name.clone(),
                    methods: Vec::new(),
                    evidence: evidence(path, source, exported_declaration_evidence_node(node)),
                });
                if matches!(name.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
                    && node
                        .parent()
                        .is_some_and(|parent| parent.kind() == "export_statement")
                    && let Some(route) = next_route(path)
                {
                    let request_name = first_parameter_name(node, source);
                    facts.endpoints.push(NativeJsEndpoint {
                        method: name.clone(),
                        route,
                        handler_name: Some(name.clone()),
                        handler_type: Some("function".to_string()),
                        contract: Some(unavailable_next_contract(&name, request_name.as_deref())),
                        evidence: evidence(path, source, exported_declaration_evidence_node(node)),
                    });
                }
            }
        }
        "variable_declarator" if top_level_variable(node) && function_like_variable(node) => {
            if let Some(name) = node
                .child_by_field_name("name")
                .and_then(|item| source_text(item, source))
            {
                facts.symbols.push(NativeJsStructuralSymbol {
                    symbol_type: "function".to_string(),
                    name,
                    methods: Vec::new(),
                    evidence: evidence(path, source, node),
                });
            }
        }
        "call_expression" => {
            let arguments = call_arguments(node);
            let function = node.child_by_field_name("function");
            if let Some(function) = function
                && function.kind() == "identifier"
            {
                if let Some(name) = source_text(function, source) {
                    if name == "require" {
                        if let Some(specifier) = arguments
                            .first()
                            .and_then(|item| string_value(*item, source))
                        {
                            facts.imports.push(NativeJsImport {
                                specifier,
                                evidence: evidence(path, source, node),
                            });
                        }
                    } else if !call_name_is_shadowed(node, &name, source) {
                        facts.calls.push(NativeJsCall {
                            imported: bindings.get(&name).cloned(),
                            source: enclosing_top_level_symbol(node, source),
                            name: name.clone(),
                            evidence: evidence(path, source, node),
                        });
                        if name == "fetch"
                            && let Some(route) = arguments
                                .first()
                                .and_then(|item| string_value(*item, source))
                            && route.starts_with('/')
                        {
                            let method = arguments
                                .get(1)
                                .and_then(|item| object_string_property(*item, source, "method"))
                                .map(|item| item.to_ascii_uppercase())
                                .filter(|item| {
                                    matches!(
                                        item.as_str(),
                                        "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
                                    )
                                })
                                .unwrap_or_else(|| "GET".to_string());
                            facts.requests.push(NativeJsRequest {
                                method,
                                route,
                                evidence: evidence(path, source, node),
                            });
                        }
                    }
                }
            }
            if let Some((receiver, method)) = member_receiver_and_name(node, source) {
                let upper = method.to_ascii_uppercase();
                if matches!(upper.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
                    && (["app", "router", "server"]
                        .contains(&receiver.to_ascii_lowercase().as_str())
                        || fastify_receivers.contains(&receiver.to_ascii_lowercase()))
                    && let Some(route) = arguments
                        .first()
                        .and_then(|item| string_value(*item, source))
                {
                    facts.endpoints.push(NativeJsEndpoint {
                        method: upper,
                        route,
                        handler_name: None,
                        handler_type: None,
                        contract: None,
                        evidence: evidence(path, source, node),
                    });
                }
                if method == "schedule" && cron_receivers.contains(&receiver) {
                    let expression = arguments
                        .first()
                        .and_then(|item| string_value(*item, source));
                    let task_name = arguments
                        .get(1)
                        .filter(|item| item.kind() == "identifier")
                        .and_then(|item| source_text(*item, source));
                    if !is_module_scope(node) {
                        facts
                            .unsupported_schedules
                            .push(NativeJsUnsupportedSchedule {
                                path: path.to_string(),
                                reason: "registration-is-not-module-scope".to_string(),
                                evidence: None,
                            });
                    } else if expression.as_deref().is_some_and(valid_cron_expression)
                        && task_name.is_some()
                    {
                        facts.schedules.push(NativeJsSchedule {
                            expression: expression.unwrap(),
                            task_name: task_name.unwrap(),
                            evidence: evidence(path, source, node),
                        });
                    } else {
                        facts
                            .unsupported_schedules
                            .push(NativeJsUnsupportedSchedule {
                                path: path.to_string(),
                                reason: if expression
                                    .as_deref()
                                    .is_none_or(|item| !valid_cron_expression(item))
                                {
                                    "non-literal-or-unsupported-cron-expression".to_string()
                                } else {
                                    "task-is-not-an-unshadowed-identifier".to_string()
                                },
                                evidence: Some(evidence(path, source, node)),
                            });
                    }
                }
            }
        }
        _ => {}
    }
    for child in named_children(node) {
        collect_structural(
            child,
            path,
            source,
            bindings,
            cron_receivers,
            fastify_receivers,
            facts,
        );
    }
}

fn typescript_tolerates_tree_sitter_error(node: Node<'_>, source: &str) -> bool {
    if node.kind() != "ERROR" {
        return false;
    }
    let text = source_text(node, source)
        .unwrap_or_default()
        .trim()
        .to_string();
    let parent = node.parent();
    // TypeScript accepts `in` as a JSX attribute name, while the JavaScript
    // grammar can recover through an ERROR node because `in` is also an
    // expression keyword. The oracle reports no parse diagnostic here.
    if text == "in=" && parent.is_some_and(|item| item.kind() == "jsx_opening_element") {
        return true;
    }
    // A bare ampersand in JSX text is accepted by TypeScript's source parser.
    // tree-sitter-javascript reports an ERROR while recovering this text.
    text.starts_with('&') && parent.is_some_and(|item| item.kind() == "jsx_element")
}

fn diagnostic_count(node: Node<'_>, source: &str) -> usize {
    usize::from(
        (node.is_error() || node.is_missing())
            && !typescript_tolerates_tree_sitter_error(node, source),
    ) + named_children(node)
        .into_iter()
        .map(|child| diagnostic_count(child, source))
        .sum::<usize>()
}

fn structural_facts(path: &str, source: &str, root: Node<'_>) -> NativeJsStructuralFacts {
    let diagnostics = diagnostic_count(root, source);
    let mut bindings = BTreeMap::new();
    let mut cron_receivers = BTreeSet::new();
    let mut fastify_factories = BTreeSet::new();
    collect_bindings(
        root,
        source,
        &mut bindings,
        &mut cron_receivers,
        &mut fastify_factories,
    );
    let mut fastify_receivers = BTreeSet::new();
    fn collect_fastify_instances(
        node: Node<'_>,
        source: &str,
        factories: &BTreeSet<String>,
        output: &mut BTreeSet<String>,
    ) {
        if node.kind() == "variable_declarator"
            && let Some(name) = node
                .child_by_field_name("name")
                .filter(|item| item.kind() == "identifier")
                .and_then(|item| source_text(item, source))
            && let Some(value) = node
                .child_by_field_name("value")
                .filter(|item| item.kind() == "call_expression")
            && let Some(function) = value
                .child_by_field_name("function")
                .filter(|item| item.kind() == "identifier")
                .and_then(|item| source_text(item, source))
            && factories.contains(&function)
        {
            output.insert(name.to_ascii_lowercase());
        }
        for child in named_children(node) {
            collect_fastify_instances(child, source, factories, output);
        }
    }
    collect_fastify_instances(root, source, &fastify_factories, &mut fastify_receivers);
    let mut facts = NativeJsStructuralFacts {
        imports: Vec::new(),
        symbols: Vec::new(),
        calls: Vec::new(),
        endpoints: Vec::new(),
        requests: Vec::new(),
        integrations: Vec::new(),
        runtime_actions: Vec::new(),
        schedules: Vec::new(),
        unsupported_schedules: Vec::new(),
        methods: Vec::new(),
        analysis: NativeJsAnalysis {
            parser: "typescript-ast".to_string(),
            status: if diagnostics > 0 {
                "parsed-with-diagnostics"
            } else {
                "parsed"
            }
            .to_string(),
            confidence: "exact".to_string(),
            diagnostics,
        },
    };
    collect_structural(
        root,
        path,
        source,
        &bindings,
        &cron_receivers,
        &fastify_receivers,
        &mut facts,
    );
    facts
}

fn collect_facts(
    node: Node<'_>,
    source: &str,
    imports: &mut BTreeSet<String>,
    symbols: &mut BTreeSet<(String, String)>,
    calls: &mut BTreeSet<String>,
) {
    match node.kind() {
        "import_statement" => {
            if let Some(specifier) = import_specifier(node, source) {
                imports.insert(specifier);
            }
        }
        "function_declaration" | "generator_function_declaration" => {
            if let Some(name) = identifier_for(node, source) {
                symbols.insert(("function".to_string(), name));
            }
        }
        "class_declaration" => {
            if let Some(name) = identifier_for(node, source) {
                symbols.insert(("class".to_string(), name));
            }
        }
        "interface_declaration" | "type_alias_declaration" | "enum_declaration" => {
            if let Some(name) = identifier_for(node, source) {
                symbols.insert(("type".to_string(), name));
            }
        }
        "variable_declarator" => {
            if let Some(specifier) = commonjs_specifier(node, source) {
                imports.insert(specifier);
            }
            let value = node.child_by_field_name("value");
            if value
                .is_some_and(|item| matches!(item.kind(), "arrow_function" | "function_expression"))
                && let Some(name) = node
                    .child_by_field_name("name")
                    .and_then(|item| source_text(item, source))
            {
                symbols.insert(("function".to_string(), name));
            }
        }
        "call_expression" => {
            if let Some(name) = direct_call_name(node, source) {
                calls.insert(name);
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_facts(child, source, imports, symbols, calls);
    }
}

pub fn parse_native_js_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let language = language_for_path(path)?;
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return None;
    }
    let tree = parser.parse(source, None)?;
    let mut imports = BTreeSet::new();
    let mut symbols = BTreeSet::new();
    let mut direct_calls = BTreeSet::new();
    collect_facts(
        tree.root_node(),
        source,
        &mut imports,
        &mut symbols,
        &mut direct_calls,
    );
    let structural = structural_facts(path, source, tree.root_node());
    Some(NativeJsFacts {
        schema_version: NATIVE_JS_FACTS_SCHEMA.to_string(),
        parser: "tree-sitter".to_string(),
        status: if structural.analysis.diagnostics > 0 {
            "parsed-with-diagnostics".to_string()
        } else {
            "parsed".to_string()
        },
        diagnostics: structural.analysis.diagnostics,
        imports: imports.into_iter().collect(),
        symbols: symbols
            .into_iter()
            .map(|(kind, name)| NativeJsSymbol { kind, name })
            .collect(),
        direct_calls: direct_calls.into_iter().collect(),
        structural,
    })
}

pub fn scan_native_js_facts(input_root: &Path) -> Result<NativeJsFactsStatus, String> {
    let inventory = scan_native_inventory_with_paths(input_root)?;
    let project_root = inventory.project_root.clone();
    let project_identity = inventory.project_identity.clone();
    let scope = read_native_scope(&project_root)?;
    let connection = open_native_store(&project_root).map_err(|error| error.to_string())?;
    let project_pk: i64 = connection
        .query_row(
            "SELECT project_pk FROM projects WHERE project_id = ?1",
            [project_identity.project_id.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT path, content_hash FROM inventory_files
                 WHERE project_pk = ?1 ORDER BY path",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map([project_pk], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|(path, _)| language_for_path(path).is_some())
            .collect::<Vec<_>>()
    };
    let mut known_records = {
        let mut statement = connection
            .prepare("SELECT path, source_scope FROM inventory_files WHERE project_pk = ?1 ORDER BY path")
            .map_err(|error| error.to_string())?;
        statement
            .query_map([project_pk], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    known_records.sort_by(|left, right| js_locale_compare(&left.0, &right.0));
    let known_paths = known_records
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<BTreeSet<_>>();
    let source_scopes = known_records.iter().cloned().collect::<BTreeMap<_, _>>();
    let record_orders = known_records
        .iter()
        .enumerate()
        .map(|(order, (path, _))| (path.clone(), order))
        .collect::<BTreeMap<_, _>>();
    let mut parsed_files = 0;
    let mut reused_files = 0;
    let mut failed_files = 0;
    let mut facts = BTreeMap::new();
    for (path, source_hash) in &candidates {
        let cached = connection
            .query_row(
                "SELECT payload_json FROM parser_facts
                 WHERE project_pk = ?1 AND path = ?2 AND source_hash = ?3 AND adapter_version = ?4",
                params![project_pk, path, source_hash, NATIVE_JS_ADAPTER_VERSION],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let fact = if let Some(payload) = cached {
            reused_files += 1;
            serde_json::from_str(&payload).map_err(|error| {
                format!("Invalid cached native JavaScript parser fact for {path}: {error}")
            })?
        } else {
            parsed_files += 1;
            let source = fs::read_to_string(project_root.join(path)).map_err(|error| {
                format!("Unable to read JavaScript/TypeScript source {path}: {error}")
            })?;
            let parsed = parse_native_js_facts(path, &source).ok_or_else(|| {
                format!("No native JavaScript/TypeScript parser is registered for {path}.")
            })?;
            connection
                .execute(
                    "DELETE FROM parser_facts
                     WHERE project_pk = ?1 AND path = ?2 AND adapter_version = ?3 AND source_hash != ?4",
                    params![project_pk, path, NATIVE_JS_ADAPTER_VERSION, source_hash],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT INTO parser_facts(project_pk, path, source_hash, adapter_version, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![project_pk, path, source_hash, NATIVE_JS_ADAPTER_VERSION, serde_json::to_string(&parsed).map_err(|error| error.to_string())?],
                )
                .map_err(|error| error.to_string())?;
            parsed
        };
        if fact.status == "parse-failed" {
            failed_files += 1;
        }
        facts.insert(path.clone(), fact);
    }
    let removed_facts = connection
        .execute(
            "DELETE FROM parser_facts
             WHERE project_pk = ?1 AND adapter_version = ?2
               AND path NOT IN (SELECT path FROM inventory_files WHERE project_pk = ?1)",
            params![project_pk, NATIVE_JS_ADAPTER_VERSION],
        )
        .map_err(|error| error.to_string())?;
    let resolution = resolve_native_js_imports(&project_root, &facts, &known_paths);
    let structural_records = build_native_js_structural_records(
        &project_root,
        &facts,
        &resolution,
        &source_scopes,
        &record_orders,
    )?;
    let entry_facts = build_native_js_entry_facts(&project_root, &facts, &structural_records);
    Ok(NativeJsFactsStatus {
        project_root,
        project_identity,
        adapter_version: NATIVE_JS_ADAPTER_VERSION.to_string(),
        parsed_files,
        reused_files,
        failed_files,
        removed_facts,
        candidate_files: inventory.candidate_files,
        candidate_paths: inventory.candidate_paths.unwrap_or_default(),
        changed_paths: inventory.changed_paths,
        reused_paths: inventory.reused_paths,
        removed_paths: inventory.removed_paths,
        source_scope_counts: inventory.source_scope_counts,
        scope_source: inventory.scope_source,
        flow_entries_tests: scope.flow_entries_tests,
        flow_entries_fixtures: scope.flow_entries_fixtures,
        facts,
        resolution,
        structural_records,
        entry_facts,
    })
}

#[cfg(test)]
mod tests {
    use super::{js_locale_compare, parse_native_js_facts, scan_native_js_facts};
    use std::fs;

    #[test]
    fn extracts_bounded_javascript_and_typescript_structural_facts() {
        let javascript = parse_native_js_facts(
            "src/orders.js",
            "import { normalize } from './normalize'; const legacy = require('./legacy'); export const submit = () => normalize(); class Order {}",
        )
        .unwrap();
        assert_eq!(javascript.imports, vec!["./legacy", "./normalize"]);
        assert!(
            javascript
                .symbols
                .iter()
                .any(|symbol| symbol.kind == "function" && symbol.name == "submit")
        );
        assert!(
            javascript
                .symbols
                .iter()
                .any(|symbol| symbol.kind == "class" && symbol.name == "Order")
        );
        assert_eq!(javascript.direct_calls, vec!["normalize"]);

        let method_calls = parse_native_js_facts(
            "src/http.ts",
            "router.post('/orders', () => response.json()); submitOrder();",
        )
        .unwrap();
        assert_eq!(method_calls.direct_calls, vec!["submitOrder"]);

        let typescript = parse_native_js_facts(
            "src/model.ts",
            "export interface Order { id: string } export function load() { return fetch('/orders'); }",
        )
        .unwrap();
        assert!(
            typescript
                .symbols
                .iter()
                .any(|symbol| symbol.kind == "type" && symbol.name == "Order")
        );
        assert!(typescript.direct_calls.contains(&"fetch".to_string()));
    }

    #[test]
    fn preserves_typescript_positions_and_jsx_diagnostic_compatibility() {
        let bom =
            parse_native_js_facts("src/client.js", "\u{feff}import axios from \"axios\";").unwrap();
        let import = &bom.structural.imports[0];
        assert_eq!(import.evidence.range.start.column, 2);
        assert_eq!(import.evidence.range.end.column, 28);

        let jsx = parse_native_js_facts(
            "src/view.jsx",
            "const View = () => <div in={value}>Password & Data Name</div>;",
        )
        .unwrap();
        assert_eq!(jsx.structural.analysis.diagnostics, 0);
        assert_eq!(jsx.structural.analysis.status, "parsed");
    }

    #[test]
    fn excludes_constructors_and_only_attributes_calls_to_function_variables() {
        let facts = parse_native_js_facts(
            "src/client.js",
            "const { publicRuntimeConfig } = getConfig(); class Client { constructor() {} run() {} }",
        )
        .unwrap();
        assert_eq!(facts.structural.calls[0].source, None);
        assert_eq!(facts.structural.symbols[0].methods, vec!["run"]);
        assert_eq!(facts.structural.methods, vec!["run"]);
    }

    #[test]
    fn matches_javascript_locale_path_order_for_ascii_paths() {
        let mut paths = vec![
            "pages/404.js",
            "pages/_document.js",
            "pages/_app.js",
            "src/content/MasterService/ContentList.js",
            "src/content/MasterService/ContentList_table_fix_filter_not.js",
            "src/content/MasterService/ContentList_multil_table_cell.js",
            "api/services/auth.service.js",
            "api/services/axios.service.js",
            "api/services/AppCheck/AppCheckService.js",
            "pages/datalake/connections/[detail].js",
            "pages/datalake/connections/create.js",
            "src/utils/firebase.js",
            "src/utils/firebase copy.js",
        ];
        paths.sort_by(|left, right| js_locale_compare(left, right));
        assert_eq!(
            paths,
            vec![
                "api/services/AppCheck/AppCheckService.js",
                "api/services/auth.service.js",
                "api/services/axios.service.js",
                "pages/_app.js",
                "pages/_document.js",
                "pages/404.js",
                "pages/datalake/connections/[detail].js",
                "pages/datalake/connections/create.js",
                "src/content/MasterService/ContentList_multil_table_cell.js",
                "src/content/MasterService/ContentList_table_fix_filter_not.js",
                "src/content/MasterService/ContentList.js",
                "src/utils/firebase copy.js",
                "src/utils/firebase.js",
            ]
        );
    }

    #[test]
    fn caches_native_javascript_facts_by_blake3_source_identity() {
        let root =
            std::env::temp_dir().join(format!("flopeek-native-js-facts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/index.ts"),
            "export const run = () => fetch('/health');\n",
        )
        .unwrap();
        let first = scan_native_js_facts(&root).unwrap();
        assert_eq!(first.parsed_files, 1);
        assert_eq!(first.reused_files, 0);
        let second = scan_native_js_facts(&root).unwrap();
        assert_eq!(second.parsed_files, 0);
        assert_eq!(second.reused_files, 1);
        assert!(
            second.facts["src/index.ts"]
                .direct_calls
                .contains(&"fetch".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }
}
