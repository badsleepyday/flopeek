//! Go structural facts for strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCall, NativeJsCanonicalSymbolIdentity, NativeJsEvidence,
    NativeJsFacts, NativeJsImport, NativeJsImportedReference, NativeJsPosition, NativeJsRange,
    NativeJsStructuralFacts, NativeJsStructuralSymbol, NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use tree_sitter::{Node, Parser};

const PARSER: &str = "go-parser";

fn children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn text(node: Node<'_>, source: &str) -> Option<String> {
    node.utf8_text(source.as_bytes()).ok().map(str::to_owned)
}

fn evidence(path: &str, node: Node<'_>) -> NativeJsEvidence {
    let start = node.start_position();
    let end = node.end_position();
    NativeJsEvidence {
        parser: PARSER.into(),
        file: path.into(),
        range: NativeJsRange {
            start: NativeJsPosition {
                line: start.row + 1,
                column: start.column + 1,
            },
            end: NativeJsPosition {
                line: end.row + 1,
                column: end.column + 1,
            },
        },
    }
}

fn diagnostic_nodes(node: Node<'_>) -> usize {
    usize::from(node.is_error() || node.is_missing())
        + children(node)
            .into_iter()
            .map(diagnostic_nodes)
            .sum::<usize>()
}

fn unquote_go_string(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    match (bytes[0], bytes[bytes.len() - 1]) {
        (b'"', b'"') | (b'`', b'`') => Some(value[1..value.len() - 1].to_string()),
        _ => None,
    }
}

fn standard_import(specifier: &str) -> bool {
    static CATALOG: OnceLock<BTreeSet<String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let catalog: serde_json::Value =
                serde_json::from_str(include_str!("../../../contracts/go-stdlib-catalog.json"))
                    .expect("committed Go stdlib catalog must be valid JSON");
            assert_eq!(
                catalog["schemaVersion"], "flopeek-go-stdlib-catalog/v1",
                "committed Go stdlib catalog schema drifted"
            );
            assert_eq!(
                catalog["goVersion"], "go1.26.4",
                "Go stdlib catalog version must remain bound to the adapter version"
            );
            assert_eq!(
                catalog["targets"],
                serde_json::json!([
                    "darwin/amd64",
                    "darwin/arm64",
                    "linux/amd64",
                    "linux/arm64",
                    "windows/amd64",
                    "windows/arm64"
                ]),
                "Go stdlib catalog targets must match supported native packages"
            );
            let packages = catalog["packages"]
                .as_array()
                .expect("Go stdlib catalog packages must be an array");
            let unique = packages
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .expect("Go stdlib catalog entries must be strings")
                        .to_string()
                })
                .collect::<BTreeSet<_>>();
            assert_eq!(
                unique.len(),
                packages.len(),
                "Go stdlib catalog packages must be unique"
            );
            assert!(unique.contains("C"), "Go stdlib catalog must contain cgo C");
            unique
        })
        .contains(specifier)
}

fn declaration_name(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .and_then(|child| text(child, source))
}

fn receiver_type_name(node: Node<'_>, source: &str) -> Option<String> {
    let receiver = node.child_by_field_name("receiver")?;
    let mut stack = vec![receiver];
    while let Some(current) = stack.pop() {
        if current.kind() == "type_identifier" {
            return text(current, source);
        }
        stack.extend(children(current).into_iter().rev());
    }
    None
}

fn function_symbol_name(node: Node<'_>, source: &str) -> Option<String> {
    let name = declaration_name(node, source)?;
    Some(
        receiver_type_name(node, source)
            .map(|receiver| format!("{receiver}.{name}"))
            .unwrap_or(name),
    )
}

fn function_signature(node: Node<'_>, source: &str) -> String {
    let parameters = node
        .child_by_field_name("parameters")
        .and_then(|value| text(value, source))
        .map(|value| {
            value
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
        })
        .unwrap_or_else(|| "()".to_string());
    let result = node
        .child_by_field_name("result")
        .and_then(|value| text(value, source))
        .map(|value| {
            value
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
        })
        .unwrap_or_default();
    format!("{parameters}:{result}")
}

fn import_path_node(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("path").or_else(|| {
        children(node).into_iter().find(|child| {
            matches!(
                child.kind(),
                "interpreted_string_literal" | "raw_string_literal"
            )
        })
    })
}

fn import_binding(node: Node<'_>, specifier: &str, source: &str) -> Option<String> {
    let explicit = node
        .child_by_field_name("name")
        .and_then(|child| text(child, source));
    match explicit.as_deref() {
        Some("." | "_") => None,
        Some(name) if !name.is_empty() => Some(name.to_string()),
        _ => specifier.rsplit('/').next().map(str::to_string),
    }
}

