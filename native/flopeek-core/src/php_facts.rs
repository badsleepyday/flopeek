//! PHP parser facts for the strict-native source authority.
use crate::js_facts::{
    NativeJsAnalysis, NativeJsCall, NativeJsEvidence, NativeJsFacts, NativeJsImport,
    NativeJsPosition, NativeJsRange, NativeJsStructuralFacts, NativeJsStructuralSymbol,
    NativeJsSymbol, NativeJsSymbolReference,
};
use std::collections::BTreeSet;
use tree_sitter::{Node, Parser};

const PARSER: &str = "php-parser";

#[derive(Clone)]
struct RecoveredType {
    name: String,
    methods: Vec<String>,
    start: usize,
    end: usize,
}

fn identifier(bytes: &[u8], mut index: usize) -> Option<(String, usize)> {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    let start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    {
        index += 1;
    }
    (index > start).then(|| {
        (
            String::from_utf8_lossy(&bytes[start..index]).into_owned(),
            index,
        )
    })
}

fn word_at(bytes: &[u8], index: usize, word: &[u8]) -> bool {
    bytes.get(index..index + word.len()) == Some(word)
        && !bytes
            .get(index.wrapping_sub(1))
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        && !bytes
            .get(index + word.len())
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

// Preserve byte offsets while removing PHP comments and quoted literals. This
// small recovery lexer is deliberately used only when tree-sitter has lost a
// legacy type declaration during error recovery.
fn php_code_bytes(source: &str) -> Vec<u8> {
    let original = source.as_bytes();
    let mut code = original.to_vec();
    let mut index = 0;
    while index < code.len() {
        let quote = code[index];
        if quote == b'\'' || quote == b'"' {
            code[index] = b' ';
            index += 1;
            while index < code.len() {
                let current = code[index];
                code[index] = if current == b'\n' { b'\n' } else { b' ' };
                index += 1;
                if current == b'\\' {
                    if index < code.len() {
                        code[index] = b' ';
                        index += 1;
                    }
                } else if current == quote {
                    break;
                }
            }
        } else if quote == b'/' && code.get(index + 1) == Some(&b'/') || quote == b'#' {
            while index < code.len() && code[index] != b'\n' {
                code[index] = b' ';
                index += 1;
            }
        } else if quote == b'/' && code.get(index + 1) == Some(&b'*') {
            code[index] = b' ';
            code[index + 1] = b' ';
            index += 2;
            while index + 1 < code.len() && !(code[index] == b'*' && code[index + 1] == b'/') {
                code[index] = if code[index] == b'\n' { b'\n' } else { b' ' };
                index += 1;
            }
            if index < code.len() {
                code[index] = b' ';
                index += 1;
            }
            if index < code.len() {
                code[index] = b' ';
                index += 1;
            }
        } else {
            index += 1;
        }
    }
    code
}

fn recover_legacy_types(source: &str) -> Vec<RecoveredType> {
    let code = php_code_bytes(source);
    let mut root_depths = Vec::with_capacity(code.len());
    let mut depth = 0isize;
    for byte in &code {
        root_depths.push(depth);
        match byte {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
    }
    let mut recovered = Vec::new();
    let mut index = 0;
    while index < code.len() {
        let root_depth = root_depths[index];
        let keyword = [b"class".as_slice(), b"interface", b"trait", b"enum"]
            .into_iter()
            .find(|word| word_at(&code, index, word));
        let Some(keyword) = keyword else {
            index += 1;
            continue;
        };
        // Match the JavaScript adapter: declarations nested in executable
        // blocks are not public top-level symbols.
        if root_depth != 0 {
            index += keyword.len();
            continue;
        }
        let Some((name, after_name)) = identifier(&code, index + keyword.len()) else {
            index += keyword.len();
            continue;
        };
        let Some(open) = (after_name..code.len())
            .find(|position| code[*position] == b'{' || code[*position] == b';')
        else {
            break;
        };
        if code[open] != b'{' {
            index = after_name;
            continue;
        }
        let mut depth = 1usize;
        let mut cursor = open + 1;
        let mut methods = Vec::new();
        while cursor < code.len() && depth > 0 {
            if depth == 1
                && word_at(&code, cursor, b"function")
                && let Some((method, _)) = identifier(&code, cursor + b"function".len())
            {
                methods.push(method);
            }
            match code[cursor] {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            cursor += 1;
        }
        if depth == 0 {
            recovered.push(RecoveredType {
                name,
                methods,
                start: index,
                end: cursor,
            });
            index = cursor;
        } else {
            break;
        }
    }
    recovered
}

fn children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn tree_diagnostics(node: Node<'_>) -> usize {
    let mut count = 0;
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        count += usize::from(current.is_error() || current.is_missing());
        let mut cursor = current.walk();
        stack.extend(current.named_children(&mut cursor));
    }
    count
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

fn offset_evidence(path: &str, source: &str, start: usize, end: usize) -> NativeJsEvidence {
    let position = |offset: usize| {
        let prefix = &source.as_bytes()[..offset.min(source.len())];
        let line = prefix.iter().filter(|byte| **byte == b'\n').count() + 1;
        let column = prefix
            .iter()
            .rev()
            .take_while(|byte| **byte != b'\n')
            .count()
            + 1;
        NativeJsPosition { line, column }
    };
    NativeJsEvidence {
        parser: PARSER.into(),
        file: path.into(),
        range: NativeJsRange {
            start: position(start),
            end: position(end),
        },
    }
}

fn call_evidence(path: &str, source: &str, node: Node<'_>) -> NativeJsEvidence {
    let mut value = evidence(path, node);
    if node
        .parent()
        .is_some_and(|parent| parent.kind() == "expression_statement")
        && source.as_bytes().get(node.end_byte()) == Some(&b';')
    {
        value.range.end.column += 1;
    }
    value
}

fn function_name(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .or_else(|| {
            children(node)
                .into_iter()
                .find(|child| child.kind() == "name")
        })
        .and_then(|child| text(child, source))
}

fn type_declaration(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "class_declaration" | "interface_declaration" | "trait_declaration" | "enum_declaration"
    )
}

fn top_level(node: Node<'_>) -> bool {
    match node.parent() {
        Some(parent) if parent.kind() == "program" => true,
        Some(parent) if parent.kind() == "compound_statement" => parent
            .parent()
            .is_some_and(|namespace| namespace.kind() == "namespace_definition"),
        _ => false,
    }
}

fn declaration_methods(node: Node<'_>, source: &str) -> Vec<String> {
    node.child_by_field_name("body")
        .map(children)
        .unwrap_or_default()
        .into_iter()
        .filter(|member| member.kind() == "method_declaration")
        .filter_map(|member| function_name(member, source))
        .collect()
}

fn class_owner(node: Node<'_>, source: &str) -> Option<NativeJsSymbolReference> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if type_declaration(parent) {
            return function_name(parent, source).map(|name| NativeJsSymbolReference {
                symbol_type: "class".into(),
                name,
            });
        }
        current = parent.parent();
    }
    None
}

