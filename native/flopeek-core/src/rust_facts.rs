//! Rust parser facts for the strict-native public source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCall, NativeJsCanonicalSymbolIdentity, NativeJsEvidence,
    NativeJsFacts, NativeJsImport, NativeJsImportedReference, NativeJsPosition, NativeJsRange,
    NativeJsStructuralFacts, NativeJsStructuralSymbol, NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::{BTreeMap, BTreeSet};
use tree_sitter::{Node, Parser};

const PARSER: &str = "tree-sitter-rust";

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

fn path_segments(node: Node<'_>, source: &str) -> Vec<String> {
    match node.kind() {
        "identifier" | "crate" | "self" | "super" => text(node, source).into_iter().collect(),
        "scoped_identifier" => {
            let mut values = node
                .child_by_field_name("path")
                .map(|node| path_segments(node, source))
                .unwrap_or_default();
            if let Some(name) = node.child_by_field_name("name") {
                values.extend(path_segments(name, source));
            }
            values
        }
        _ => Vec::new(),
    }
}

fn add_use_facts(
    node: Node<'_>,
    source: &str,
    path: &str,
    prefix: &[String],
    facts: &mut Vec<NativeJsImport>,
    bindings: &mut BTreeMap<String, NativeJsImportedReference>,
) {
    match node.kind() {
        "scoped_use_list" => {
            let mut next = prefix.to_vec();
            if let Some(base) = node.child_by_field_name("path") {
                next.extend(path_segments(base, source));
            }
            if let Some(list) = node.child_by_field_name("list") {
                for child in children(list) {
                    add_use_facts(child, source, path, &next, facts, bindings);
                }
            }
        }
        "use_list" => {
            for child in children(node) {
                add_use_facts(child, source, path, prefix, facts, bindings);
            }
        }
        "use_as_clause" => {
            let mut segments = prefix.to_vec();
            if let Some(base) = node.child_by_field_name("path") {
                segments.extend(path_segments(base, source));
            }
            let alias = node
                .child_by_field_name("alias")
                .and_then(|node| text(node, source));
            add_import(segments, alias, path, node, facts, bindings);
        }
        "use_wildcard" => {
            let mut segments = prefix.to_vec();
            if let Some(base) = children(node).into_iter().next() {
                segments.extend(path_segments(base, source));
            }
            segments.push("*".into());
            add_import(segments, None, path, node, facts, bindings);
        }
        _ => {
            let mut segments = prefix.to_vec();
            segments.extend(path_segments(node, source));
            add_import(segments, None, path, node, facts, bindings);
        }
    }
}

fn add_import(
    segments: Vec<String>,
    alias: Option<String>,
    path: &str,
    node: Node<'_>,
    facts: &mut Vec<NativeJsImport>,
    bindings: &mut BTreeMap<String, NativeJsImportedReference>,
) {
    if segments.is_empty() {
        return;
    }
    let standard = matches!(
        segments.first().map(String::as_str),
        Some("std" | "core" | "alloc")
    );
    let specifier = segments.join("::");
    let exported_name = segments.last().cloned().unwrap_or_default();
    if exported_name != "*" {
        bindings.insert(
            alias.unwrap_or_else(|| exported_name.clone()),
            NativeJsImportedReference {
                specifier: specifier.clone(),
                exported_name,
            },
        );
    }
    facts.push(NativeJsImport {
        specifier,
        standard: standard.then_some(true),
        evidence: evidence(path, node),
    });
}

fn declaration_name(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .and_then(|node| text(node, source))
}

fn declaration_methods(node: Node<'_>, source: &str) -> Vec<String> {
    node.child_by_field_name("body")
        .map(children)
        .unwrap_or_default()
        .into_iter()
        .filter(|node| matches!(node.kind(), "function_item" | "function_signature_item"))
        .filter_map(|node| declaration_name(node, source))
        .collect()
}

fn function_signature(node: Node<'_>, source: &str) -> String {
    let parameters = node
        .child_by_field_name("parameters")
        .map(children)
        .unwrap_or_default()
        .into_iter()
        .filter(|parameter| parameter.kind() == "parameter")
        .map(|parameter| {
            parameter
                .child_by_field_name("type")
                .and_then(|kind| text(kind, source))
                .map(|kind| {
                    kind.chars()
                        .filter(|value| !value.is_whitespace())
                        .collect()
                })
                .unwrap_or_else(|| "unknown".to_string())
        })
        .collect::<Vec<_>>()
        .join(",");
    let result = node
        .child_by_field_name("return_type")
        .and_then(|kind| text(kind, source))
        .map(|kind| {
            kind.chars()
                .filter(|value| !value.is_whitespace())
                .collect()
        })
        .unwrap_or_else(|| "()".to_string());
    format!("({parameters}):{result}")
}