fn direct_identifier_names(node: Node<'_>, source: &str, names: &mut BTreeSet<String>) {
    if node.kind() == "identifier" {
        if let Some(name) = text(node, source) {
            names.insert(name);
        }
        return;
    }
    for child in children(node) {
        if child.kind() == "identifier"
            && let Some(name) = text(child, source)
        {
            names.insert(name);
        }
    }
}

fn parameter_names(node: Node<'_>, source: &str, names: &mut BTreeSet<String>) {
    if matches!(
        node.kind(),
        "parameter_declaration" | "variadic_parameter_declaration"
    ) {
        direct_identifier_names(node, source, names);
        return;
    }
    if matches!(node.kind(), "parameter_list" | "receiver") {
        for child in children(node) {
            parameter_names(child, source, names);
        }
    }
}

fn function_bound_names(node: Node<'_>, source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for field in ["receiver", "parameters", "result"] {
        if let Some(value) = node.child_by_field_name(field) {
            parameter_names(value, source, &mut names);
        }
    }
    let Some(body) = node.child_by_field_name("body") else {
        return names;
    };
    let mut stack = vec![body];
    while let Some(current) = stack.pop() {
        if current.kind() == "func_literal" {
            continue;
        }
        if matches!(
            current.kind(),
            "assignment_statement"
                | "short_var_declaration"
                | "var_spec"
                | "const_spec"
                | "range_clause"
                | "receive_statement"
        ) {
            if let Some(left) = current
                .child_by_field_name("left")
                .or_else(|| current.child_by_field_name("name"))
            {
                direct_identifier_names(left, source, &mut names);
            }
        }
        if let Some(alias) = current.child_by_field_name("alias") {
            direct_identifier_names(alias, source, &mut names);
        }
        stack.extend(children(current));
    }
    names
}

fn function_calls(
    path: &str,
    node: Node<'_>,
    source: &str,
    top_level_functions: &BTreeSet<String>,
    imports: &BTreeMap<String, String>,
) -> Vec<NativeJsCall> {
    let Some(source_name) = function_symbol_name(node, source) else {
        return Vec::new();
    };
    let source_reference = NativeJsSymbolReference {
        symbol_type: "function".into(),
        name: source_name,
    };
    let bound = function_bound_names(node, source);
    let Some(body) = node.child_by_field_name("body") else {
        return Vec::new();
    };
    let mut calls = Vec::new();
    let mut stack = vec![body];
    while let Some(current) = stack.pop() {
        if current.kind() == "func_literal" {
            continue;
        }
        if current.kind() == "call_expression" {
            if let Some(function) = current
                .child_by_field_name("function")
                .or_else(|| children(current).into_iter().next())
            {
                if function.kind() == "identifier" {
                    if let Some(name) = text(function, source)
                        && top_level_functions.contains(&name)
                        && !bound.contains(&name)
                    {
                        calls.push(NativeJsCall {
                            name,
                            source: Some(source_reference.clone()),
                            imported: None,
                            evidence: evidence(path, current),
                        });
                    }
                } else if function.kind() == "selector_expression" {
                    let operand = function
                        .child_by_field_name("operand")
                        .or_else(|| children(function).into_iter().next());
                    let field = function
                        .child_by_field_name("field")
                        .or_else(|| children(function).into_iter().last());
                    if let (Some(operand), Some(field)) = (operand, field)
                        && operand.kind() == "identifier"
                        && let (Some(binding), Some(name)) =
                            (text(operand, source), text(field, source))
                        && !bound.contains(&binding)
                        && let Some(specifier) = imports.get(&binding)
                    {
                        calls.push(NativeJsCall {
                            name: name.clone(),
                            source: Some(source_reference.clone()),
                            imported: Some(NativeJsImportedReference {
                                specifier: specifier.clone(),
                                exported_name: name,
                            }),
                            evidence: evidence(path, current),
                        });
                    }
                }
            }
        }
        stack.extend(children(current).into_iter().rev());
    }
    calls.sort_by_key(|call| {
        (
            call.evidence.range.start.line,
            call.evidence.range.start.column,
        )
    });
    calls
}

