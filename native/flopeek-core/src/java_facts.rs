//! Java parser facts for the strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCall, NativeJsEvidence, NativeJsFacts, NativeJsImport,
    NativeJsPosition, NativeJsRange, NativeJsStructuralFacts, NativeJsStructuralSymbol,
    NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::{BTreeMap, BTreeSet};
use tree_sitter::{Node, Parser};

const PARSER: &str = "tree-sitter-java";

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

fn diagnostics(node: Node<'_>) -> usize {
    usize::from(node.is_error() || node.is_missing())
        + children(node).into_iter().map(diagnostics).sum::<usize>()
}

fn type_body(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("body").or_else(|| {
        children(node)
            .into_iter()
            .find(|child| child.kind().ends_with("_body"))
    })
}

fn method_is_static(node: Node<'_>, source: &str) -> bool {
    children(node).into_iter().any(|child| {
        child.kind() == "modifiers"
            && text(child, source).is_some_and(|modifiers| {
                modifiers.split_whitespace().any(|value| value == "static")
            })
    })
}

fn methods<'a>(node: Node<'a>, source: &str) -> Vec<(Node<'a>, String, bool)> {
    type_body(node)
        .map(children)
        .unwrap_or_default()
        .into_iter()
        .filter(|child| child.kind() == "method_declaration")
        .filter_map(|method| {
            method
                .child_by_field_name("name")
                .and_then(|name| text(name, source))
                .map(|name| (method, name, method_is_static(method, source)))
        })
        .collect()
}

struct JavaCallContext<'a> {
    path: &'a str,
    source: &'a str,
    owner: &'a NativeJsSymbolReference,
    type_name: &'a str,
    static_names: &'a BTreeSet<String>,
}

fn collect_calls(
    node: Node<'_>,
    method: Node<'_>,
    context: &JavaCallContext<'_>,
    calls: &mut Vec<NativeJsCall>,
) {
    if node.id() != method.id()
        && matches!(
            node.kind(),
            "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "record_declaration"
                | "annotation_type_declaration"
                | "lambda_expression"
        )
    {
        return;
    }
    if node.kind() == "method_invocation" && node.child_by_field_name("object").is_none() {
        if let Some(name) = node
            .child_by_field_name("name")
            .and_then(|name| text(name, context.source))
        {
            if context.static_names.contains(&name) {
                calls.push(NativeJsCall {
                    name: format!("{}.{name}", context.type_name),
                    source: Some(context.owner.clone()),
                    imported: None,
                    evidence: evidence(context.path, node),
                });
            }
        }
    }
    for child in children(node) {
        collect_calls(child, method, context, calls);
    }
}

pub fn parse_native_java_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let diagnostic_count = diagnostics(root);
    let mut structural = NativeJsStructuralFacts {
        imports: vec![],
        symbols: vec![],
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
    for declaration in children(root)
        .into_iter()
        .filter(|node| node.kind() == "import_declaration")
    {
        if let Some(import) = children(declaration)
            .into_iter()
            .find(|child| matches!(child.kind(), "identifier" | "scoped_identifier"))
            && let Some(specifier) = text(import, source)
        {
            structural.imports.push(NativeJsImport {
                specifier,
                evidence: evidence(path, import),
            });
        }
    }
    let type_kinds = [
        "class_declaration",
        "interface_declaration",
        "enum_declaration",
        "record_declaration",
        "annotation_type_declaration",
    ];
    for declaration in children(root)
        .into_iter()
        .filter(|node| type_kinds.contains(&node.kind()))
    {
        let Some(type_name) = declaration
            .child_by_field_name("name")
            .and_then(|name| text(name, source))
        else {
            continue;
        };
        let method_details = methods(declaration, source);
        structural.symbols.push(NativeJsStructuralSymbol {
            symbol_type: "class".into(),
            name: type_name.clone(),
            methods: method_details
                .iter()
                .map(|(_, name, _)| name.clone())
                .collect(),
            evidence: evidence(path, declaration),
        });
        let mut static_counts = BTreeMap::<String, usize>::new();
        for (_, name, is_static) in &method_details {
            if *is_static {
                *static_counts.entry(name.clone()).or_default() += 1;
            }
        }
        let unique_static = method_details
            .into_iter()
            .filter(|(_, name, is_static)| *is_static && static_counts.get(name) == Some(&1))
            .collect::<Vec<_>>();
        let static_names = unique_static
            .iter()
            .map(|(_, name, _)| name.clone())
            .collect::<BTreeSet<_>>();
        for (method, name, _) in unique_static {
            let qualified_name = format!("{type_name}.{name}");
            let owner = NativeJsSymbolReference {
                symbol_type: "function".into(),
                name: qualified_name.clone(),
            };
            structural.symbols.push(NativeJsStructuralSymbol {
                symbol_type: "function".into(),
                name: qualified_name,
                methods: vec![],
                evidence: evidence(path, method),
            });
            if let Some(body) = method.child_by_field_name("body") {
                let context = JavaCallContext {
                    path,
                    source,
                    owner: &owner,
                    type_name: &type_name,
                    static_names: &static_names,
                };
                collect_calls(body, method, &context, &mut structural.calls);
            }
        }
    }
    structural.methods = structural
        .symbols
        .iter()
        .filter(|symbol| symbol.symbol_type == "class")
        .flat_map(|symbol| symbol.methods.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(12)
        .collect();
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
        parser: PARSER.into(),
        status: structural.analysis.status.clone(),
        diagnostics: diagnostic_count,
        imports: structural
            .imports
            .iter()
            .map(|import| import.specifier.clone())
            .collect(),
        symbols,
        direct_calls: direct_calls.into_iter().collect(),
        structural,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_native_java_facts;

    #[test]
    fn preserves_java_types_unique_static_methods_and_calls() {
        let facts = parse_native_java_facts("src/Orders.java", "class Orders { static boolean submit() { return validate(); } static boolean validate() { return true; } void helper() {} }").unwrap();
        assert_eq!(facts.parser, "tree-sitter-java");
        assert_eq!(
            facts.structural.symbols[0].methods,
            ["submit", "validate", "helper"]
        );
        assert_eq!(facts.structural.calls[0].name, "Orders.validate");
    }
}
