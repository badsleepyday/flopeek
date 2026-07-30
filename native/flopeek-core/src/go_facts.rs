//! Go structural facts for strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCall, NativeJsEvidence, NativeJsFacts, NativeJsImport,
    NativeJsImportedReference, NativeJsPosition, NativeJsRange, NativeJsStructuralFacts,
    NativeJsStructuralSymbol, NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::{BTreeMap, BTreeSet};
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

fn diagnostics(node: Node<'_>) -> usize {
    usize::from(node.is_error() || node.is_missing())
        + children(node).into_iter().map(diagnostics).sum::<usize>()
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
    if specifier == "C" {
        return true;
    }
    let root = specifier.split('/').next().unwrap_or(specifier);
    matches!(
        root,
        "archive"
            | "bufio"
            | "builtin"
            | "bytes"
            | "cmp"
            | "compress"
            | "container"
            | "context"
            | "crypto"
            | "database"
            | "debug"
            | "embed"
            | "encoding"
            | "errors"
            | "expvar"
            | "flag"
            | "fmt"
            | "go"
            | "hash"
            | "html"
            | "image"
            | "index"
            | "io"
            | "log"
            | "maps"
            | "math"
            | "mime"
            | "net"
            | "os"
            | "path"
            | "plugin"
            | "reflect"
            | "regexp"
            | "runtime"
            | "slices"
            | "sort"
            | "strconv"
            | "strings"
            | "structs"
            | "sync"
            | "syscall"
            | "testing"
            | "text"
            | "time"
            | "unicode"
            | "unsafe"
    )
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

fn identifier_children(node: Node<'_>, source: &str, names: &mut BTreeSet<String>) {
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if current.kind() == "identifier" {
            if let Some(name) = text(current, source) {
                names.insert(name);
            }
            continue;
        }
        stack.extend(children(current));
    }
}

fn function_bound_names(node: Node<'_>, source: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for field in ["receiver", "parameters", "result"] {
        if let Some(value) = node.child_by_field_name(field) {
            identifier_children(value, source, &mut names);
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
            "short_var_declaration" | "var_spec" | "range_clause" | "receive_statement"
        ) {
            if let Some(left) = current
                .child_by_field_name("left")
                .or_else(|| current.child_by_field_name("name"))
            {
                identifier_children(left, source, &mut names);
            }
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

pub fn parse_native_go_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_go::LANGUAGE.into()).ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let diagnostic_count = diagnostics(root);
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
                        name,
                        methods: Vec::new(),
                        evidence: evidence(path, spec),
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
            symbols.push(NativeJsStructuralSymbol {
                symbol_type: "function".into(),
                name,
                methods: Vec::new(),
                evidence: evidence(path, *declaration),
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
    let calls = declarations
        .iter()
        .filter(|node| matches!(node.kind(), "function_declaration" | "method_declaration"))
        .flat_map(|node| {
            function_calls(path, *node, source, &top_level_functions, &import_bindings)
        })
        .collect::<Vec<_>>();
    let methods = declarations
        .iter()
        .filter(|node| matches!(node.kind(), "function_declaration" | "method_declaration"))
        .filter_map(|node| declaration_name(*node, source))
        .collect::<BTreeSet<_>>()
        .into_iter()
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
}
