//! Svelte static facts for the strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsEvidence, NativeJsFacts, NativeJsImport, NativeJsPosition,
    NativeJsRange, NativeJsStructuralFacts,
};
use std::collections::BTreeSet;
use tree_sitter::{Node, Parser};

const PARSER: &str = "svelte-static-ast";

fn children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn text(node: Node<'_>, source: &str) -> Option<String> {
    node.utf8_text(source.as_bytes()).ok().map(str::to_owned)
}

fn position_for_byte(source: &str, byte: usize) -> NativeJsPosition {
    let prefix = &source.as_bytes()[..byte.min(source.len())];
    let line = prefix.iter().filter(|value| **value == b'\n').count() + 1;
    let column = prefix
        .iter()
        .rposition(|value| *value == b'\n')
        .map(|index| prefix.len() - index)
        .unwrap_or(prefix.len() + 1);
    NativeJsPosition { line, column }
}

fn evidence(path: &str, source: &str, start: usize, end: usize) -> NativeJsEvidence {
    NativeJsEvidence {
        parser: PARSER.into(),
        file: path.into(),
        range: NativeJsRange {
            start: position_for_byte(source, start),
            end: position_for_byte(source, end),
        },
    }
}

fn diagnostics(node: Node<'_>) -> usize {
    usize::from(node.is_error() || node.is_missing())
        + children(node).into_iter().map(diagnostics).sum::<usize>()
}

fn script_uses_typescript(script: Node<'_>, source: &str) -> bool {
    children(script)
        .into_iter()
        .find(|child| child.kind() == "start_tag")
        .and_then(|start| text(start, source))
        .is_some_and(|tag| {
            let normalized = tag.to_ascii_lowercase();
            normalized.contains("lang=\"ts\"")
                || normalized.contains("lang='ts'")
                || normalized.contains("lang=ts")
                || normalized.contains("type=\"text/typescript\"")
        })
}

fn script_imports(
    script: Node<'_>,
    path: &str,
    source: &str,
    imports: &mut Vec<NativeJsImport>,
) -> bool {
    let typescript = script_uses_typescript(script, source);
    let raw_text = children(script)
        .into_iter()
        .find(|child| child.kind() == "raw_text");
    let Some(raw_text) = raw_text else {
        return true;
    };
    let Some(script_source) = text(raw_text, source) else {
        return false;
    };
    let mut parser = Parser::new();
    let language = if typescript {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    } else {
        tree_sitter_javascript::LANGUAGE.into()
    };
    if parser.set_language(&language).is_err() {
        return false;
    }
    let Some(tree) = parser.parse(&script_source, None) else {
        return false;
    };
    if diagnostics(tree.root_node()) > 0 {
        return false;
    }
    for statement in children(tree.root_node()) {
        if statement.kind() != "import_statement" {
            continue;
        }
        let Some(specifier) = children(statement)
            .into_iter()
            .find(|child| child.kind() == "string")
            .and_then(|literal| text(literal, &script_source))
            .map(|literal| literal.trim_matches(['\'', '"']).to_string())
            .filter(|specifier| !specifier.is_empty())
        else {
            continue;
        };
        imports.push(NativeJsImport {
            specifier,
            evidence: evidence(
                path,
                source,
                raw_text.start_byte() + statement.start_byte(),
                raw_text.start_byte() + statement.end_byte(),
            ),
        });
    }
    true
}

pub fn parse_native_svelte_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_svelte_next::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let mut imports = Vec::new();
    let valid = diagnostics(root) == 0
        && children(root)
            .into_iter()
            .filter(|node| node.kind() == "script_element")
            .all(|script| script_imports(script, path, source, &mut imports));
    let (status, confidence, diagnostic_count) = if valid {
        ("parsed", "exact", 0)
    } else {
        ("parse-failed", "not-analyzed", diagnostics(root).max(1))
    };
    let structural = NativeJsStructuralFacts {
        imports: if valid { imports } else { vec![] },
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
            status: status.into(),
            confidence: confidence.into(),
            diagnostics: diagnostic_count,
            reason: None,
        },
    };
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
        symbols: vec![],
        direct_calls: BTreeSet::<String>::new().into_iter().collect(),
        structural,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_native_svelte_facts;

    #[test]
    fn preserves_instance_and_module_script_imports() {
        let facts = parse_native_svelte_facts("src/routes/+page.svelte", "<script context=\"module\">import { version } from '$app/environment';</script>\n<script lang=\"ts\">import Card from '$lib/Card.svelte';</script>\n<Card />").unwrap();
        assert_eq!(facts.parser, "svelte-static-ast");
        assert_eq!(facts.structural.imports.len(), 2);
        assert_eq!(facts.structural.imports[1].specifier, "$lib/Card.svelte");
    }
}
