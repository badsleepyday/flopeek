//! Java parser facts for the strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCall, NativeJsCanonicalSymbolIdentity, NativeJsEvidence,
    NativeJsFacts, NativeJsImport, NativeJsPosition, NativeJsRange, NativeJsStructuralFacts,
    NativeJsStructuralSymbol, NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::{BTreeSet, HashMap, HashSet};
use tree_sitter::{Node, Parser};

const PARSER: &str = "tree-sitter-java";

fn text(node: Node<'_>, source: &str) -> Option<String> {
    node.utf8_text(source.as_bytes()).ok().map(str::to_owned)
}

fn text_ref<'a>(node: Node<'_>, source: &'a str) -> Option<&'a str> {
    node.utf8_text(source.as_bytes()).ok()
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
    if !node.has_error() {
        return 0;
    }
    // Walk the tree with one reusable stack.  Building a temporary `Vec` for
    // every AST node made diagnostics checking dominate cold Java scans on
    // large repositories even though the result is only a count of recovery
    // nodes.
    let mut count = 0;
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        count += usize::from(current.is_error() || current.is_missing());
        let mut cursor = current.walk();
        stack.extend(current.named_children(&mut cursor));
    }
    count
}

fn type_body(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("body").or_else(|| {
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .find(|child| child.kind().ends_with("_body"))
    })
}

fn method_is_static(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).any(|child| {
        child.kind() == "modifiers"
            && text_ref(child, source).is_some_and(|modifiers| {
                modifiers.split_whitespace().any(|value| value == "static")
            })
    })
}

struct JavaMethod<'a> {
    node: Node<'a>,
    name: String,
    is_static: bool,
    signature: String,
}

fn methods<'a>(node: Node<'a>, source: &str) -> Vec<JavaMethod<'a>> {
    let Some(body) = type_body(node) else {
        return Vec::new();
    };
    let mut cursor = body.walk();
    body.named_children(&mut cursor)
        .filter(|child| child.kind() == "method_declaration")
        .filter_map(|method| {
            method
                .child_by_field_name("name")
                .and_then(|name| text(name, source))
                .map(|name| JavaMethod {
                    node: method,
                    is_static: method_is_static(method, source),
                    signature: method_signature(method, source),
                    name,
                })
        })
        .collect()
}

fn compact_java_type(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn compact_java_node_type(node: Node<'_>, source: &str) -> Option<String> {
    text_ref(node, source).map(compact_java_type)
}

fn method_signature(method: Node<'_>, source: &str) -> String {
    let mut signature = String::from("(");
    let mut first_parameter = true;
    if let Some(parameters) = method.child_by_field_name("parameters") {
        let mut cursor = parameters.walk();
        for parameter in parameters.named_children(&mut cursor).filter(|parameter| {
            matches!(
                parameter.kind(),
                "formal_parameter" | "spread_parameter" | "receiver_parameter"
            )
        }) {
            if !first_parameter {
                signature.push(',');
            }
            first_parameter = false;
            let parameter_type = parameter
                .child_by_field_name("type")
                .and_then(|kind| compact_java_node_type(kind, source))
                .unwrap_or_else(|| "unknown".to_string());
            signature.push_str(&parameter_type);
        }
    }
    signature.push_str("):");
    let return_type = method
        .child_by_field_name("type")
        .and_then(|kind| compact_java_node_type(kind, source))
        .unwrap_or_else(|| "void".to_string());
    signature.push_str(&return_type);
    signature
}

struct JavaCallContext<'a> {
    path: &'a str,
    source: &'a str,
    owner: &'a NativeJsSymbolReference,
    type_name: &'a str,
    static_names: &'a HashSet<String>,
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
    if node.kind() == "method_invocation"
        && node.child_by_field_name("object").is_none()
        && let Some(name) = node
            .child_by_field_name("name")
            .and_then(|name| text_ref(name, context.source))
        && context.static_names.contains(name)
    {
        calls.push(NativeJsCall {
            name: format!("{}.{name}", context.type_name),
            source: Some(context.owner.clone()),
            imported: None,
            evidence: evidence(context.path, node),
        });
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_calls(child, method, context, calls);
    }
}

pub fn parse_native_java_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .ok()?;
    parse_native_java_facts_with_parser(path, source, &mut parser)
}