fn owner(node: Node<'_>, source: &str) -> Option<NativeJsSymbolReference> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "function_definition" && top_level(parent) {
            return function_name(parent, source).map(|name| NativeJsSymbolReference {
                symbol_type: "function".into(),
                name,
            });
        }
        if parent.kind() == "method_declaration" {
            return class_owner(parent, source);
        }
        current = parent.parent();
    }
    None
}

// The public PHP adapter is deliberately tolerant of legacy PHP grammar but
// reports unmatched block delimiters in embedded templates. Tree-sitter's
// recovery-node count is not that contract: a single old construct can create
// hundreds of recovery nodes. Count delimiter errors from PHP regions only,
// preserving cross-tag control blocks while excluding HTML, JavaScript, quoted
// strings, and PHP comments.
fn php_block_diagnostics(source: &str) -> usize {
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut in_php = false;
    let mut depth = 0usize;
    let mut errors = 0usize;
    while index < bytes.len() {
        if !in_php {
            let php_tag = bytes
                .get(index..index + 5)
                .is_some_and(|tag| tag.eq_ignore_ascii_case(b"<?php"));
            let echo_tag = bytes.get(index..index + 3) == Some(b"<?=");
            if php_tag || echo_tag {
                in_php = true;
                index += if php_tag { 5 } else { 3 };
            } else {
                index += 1;
            }
            continue;
        }
        if bytes.get(index..index + 2) == Some(b"?>") {
            in_php = false;
            index += 2;
            continue;
        }
        match bytes[index] {
            b'\'' | b'"' => {
                let quote = bytes[index];
                index += 1;
                while index < bytes.len() {
                    let current = bytes[index];
                    index += 1;
                    if current == b'\\' {
                        index = (index + 1).min(bytes.len());
                    } else if current == quote {
                        break;
                    }
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'#' => {
                index += 1;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            b'{' => {
                depth += 1;
                index += 1;
            }
            b'}' => {
                if depth == 0 {
                    errors += 1;
                } else {
                    depth -= 1;
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    errors + depth
}

fn collect_calls(
    node: Node<'_>,
    path: &str,
    source: &str,
    local_functions: &BTreeSet<String>,
    facts: &mut NativeJsStructuralFacts,
) {
    if node.kind() == "function_call_expression" {
        let name = node
            .child_by_field_name("function")
            .or_else(|| {
                children(node)
                    .into_iter()
                    .find(|child| child.kind() == "name")
            })
            .and_then(|child| text(child, source));
        if let Some(name) =
            name.filter(|name| local_functions.contains(name) && !name.contains('\\'))
        {
            facts.calls.push(NativeJsCall {
                name,
                source: owner(node, source),
                imported: None,
                evidence: call_evidence(path, source, node),
            });
        }
    }
    for child in children(node) {
        collect_calls(child, path, source, local_functions, facts);
    }
}

fn collect_top_level_declarations(
    node: Node<'_>,
    path: &str,
    source: &str,
    local_functions: &mut BTreeSet<String>,
    symbols: &mut Vec<NativeJsStructuralSymbol>,
    recovered: &[RecoveredType],
) {
    for child in children(node) {
        if child.kind() == "namespace_definition" {
            if let Some(body) = child.child_by_field_name("body") {
                collect_top_level_declarations(
                    body,
                    path,
                    source,
                    local_functions,
                    symbols,
                    recovered,
                );
            }
            continue;
        }
        if child.kind() == "function_definition"
            && top_level(child)
            && !recovered
                .iter()
                .any(|item| child.start_byte() > item.start && child.start_byte() < item.end)
        {
            if let Some(name) = function_name(child, source) {
                local_functions.insert(name.clone());
                symbols.push(NativeJsStructuralSymbol {
                    symbol_type: "function".into(),
                    name,
                    methods: vec![],
                    evidence: evidence(path, child),
                    identity: None,
                });
            }
            continue;
        }
        if type_declaration(child)
            && top_level(child)
            && let Some(name) = function_name(child, source)
        {
            symbols.push(NativeJsStructuralSymbol {
                symbol_type: "class".into(),
                name,
                methods: declaration_methods(child, source),
                evidence: evidence(path, child),
                identity: None,
            });
        }
    }
}

fn collect_imports(node: Node<'_>, path: &str, source: &str, imports: &mut Vec<NativeJsImport>) {
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if current.kind() == "namespace_use_declaration" {
            let direct = children(current);
            let has_group = direct
                .iter()
                .any(|child| child.kind() == "namespace_use_group");
            for child in direct {
                if matches!(child.kind(), "name" | "qualified_name" | "relative_name") && !has_group
                {
                    if let Some(specifier) = text(child, source) {
                        imports.push(NativeJsImport {
                            specifier,
                            standard: None,
                            evidence: evidence(path, child),
                        });
                    }
                } else if child.kind() == "namespace_use_clause"
                    && let Some(specifier) = children(child)
                        .into_iter()
                        .find(|part| {
                            matches!(part.kind(), "name" | "qualified_name" | "relative_name")
                        })
                        .and_then(|part| text(part, source))
                {
                    imports.push(NativeJsImport {
                        specifier,
                        standard: None,
                        evidence: evidence(path, child),
                    });
                }
            }
        }
        stack.extend(children(current));
    }
    imports.sort_by(|left, right| {
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
            .then(left.specifier.cmp(&right.specifier))
    });
}

pub fn parse_native_php_facts(path: &str, source: &str) -> Option<NativeJsFacts> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_php::LANGUAGE_PHP.into())
        .ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();
    let tree_diagnostic_count = tree_diagnostics(root);
    let block_diagnostics = php_block_diagnostics(source);
    let diagnostic_count =
        block_diagnostics + usize::from(block_diagnostics > 0 && tree_diagnostic_count > 0);
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
    let mut local_functions = BTreeSet::new();
    let recovered = recover_legacy_types(source);
    collect_top_level_declarations(
        root,
        path,
        source,
        &mut local_functions,
        &mut structural.symbols,
        &recovered,
    );
    for item in &recovered {
        if let Some(symbol) = structural
            .symbols
            .iter_mut()
            .find(|symbol| symbol.symbol_type == "class" && symbol.name == item.name)
        {
            // Error recovery can retain the class name while truncating its
            // body. The native lexer has already matched the declaration's
            // direct brace pair, so use that exact source span and complete
            // direct method list for a malformed tree-sitter declaration.
            if tree_diagnostic_count > 0 {
                symbol.methods = item.methods.clone();
                symbol.evidence = offset_evidence(path, source, item.start, item.end);
            }
        } else {
            structural.symbols.push(NativeJsStructuralSymbol {
                symbol_type: "class".into(),
                name: item.name.clone(),
                methods: item.methods.clone(),
                evidence: offset_evidence(path, source, item.start, item.end),
                identity: None,
            });
        }
    }
    collect_imports(root, path, source, &mut structural.imports);
    collect_calls(root, path, source, &local_functions, &mut structural);
    for method in structural
        .symbols
        .iter()
        .flat_map(|symbol| symbol.methods.iter().cloned())
    {
        if structural.methods.len() < 12 && !structural.methods.contains(&method) {
            structural.methods.push(method);
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
        parser: "tree-sitter-php".into(),
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
    use super::{parse_native_php_facts, php_block_diagnostics, recover_legacy_types};

    #[test]
    fn counts_unmatched_php_blocks_without_counting_embedded_markup() {
        assert_eq!(
            php_block_diagnostics(
                "<script>if (value) {}</script><?php if ($ok) { ?>html<?php } ?>"
            ),
            0
        );
        assert_eq!(php_block_diagnostics("<?php if ($ok) { ?>html"), 1);
        assert_eq!(php_block_diagnostics("<?php if ($ok) { ?>html<? } ?>"), 1);
        assert_eq!(php_block_diagnostics("<?php } ?>"), 1);
        assert_eq!(php_block_diagnostics("<?php echo '}'; /* { } */ ?>"), 0);
    }

    #[test]
    fn legacy_recovery_keeps_only_root_types_and_their_direct_methods() {
        let recovered = recover_legacy_types(
            "<?php\nif (!class_exists('Shim')) { class Shim { function ignored() {} } }\nclass Legacy { public function run() {} private function save() {} }\n",
        );
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].name, "Legacy");
        assert_eq!(recovered[0].methods, ["run", "save"]);
    }

    #[test]
    fn preserves_top_level_php_functions_and_direct_calls() {
        let facts = parse_native_php_facts(
            "src/checkout.php",
            "<?php\nfunction checkout(string $id): bool {\n  return recordCheckout($id);\n}\nfunction recordCheckout(string $id): bool { return $id !== ''; }\ncheckout('fixture-order');\n",
        )
        .expect("PHP files have a strict native parser");

        assert_eq!(facts.parser, "tree-sitter-php");
        assert_eq!(facts.structural.symbols.len(), 2);
        assert_eq!(facts.structural.calls.len(), 2);
        assert_eq!(facts.structural.calls[0].name, "recordCheckout");
        assert_eq!(
            facts.structural.calls[0]
                .source
                .as_ref()
                .map(|source| source.name.as_str()),
            Some("checkout")
        );
        assert_eq!(facts.structural.calls[1].evidence.range.end.column, 27);
    }

    #[test]
    fn preserves_php_types_methods_imports_and_calls_from_methods() {
        let facts = parse_native_php_facts(
            "src/OrdersService.php",
            "<?php\nnamespace App\\Services;\nuse App\\Support\\Audit;\nuse Vendor\\Queue as Jobs;\nclass OrdersService { public function submit(string $id): void { record($id); Audit::record($id); Jobs::push($id); } private function save(string $id): void {} }\ninterface Persists { public function persist(): void; }\ntrait HasAudit { public function audit(): void {} }\nenum QueueState { case Ready; }\nfunction record(string $id): string { return $id; }\n",
        )
        .expect("PHP files have a strict native parser");

        assert_eq!(facts.structural.imports.len(), 2);
        assert_eq!(facts.structural.imports[0].specifier, "App\\Support\\Audit");
        assert_eq!(facts.structural.imports[1].specifier, "Vendor\\Queue");
        assert_eq!(facts.structural.symbols.len(), 5);
        assert_eq!(facts.structural.symbols[0].name, "OrdersService");
        assert_eq!(facts.structural.symbols[0].methods, ["submit", "save"]);
        assert!(
            facts
                .structural
                .symbols
                .iter()
                .any(|symbol| symbol.name == "Persists")
        );
        assert!(facts.structural.calls.iter().any(|call| {
            call.name == "record"
                && call
                    .source
                    .as_ref()
                    .is_some_and(|owner| owner.name == "OrdersService")
        }));
    }
}