fn malformed_facts() -> NativeJsFacts {
    let analysis = NativeJsAnalysis {
        parser: PARSER.into(),
        status: "parsed-with-diagnostics".into(),
        confidence: "exact".into(),
        diagnostics: 1,
        reason: Some("go-parser-reported-syntax-errors".into()),
    };
    NativeJsFacts {
        schema_version: crate::js_facts::NATIVE_JS_FACTS_SCHEMA.into(),
        parser: PARSER.into(),
        status: analysis.status.clone(),
        diagnostics: 1,
        imports: vec![],
        symbols: vec![],
        direct_calls: vec![],
        structural: NativeJsStructuralFacts {
            imports: vec![],
            symbols: vec![],
            canonical_symbols: vec![],
            calls: vec![],
            endpoints: vec![],
            requests: vec![],
            integrations: vec![],
            framework_commands: vec![],
            unsupported_framework_commands: vec![],
            runtime_actions: vec![],
            schedules: vec![],
            unsupported_schedules: vec![],
            methods: vec![],
            analysis,
        },
    }
}

pub fn parse_native_go_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_go::LANGUAGE.into()).ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let diagnostic_count = usize::from(diagnostic_nodes(root) > 0);
    if diagnostic_count > 0 {
        return Some(malformed_facts());
    }
    let mut imports = Vec::new();
    let mut import_bindings = BTreeMap::new();
    let mut symbols = Vec::new();
    let mut methods_by_type = BTreeMap::<String, Vec<String>>::new();
    let mut top_level_functions = BTreeSet::new();
    let declarations = children(root);

    let mut import_nodes = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "import_spec" {
            import_nodes.push(node);
            continue;
        }
        if node.kind() == "import_declaration" && import_path_node(node).is_some() {
            import_nodes.push(node);
            continue;
        }
        stack.extend(children(node));
    }
    import_nodes.sort_by_key(|node| (node.start_position().row, node.start_position().column));
    for node in import_nodes {
        let Some(path_node) = import_path_node(node) else {
            continue;
        };
        let Some(specifier) = text(path_node, source).and_then(|value| unquote_go_string(&value))
        else {
            continue;
        };
        if let Some(binding) = import_binding(node, &specifier, source) {
            import_bindings.insert(binding, specifier.clone());
        }
        imports.push(NativeJsImport {
            standard: Some(standard_import(&specifier)),
            specifier,
            evidence: evidence(path, node),
        });
    }

    for declaration in &declarations {
        if declaration.kind() == "type_declaration" {
            for spec in children(*declaration)
                .into_iter()
                .filter(|node| node.kind() == "type_spec")
            {
                let kind = spec
                    .child_by_field_name("type")
                    .map(|node| node.kind())
                    .unwrap_or_default();
                if matches!(kind, "struct_type" | "interface_type")
                    && let Some(name) = declaration_name(spec, source)
                {
                    symbols.push(NativeJsStructuralSymbol {
                        symbol_type: "class".into(),
                        name: name.clone(),
                        methods: Vec::new(),
                        evidence: evidence(path, spec),
                        identity: Some(NativeJsCanonicalSymbolIdentity {
                            qualified_name: name,
                            lexical_owner: None,
                            signature: None,
                            discriminator: "type".into(),
                        }),
                    });
                }
            }
        } else if matches!(
            declaration.kind(),
            "function_declaration" | "method_declaration"
        ) && let Some(name) = function_symbol_name(*declaration, source)
        {
            if declaration.kind() == "function_declaration" {
                top_level_functions.insert(name.clone());
            } else if let (Some(receiver), Some(method)) = (
                receiver_type_name(*declaration, source),
                declaration_name(*declaration, source),
            ) {
                methods_by_type.entry(receiver).or_default().push(method);
            }
            let receiver = receiver_type_name(*declaration, source);
            symbols.push(NativeJsStructuralSymbol {
                symbol_type: "function".into(),
                name: name.clone(),
                methods: Vec::new(),
                evidence: evidence(path, *declaration),
                identity: Some(NativeJsCanonicalSymbolIdentity {
                    qualified_name: name,
                    lexical_owner: receiver.as_ref().map(|owner| NativeJsSymbolReference {
                        symbol_type: "class".into(),
                        name: owner.clone(),
                    }),
                    signature: Some(function_signature(*declaration, source)),
                    discriminator: if receiver.is_some() {
                        "instance-method"
                    } else {
                        "top-level-function"
                    }
                    .into(),
                }),
            });
        }
    }
    for symbol in &mut symbols {
        if symbol.symbol_type == "class"
            && let Some(methods) = methods_by_type.get(&symbol.name)
        {
            symbol.methods = methods.clone();
        }
    }
    let canonical_symbols = symbols.clone();
    let calls = declarations
        .iter()
        .filter(|node| matches!(node.kind(), "function_declaration" | "method_declaration"))
        .flat_map(|node| {
            function_calls(path, *node, source, &top_level_functions, &import_bindings)
        })
        .collect::<Vec<_>>();
    let mut seen_methods = BTreeSet::new();
    let methods = declarations
        .iter()
        .filter(|node| matches!(node.kind(), "function_declaration" | "method_declaration"))
        .filter_map(|node| declaration_name(*node, source))
        .filter(|method| seen_methods.insert(method.clone()))
        .take(12)
        .collect::<Vec<_>>();
    let analysis = NativeJsAnalysis {
        parser: PARSER.into(),
        status: if diagnostic_count > 0 {
            "parsed-with-diagnostics"
        } else {
            "parsed"
        }
        .into(),
        confidence: "exact".into(),
        diagnostics: diagnostic_count,
        reason: None,
    };
    let structural = NativeJsStructuralFacts {
        imports: imports.clone(),
        symbols: symbols.clone(),
        canonical_symbols,
        calls: calls.clone(),
        endpoints: vec![],
        requests: vec![],
        integrations: vec![],
        framework_commands: vec![],
        unsupported_framework_commands: vec![],
        runtime_actions: vec![],
        schedules: vec![],
        unsupported_schedules: vec![],
        methods,
        analysis: analysis.clone(),
    };
    Some(NativeJsFacts {
        schema_version: crate::js_facts::NATIVE_JS_FACTS_SCHEMA.into(),
        parser: PARSER.into(),
        status: analysis.status,
        diagnostics: diagnostic_count,
        imports: imports.into_iter().map(|item| item.specifier).collect(),
        symbols: symbols
            .into_iter()
            .map(|symbol| NativeJsSymbol {
                kind: symbol.symbol_type,
                name: symbol.name,
            })
            .collect(),
        direct_calls: calls.into_iter().map(|call| call.name).collect(),
        structural,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_native_go_facts;

    #[test]
    fn extracts_types_methods_imports_and_unshadowed_calls() {
        let facts = parse_native_go_facts(
            "cmd/server.go",
            r#"package main
import clock "example.com/acme/clock"
import "net/http"
type Server struct{}
func validate() {}
func Boot() { validate(); clock.Now() }
func Shadowed(validate func()) { validate() }
func (server *Server) Run() { validate(); http.ListenAndServe("", nil) }
"#,
        )
        .expect("Go files have a bundled native parser");
        assert_eq!(facts.parser, "go-parser");
        assert_eq!(facts.structural.imports.len(), 2);
        assert_eq!(facts.structural.imports[1].standard, Some(true));
        assert_eq!(facts.structural.symbols[0].name, "Server");
        assert_eq!(facts.structural.symbols[0].methods, ["Run"]);
        assert_eq!(
            facts
                .structural
                .calls
                .iter()
                .map(|call| call.name.as_str())
                .collect::<Vec<_>>(),
            ["validate", "Now", "validate", "ListenAndServe"]
        );
        assert_eq!(
            facts
                .structural
                .calls
                .iter()
                .filter(|call| call
                    .source
                    .as_ref()
                    .is_some_and(|source| source.name == "Shadowed"))
                .count(),
            0
        );
    }

    #[test]
    fn type_qualifiers_and_generic_constraints_do_not_shadow_import_bindings() {
        let facts = parse_native_go_facts(
            "runner.go",
            r#"package runner
import pkg "example.com/project/pkg"
func Typed(value pkg.Type) { pkg.Do() }
func Generic[T pkg.Constraint](value T) { pkg.Generic() }
func Shadowed(pkg pkg.Type) { pkg.Do() }
"#,
        )
        .expect("Go files have a bundled native parser");
        let calls = facts
            .structural
            .calls
            .iter()
            .map(|call| {
                (
                    call.source.as_ref().map(|source| source.name.as_str()),
                    call.name.as_str(),
                )
            })
            .collect::<Vec<_>>();
        assert!(calls.contains(&(Some("Typed"), "Do")));
        assert!(calls.contains(&(Some("Generic"), "Generic")));
        assert!(!calls.contains(&(Some("Shadowed"), "Do")));
    }

    #[test]
    fn diagnostics_are_normalized_and_stdlib_uses_the_versioned_catalog() {
        let malformed =
            parse_native_go_facts("broken.go", "package broken\nfunc A( {\nfunc B( {\n")
                .expect("malformed Go still yields bounded parser facts");
        assert_eq!(malformed.diagnostics, 1);
        assert_eq!(malformed.structural.analysis.diagnostics, 1);
        assert_eq!(
            malformed.structural.analysis.status,
            "parsed-with-diagnostics"
        );

        let imports = parse_native_go_facts(
            "catalog.go",
            "package catalog\nimport \"unique\"\nimport \"example.com/unique\"\n",
        )
        .expect("catalog fixture parses");
        assert_eq!(imports.structural.imports[0].standard, Some(true));
        assert_eq!(imports.structural.imports[1].standard, Some(false));
    }
}