fn impl_type_name(node: Node<'_>, source: &str) -> Option<String> {
    let ty = node.child_by_field_name("type")?;
    if ty.kind() == "type_identifier" {
        return text(ty, source);
    }
    let mut cursor = ty.walk();
    ty.named_children(&mut cursor)
        .find(|child| child.kind() == "type_identifier")
        .and_then(|child| text(child, source))
}

fn diagnostics(node: Node<'_>) -> usize {
    usize::from(node.is_error() || node.is_missing())
        + children(node).into_iter().map(diagnostics).sum::<usize>()
}

fn collect_calls(
    node: Node<'_>,
    path: &str,
    source: &str,
    owner: Option<&NativeJsSymbolReference>,
    local_functions: &BTreeSet<String>,
    imported: &BTreeMap<String, NativeJsImportedReference>,
    facts: &mut Vec<NativeJsCall>,
) {
    if node.kind() == "closure_expression" {
        return;
    }
    if node.kind() == "call_expression" {
        let name = node
            .child_by_field_name("function")
            .filter(|node| node.kind() == "identifier")
            .and_then(|node| text(node, source));
        if let Some(name) = name {
            let imported = imported.get(&name).cloned();
            if local_functions.contains(&name) || imported.is_some() {
                facts.push(NativeJsCall {
                    name,
                    source: owner.cloned(),
                    imported,
                    evidence: evidence(path, node),
                });
            }
        }
    }
    for child in children(node) {
        collect_calls(child, path, source, owner, local_functions, imported, facts);
    }
}

