//! C# structural facts for strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCanonicalSymbolIdentity, NativeJsEvidence, NativeJsFacts,
    NativeJsImport, NativeJsPosition, NativeJsRange, NativeJsStructuralFacts,
    NativeJsStructuralSymbol, NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::BTreeSet;
use tree_sitter::{Node, Parser};

const PARSER: &str = "csharp-static-ast";

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
    if !node.has_error() {
        return 0;
    }
    let mut count = 0;
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        count += usize::from(current.is_error() || current.is_missing());
        let mut cursor = current.walk();
        stack.extend(current.named_children(&mut cursor));
    }
    count
}
fn declaration_name(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .and_then(|child| text(child, source))
}
fn type_body(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("body").or_else(|| {
        let mut cursor = node.walk();
        node.named_children(&mut cursor)
            .find(|child| child.kind() == "declaration_list")
    })
}

fn compact_type(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn method_signature(node: Node<'_>, source: &str) -> String {
    let parameters = node
        .child_by_field_name("parameters")
        .map(|parameters| {
            let mut cursor = parameters.walk();
            parameters
                .named_children(&mut cursor)
                .filter(|parameter| parameter.kind() == "parameter")
                .map(|parameter| {
                    parameter
                        .child_by_field_name("type")
                        .and_then(|kind| text(kind, source))
                        .map(|kind| compact_type(&kind))
                        .unwrap_or_else(|| "unknown".to_string())
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let return_type = node
        .child_by_field_name("returns")
        .and_then(|kind| text(kind, source))
        .map(|kind| compact_type(&kind))
        .unwrap_or_else(|| "constructor".to_string());
    format!("({parameters}):{return_type}")
}

fn is_static(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).any(|child| {
        child.kind() == "modifier"
            && text(child, source).is_some_and(|modifier| modifier == "static")
    })
}

fn visit_node(
    path: &str,
    source: &str,
    node: Node<'_>,
    structural: &mut NativeJsStructuralFacts,
) {
    if node.kind() == "using_directive"
        && let Some(name) = text(node, source)
            .map(|value| value.trim().trim_end_matches(';').trim().to_string())
            .and_then(|value| {
                let value = value.strip_prefix("global ").unwrap_or(&value).trim();
                let value = value.strip_prefix("using ").unwrap_or(value).trim();
                let value = value.strip_prefix("static ").unwrap_or(value).trim();
                let value = value
                    .split_once('=')
                    .map(|(_, target)| target.trim())
                    .unwrap_or(value);
                (!value.is_empty()).then(|| value.to_string())
            })
    {
        structural.imports.push(NativeJsImport {
            specifier: name,
            standard: None,
            evidence: evidence(path, node),
        });
    }
    if matches!(
        node.kind(),
        "class_declaration"
            | "interface_declaration"
            | "struct_declaration"
            | "record_declaration"
    ) && let Some(name) = declaration_name(node, source)
    {
        let method_details = type_body(node)
            .map(|body| {
                let mut cursor = body.walk();
                body.named_children(&mut cursor)
                    .filter(|member| {
                        matches!(
                            member.kind(),
                            "method_declaration" | "constructor_declaration"
                        )
                    })
                    .filter_map(|member| {
                        declaration_name(member, source).map(|member_name| (member, member_name))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        structural.symbols.push(NativeJsStructuralSymbol {
            symbol_type: "class".into(),
            name: name.clone(),
            methods: method_details
                .iter()
                .filter(|(method, _)| method.kind() == "method_declaration")
                .map(|(_, method_name)| method_name.clone())
                .collect(),
            evidence: evidence(path, node),
            identity: Some(NativeJsCanonicalSymbolIdentity {
                qualified_name: name.clone(),
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
            name: name.clone(),
        };
        for (method, method_name) in method_details {
            structural.canonical_symbols.push(NativeJsStructuralSymbol {
                symbol_type: if method.kind() == "constructor_declaration" {
                    "constructor"
                } else {
                    "method"
                }
                .into(),
                name: method_name.clone(),
                methods: vec![],
                evidence: evidence(path, method),
                identity: Some(NativeJsCanonicalSymbolIdentity {
                    qualified_name: format!("{name}.{method_name}"),
                    lexical_owner: Some(owner.clone()),
                    signature: Some(method_signature(method, source)),
                    discriminator: if method.kind() == "constructor_declaration" {
                        "constructor"
                    } else if is_static(method, source) {
                        "static-method"
                    } else {
                        "instance-method"
                    }
                    .into(),
                }),
            });
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        visit_node(path, source, child, structural);
    }
}

fn position_at(source: &str, offset: usize) -> NativeJsPosition {
    let prefix = &source[..offset.min(source.len())];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = prefix
        .rfind('\n')
        .map_or(prefix.len() + 1, |newline| prefix.len() - newline);
    NativeJsPosition { line, column }
}

fn recover_malformed_declaration(path: &str, source: &str) -> Option<NativeJsStructuralSymbol> {
    let mut declaration = None;
    for keyword in ["class", "interface", "struct", "record"] {
        let needle = format!("{keyword} ");
        for (offset, _) in source.match_indices(&needle) {
            let boundary = offset == 0
                || source.as_bytes()[offset - 1].is_ascii_whitespace()
                || matches!(source.as_bytes()[offset - 1], b'{' | b';');
            if boundary && declaration.is_none_or(|(current, _, _)| offset < current) {
                declaration = Some((offset, keyword, needle.len()));
            }
        }
    }
    let (keyword_offset, _, keyword_length) = declaration?;
    let name_start = keyword_offset + keyword_length;
    let name_end = source[name_start..]
        .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .map(|length| name_start + length)
        .unwrap_or(source.len());
    let name = source[name_start..name_end].to_string();
    if name.is_empty() {
        return None;
    }
    let line_start = source[..keyword_offset]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    let start = line_start
        + source[line_start..keyword_offset]
            .bytes()
            .take_while(u8::is_ascii_whitespace)
            .count();
    let mut methods = BTreeSet::new();
    for (open, _) in source[name_end..].match_indices('(') {
        let open = name_end + open;
        let prefix = source[..open].trim_end();
        let method_start = prefix
            .rfind(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
            .map_or(0, |separator| separator + 1);
        let method = &prefix[method_start..];
        if !method.is_empty()
            && method != name
            && !["if", "for", "while", "switch", "catch", "nameof"].contains(&method)
        {
            methods.insert(method.to_string());
        }
    }
    Some(NativeJsStructuralSymbol {
        symbol_type: "class".into(),
        name,
        methods: methods.into_iter().collect(),
        evidence: NativeJsEvidence {
            parser: PARSER.into(),
            file: path.into(),
            range: NativeJsRange {
                start: position_at(source, start),
                end: position_at(source, source.len()),
            },
        },
        identity: None,
    })
}

pub fn parse_native_csharp_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .ok()?;
    parse_native_csharp_facts_with_parser(path, source, &mut parser)
}

pub fn parse_native_csharp_facts_with_parser(
    path: &str,
    source: &str,
    parser: &mut Parser,
) -> Option<NativeJsFacts> {
    // Roslyn treats an initial UTF-8 BOM as encoding metadata rather than
    // source text. Tree-sitter otherwise counts its three encoded bytes as
    // columns, shifting every range on the first line.
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    // Parser recovery trees are implementation details.  Match the Roslyn
    // oracle contract by reporting only the presence or absence of a syntax
    // error, not a parser-specific recovery-node count.
    let diagnostic_count = usize::from(diagnostics(root) > 0);
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
            reason: (diagnostic_count > 0)
                .then(|| "C# source contains one or more syntax errors.".into()),
        },
    };
    // Roslyn DescendantNodes is a source-order preorder traversal. Recurse
    // directly through the tree-sitter child iterator so each AST node is
    // visited without allocating a temporary Vec for its siblings.
    visit_node(path, source, root, &mut structural);
    if diagnostic_count > 0
        && structural.symbols.is_empty()
        && let Some(symbol) = recover_malformed_declaration(path, source)
    {
        structural.symbols.push(symbol);
    }
    structural.imports.sort_by(|left, right| {
        left.evidence
            .range
            .start
            .line
            .cmp(&right.evidence.range.start.line)
            .then(
                left.evidence
                    .range
                    .start
                    .column
                    .cmp(&right.evidence.range.start.column),
            )
    });
    let mut seen_methods = BTreeSet::new();
    structural.methods = structural
        .symbols
        .iter()
        .flat_map(|symbol| symbol.methods.iter().cloned())
        .filter(|method| seen_methods.insert(method.clone()))
        .collect();
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
            .map(|item| item.specifier.clone())
            .collect(),
        symbols,
        direct_calls: vec![],
        structural,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_native_csharp_facts;

    #[test]
    fn preserves_usings_types_and_methods() {
        let facts = parse_native_csharp_facts(
            "src/OrdersService.cs",
            "using System;\nusing Acme.Data;\nnamespace Acme; public class OrdersService { public void Submit() {} private int Count() => 1; }",
        )
        .expect("C# files have a strict native parser");
        assert_eq!(facts.parser, "csharp-static-ast");
        assert_eq!(facts.structural.imports.len(), 2);
        assert_eq!(facts.structural.imports[0].specifier, "System");
        assert_eq!(facts.structural.symbols[0].name, "OrdersService");
        assert_eq!(facts.structural.symbols[0].methods, ["Submit", "Count"]);
        assert_eq!(facts.structural.methods, ["Submit", "Count"]);
    }

    #[test]
    fn preserves_roslyn_bom_ranges_and_first_duplicate_type_declaration() {
        let facts = parse_native_csharp_facts(
            "src/Mailable.cs",
            "\u{feff}using System;\npublic class Mailable<T> { public void First() {} }\npublic class Mailable { public void Second() {} }\n",
        )
        .unwrap();
        assert_eq!(facts.structural.imports[0].evidence.range.start.column, 1);
        assert_eq!(facts.structural.imports[0].evidence.range.end.column, 14);
        assert_eq!(facts.structural.symbols[0].name, "Mailable");
        assert_eq!(facts.structural.symbols[0].methods, ["First"]);
        assert_eq!(facts.structural.symbols[1].methods, ["Second"]);
        assert_eq!(facts.structural.methods, ["First", "Second"]);
    }

    #[test]
    fn canonical_symbols_preserve_overloaded_methods_and_constructors() {
        let facts = parse_native_csharp_facts(
            "src/OrderService.cs",
            "public class OrderService { public OrderService(Order order) {} public OrderService(Order order, User user) {} public void Save(Order order) {} public void Save(Order order, User user) {} }",
        )
        .unwrap();
        let identities = facts
            .structural
            .canonical_symbols
            .iter()
            .filter_map(|symbol| symbol.identity.as_ref())
            .collect::<Vec<_>>();
        assert_eq!(identities.len(), 5);
        assert_eq!(
            identities[1].signature.as_deref(),
            Some("(Order):constructor")
        );
        assert_eq!(
            identities[2].signature.as_deref(),
            Some("(Order,User):constructor")
        );
        assert_eq!(identities[3].signature.as_deref(), Some("(Order):void"));
        assert_eq!(
            identities[4].signature.as_deref(),
            Some("(Order,User):void")
        );
        assert_eq!(facts.structural.symbols[0].methods, ["Save", "Save"]);
    }

    #[test]
    fn malformed_source_normalizes_diagnostics_and_recovers_roslyn_declarations() {
        let facts = parse_native_csharp_facts(
            "src/Broken.cs",
            "using Acme.Data;\npublic class Broken { public void Submit( {\n",
        )
        .expect("C# files have a strict native parser");
        assert_eq!(facts.status, "parsed-with-diagnostics");
        assert_eq!(facts.diagnostics, 1);
        assert_eq!(
            facts.structural.analysis.reason.as_deref(),
            Some("C# source contains one or more syntax errors.")
        );
        assert_eq!(facts.structural.symbols[0].name, "Broken");
        assert_eq!(facts.structural.symbols[0].methods, ["Submit"]);
        assert_eq!(facts.structural.symbols[0].evidence.range.start.line, 2);
        assert_eq!(facts.structural.symbols[0].evidence.range.start.column, 1);
        assert_eq!(facts.structural.symbols[0].evidence.range.end.line, 3);
        assert_eq!(facts.structural.symbols[0].evidence.range.end.column, 1);
        assert!(facts.direct_calls.is_empty());
    }
}