pub fn parse_native_java_facts_with_parser(
    path: &str,
    source: &str,
    parser: &mut Parser,
) -> Option<NativeJsFacts> {
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
    let mut root_cursor = root.walk();
    for declaration in root
        .named_children(&mut root_cursor)
        .filter(|node| node.kind() == "import_declaration")
    {
        let mut declaration_cursor = declaration.walk();
        if let Some(import) = declaration
            .named_children(&mut declaration_cursor)
            .find(|child| matches!(child.kind(), "identifier" | "scoped_identifier"))
            && let Some(specifier) = text(import, source)
        {
            structural.imports.push(NativeJsImport {
                specifier,
                standard: None,
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
    let mut root_cursor = root.walk();
    for declaration in root
        .named_children(&mut root_cursor)
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
                .map(|method| method.name.clone())
                .collect(),
            evidence: evidence(path, declaration),
            identity: Some(NativeJsCanonicalSymbolIdentity {
                qualified_name: type_name.clone(),
                lexical_owner: None,
                signature: None,
                discriminator: "type".into(),
            }),
        });
        structural.canonical_symbols.push(
            structural
                .symbols
                .last()
                .expect("class was inserted")
                .clone(),
        );
        let owner = NativeJsSymbolReference {
            symbol_type: "class".into(),
            name: type_name.clone(),
        };
        for method in &method_details {
            let qualified_name = format!("{type_name}.{}", method.name);
            structural.canonical_symbols.push(NativeJsStructuralSymbol {
                symbol_type: "method".into(),
                name: method.name.clone(),
                methods: vec![],
                evidence: evidence(path, method.node),
                identity: Some(NativeJsCanonicalSymbolIdentity {
                    qualified_name,
                    lexical_owner: Some(owner.clone()),
                    signature: Some(method.signature.clone()),
                    discriminator: if method.is_static {
                        "static-method"
                    } else {
                        "instance-method"
                    }
                    .into(),
                }),
            });
        }
        let mut static_counts = HashMap::<String, usize>::new();
        for method in &method_details {
            if method.is_static {
                *static_counts.entry(method.name.clone()).or_default() += 1;
            }
        }
        let unique_static = method_details
            .into_iter()
            .filter(|method| method.is_static && static_counts.get(&method.name) == Some(&1))
            .collect::<Vec<_>>();
        let static_names = unique_static
            .iter()
            .map(|method| method.name.clone())
            .collect::<HashSet<_>>();
        for method in unique_static {
            let qualified_name = format!("{type_name}.{}", method.name);
            let owner = NativeJsSymbolReference {
                symbol_type: "function".into(),
                name: qualified_name.clone(),
            };
            structural.symbols.push(NativeJsStructuralSymbol {
                symbol_type: "function".into(),
                name: qualified_name,
                methods: vec![],
                evidence: evidence(path, method.node),
                identity: Some(NativeJsCanonicalSymbolIdentity {
                    qualified_name: format!("{type_name}.{}", method.name),
                    lexical_owner: Some(NativeJsSymbolReference {
                        symbol_type: "class".into(),
                        name: type_name.clone(),
                    }),
                    signature: Some(method.signature),
                    discriminator: "static-method".into(),
                }),
            });
            if let Some(body) = method.node.child_by_field_name("body") {
                let context = JavaCallContext {
                    path,
                    source,
                    owner: &owner,
                    type_name: &type_name,
                    static_names: &static_names,
                };
                collect_calls(body, method.node, &context, &mut structural.calls);
            }
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

    #[test]
    fn canonical_java_methods_preserve_overload_signatures() {
        let facts = parse_native_java_facts(
            "src/OrderService.java",
            "class OrderService { void save(Order order) {} void save(Order order, User user) {} }",
        )
        .unwrap();
        let overloads = facts
            .structural
            .canonical_symbols
            .iter()
            .filter(|symbol| symbol.symbol_type == "method" && symbol.name == "save")
            .collect::<Vec<_>>();
        assert_eq!(overloads.len(), 2);
        assert_eq!(
            overloads
                .iter()
                .map(|symbol| symbol
                    .identity
                    .as_ref()
                    .unwrap()
                    .signature
                    .as_deref()
                    .unwrap())
                .collect::<Vec<_>>(),
            ["(Order):void", "(Order,User):void"]
        );
        assert!(overloads.iter().all(|symbol| {
            symbol
                .identity
                .as_ref()
                .and_then(|identity| identity.lexical_owner.as_ref())
                .is_some_and(|owner| owner.name == "OrderService")
        }));
    }
}
