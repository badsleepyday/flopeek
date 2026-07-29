//! C# structural facts for strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsEvidence, NativeJsFacts, NativeJsImport, NativeJsPosition,
    NativeJsRange, NativeJsStructuralFacts, NativeJsStructuralSymbol, NativeJsSymbol,
};
use std::collections::BTreeSet;
use tree_sitter::{Node, Parser};

const PARSER: &str = "csharp-static-ast";

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
fn declaration_name(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .and_then(|child| text(child, source))
}
fn type_body(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("body").or_else(|| {
        children(node)
            .into_iter()
            .find(|child| child.kind() == "declaration_list")
    })
}

pub fn parse_native_csharp_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
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
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "using_directive" {
            if let Some(name) = children(node)
                .into_iter()
                .find(|child| !matches!(child.kind(), "name_equals" | "global" | "static"))
                .and_then(|child| text(child, source))
                .map(|value| value.trim_end_matches(';').to_string())
                .filter(|value| !value.is_empty())
            {
                structural.imports.push(NativeJsImport {
                    specifier: name,
                    evidence: evidence(path, node),
                });
            }
        }
        if matches!(
            node.kind(),
            "class_declaration"
                | "interface_declaration"
                | "struct_declaration"
                | "record_declaration"
        ) {
            if let Some(name) = declaration_name(node, source) {
                let methods = type_body(node)
                    .map(children)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|member| member.kind() == "method_declaration")
                    .filter_map(|member| declaration_name(member, source))
                    .collect::<Vec<_>>();
                structural.symbols.push(NativeJsStructuralSymbol {
                    symbol_type: "class".into(),
                    name,
                    methods,
                    evidence: evidence(path, node),
                });
            }
        }
        stack.extend(children(node));
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
    structural.methods = structural
        .symbols
        .iter()
        .flat_map(|symbol| symbol.methods.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(12)
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
    }
}