pub fn parse_native_rust_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let diagnostic_count = diagnostics(root);
    let mut structural = NativeJsStructuralFacts {
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
        analysis: NativeJsAnalysis {
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
        },
    };
    let mut bindings = BTreeMap::new();
    for declaration in children(root)
        .into_iter()
        .filter(|node| node.kind() == "use_declaration")
    {
        if let Some(argument) = declaration.child_by_field_name("argument") {
            add_use_facts(
                argument,
                source,
                path,
                &[],
                &mut structural.imports,
                &mut bindings,
            );
        }
    }
    let mut classes = BTreeMap::<String, NativeJsStructuralSymbol>::new();
    for declaration in children(root).into_iter().filter(|node| {
        matches!(
            node.kind(),
            "struct_item" | "enum_item" | "trait_item" | "union_item"
        )
    }) {
        if let Some(name) = declaration_name(declaration, source) {
            classes.insert(
                name.clone(),
                NativeJsStructuralSymbol {
                    symbol_type: "class".into(),
                    name: name.clone(),
                    methods: declaration_methods(declaration, source),
                    evidence: evidence(path, declaration),
                    identity: Some(NativeJsCanonicalSymbolIdentity {
                        qualified_name: name,
                        lexical_owner: None,
                        signature: None,
                        discriminator: "type".into(),
                    }),
                },
            );
        }
    }
    let mut canonical_methods = Vec::new();
    for implementation in children(root)
        .into_iter()
        .filter(|node| node.kind() == "impl_item")
    {
        if let Some(name) = impl_type_name(implementation, source)
            && let Some(symbol) = classes.get_mut(&name)
        {
            let owner = NativeJsSymbolReference {
                symbol_type: "class".into(),
                name: name.clone(),
            };
            for method in implementation
                .child_by_field_name("body")
                .map(children)
                .unwrap_or_default()
                .into_iter()
                .filter(|node| matches!(node.kind(), "function_item" | "function_signature_item"))
            {
                if let Some(method_name) = declaration_name(method, source) {
                    if !symbol.methods.contains(&method_name) {
                        symbol.methods.push(method_name.clone());
                    }
                    canonical_methods.push(NativeJsStructuralSymbol {
                        symbol_type: "method".into(),
                        name: method_name.clone(),
                        methods: vec![],
                        evidence: evidence(path, method),
                        identity: Some(NativeJsCanonicalSymbolIdentity {
                            qualified_name: format!("{name}.{method_name}"),
                            lexical_owner: Some(owner.clone()),
                            signature: Some(function_signature(method, source)),
                            discriminator: "instance-method".into(),
                        }),
                    });
                }
            }
        }
    }
    let class_names = classes.keys().cloned().collect::<BTreeSet<_>>();
    structural.symbols.extend(classes.into_values());
    structural
        .canonical_symbols
        .extend(structural.symbols.iter().cloned());
    structural.canonical_symbols.extend(canonical_methods);
    let functions = children(root)
        .into_iter()
        .filter(|node| node.kind() == "function_item")
        .collect::<Vec<_>>();
    let local_functions = functions
        .iter()
        .filter_map(|node| declaration_name(*node, source))
        .collect::<BTreeSet<_>>();
    for function in &functions {
        if let Some(name) = declaration_name(*function, source) {
            let symbol = NativeJsStructuralSymbol {
                symbol_type: "function".into(),
                name: name.clone(),
                methods: vec![],
                evidence: evidence(path, *function),
                identity: Some(NativeJsCanonicalSymbolIdentity {
                    qualified_name: name,
                    lexical_owner: None,
                    signature: Some(function_signature(*function, source)),
                    discriminator: "top-level-function".into(),
                }),
            };
            structural.symbols.push(symbol.clone());
            structural.canonical_symbols.push(symbol);
        }
    }
    let mut seen_methods = BTreeSet::new();
    structural.methods = structural
        .symbols
        .iter()
        .filter(|symbol| symbol.symbol_type == "class")
        .flat_map(|symbol| symbol.methods.iter().cloned())
        .filter(|method| seen_methods.insert(method.clone()))
        .take(12)
        .collect();
    for function in &functions {
        if let (Some(name), Some(body)) = (
            declaration_name(*function, source),
            function.child_by_field_name("body"),
        ) {
            let owner = NativeJsSymbolReference {
                symbol_type: "function".into(),
                name,
            };
            collect_calls(
                body,
                path,
                source,
                Some(&owner),
                &local_functions,
                &bindings,
                &mut structural.calls,
            );
        }
    }
    for implementation in children(root)
        .into_iter()
        .filter(|node| node.kind() == "impl_item")
    {
        if let (Some(name), Some(body)) = (
            impl_type_name(implementation, source),
            implementation.child_by_field_name("body"),
        ) && class_names.contains(&name)
        {
            let owner = NativeJsSymbolReference {
                symbol_type: "class".into(),
                name,
            };
            for method in children(body)
                .into_iter()
                .filter(|node| node.kind() == "function_item")
            {
                if let Some(method_body) = method.child_by_field_name("body") {
                    collect_calls(
                        method_body,
                        path,
                        source,
                        Some(&owner),
                        &local_functions,
                        &bindings,
                        &mut structural.calls,
                    );
                }
            }
        }
    }
    let direct_calls = structural
        .calls
        .iter()
        .map(|call| call.name.clone())
        .collect::<BTreeSet<_>>();
    let symbols = structural
        .symbols
        .iter()
        .map(|symbol| NativeJsSymbol {
            kind: symbol.symbol_type.clone(),
            name: symbol.name.clone(),
        })
        .collect();
    Some(NativeJsFacts {
        schema_version: crate::js_facts::NATIVE_JS_FACTS_SCHEMA.into(),
        parser: "tree-sitter-rust".into(),
        status: structural.analysis.status.clone(),
        diagnostics: diagnostic_count,
        imports: structural
            .imports
            .iter()
            .map(|item| item.specifier.clone())
            .collect(),
        symbols,
        direct_calls: direct_calls.into_iter().collect(),
        structural,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_native_rust_facts;

    #[test]
    fn preserves_standard_imports_method_order_and_declared_impl_call_owners() {
        let facts = parse_native_rust_facts(
            "src/lib.rs",
            "use std::fmt::Debug;\ntrait Local { fn zebra(&self); fn alpha(&self); }\nfn helper() {}\nimpl Foreign { fn run() { helper(); } }\nimpl Local { fn run() { helper(); } }\n",
        )
        .unwrap();
        assert_eq!(facts.structural.imports[0].specifier, "std::fmt::Debug");
        assert_eq!(facts.structural.imports[0].standard, Some(true));
        assert_eq!(facts.structural.methods, ["zebra", "alpha", "run"]);
        assert_eq!(facts.structural.calls.len(), 1);
        assert_eq!(
            facts.structural.calls[0]
                .source
                .as_ref()
                .map(|source| source.name.as_str()),
            Some("Local")
        );
    }
}
