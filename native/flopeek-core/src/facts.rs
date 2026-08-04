use crate::inventory::scan_native_inventory;
use crate::project_identity::ProjectIdentity;
use crate::source_text::read_source_text;
use crate::store::open_native_store;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use syn::visit::{self, Visit};
use syn::{Expr, ExprPath, File, ImplItem, Item, TraitItem, UseTree};

pub const NATIVE_RUST_FACTS_SCHEMA: &str = "flopeek-native-rust-facts/v1";
pub const NATIVE_RUST_ADAPTER_VERSION: &str = "native-rust-syn/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRustBinding {
    pub local_name: String,
    pub exported_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRustImport {
    pub specifier: String,
    pub standard: bool,
    pub internal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<NativeRustBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRustSymbol {
    pub kind: String,
    pub name: String,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRustImportedTarget {
    pub specifier: String,
    pub exported_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRustCall {
    pub name: String,
    pub source_kind: String,
    pub source_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported: Option<NativeRustImportedTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRustFacts {
    pub schema_version: String,
    pub parser: String,
    pub status: String,
    pub diagnostics: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub imports: Vec<NativeRustImport>,
    pub symbols: Vec<NativeRustSymbol>,
    pub calls: Vec<NativeRustCall>,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRustFactsStatus {
    pub project_root: PathBuf,
    pub project_identity: ProjectIdentity,
    pub adapter_version: String,
    pub parsed_files: usize,
    pub reused_files: usize,
    pub failed_files: usize,
    pub removed_facts: usize,
    pub facts: BTreeMap<String, NativeRustFacts>,
}

fn import_fact(segments: &[String], binding: Option<NativeRustBinding>) -> NativeRustImport {
    let first = segments.first().map(String::as_str).unwrap_or_default();
    NativeRustImport {
        specifier: segments.join("::"),
        standard: matches!(first, "std" | "core" | "alloc"),
        internal: matches!(first, "crate" | "self" | "super"),
        binding,
    }
}

fn use_facts(tree: &UseTree, prefix: &[String], output: &mut Vec<NativeRustImport>) {
    match tree {
        UseTree::Path(path) => {
            let mut next = prefix.to_vec();
            next.push(path.ident.to_string());
            use_facts(&path.tree, &next, output);
        }
        UseTree::Name(name) => {
            let mut segments = prefix.to_vec();
            segments.push(name.ident.to_string());
            let exported_name = name.ident.to_string();
            output.push(import_fact(
                &segments,
                Some(NativeRustBinding {
                    local_name: exported_name.clone(),
                    exported_name,
                }),
            ));
        }
        UseTree::Rename(rename) => {
            let mut segments = prefix.to_vec();
            segments.push(rename.ident.to_string());
            output.push(import_fact(
                &segments,
                Some(NativeRustBinding {
                    local_name: rename.rename.to_string(),
                    exported_name: rename.ident.to_string(),
                }),
            ));
        }
        UseTree::Glob(_) => {
            let mut segments = prefix.to_vec();
            segments.push("*".to_string());
            if segments.len() > 1 {
                output.push(import_fact(&segments, None));
            }
        }
        UseTree::Group(group) => {
            for item in &group.items {
                use_facts(item, prefix, output);
            }
        }
    }
}

fn type_name(ty: &syn::Type) -> Option<String> {
    match ty {
        syn::Type::Path(path) if path.qself.is_none() => path
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string()),
        _ => None,
    }
}

fn direct_identifier(path: &ExprPath) -> Option<String> {
    if path.qself.is_none() && path.path.segments.len() == 1 {
        path.path
            .segments
            .first()
            .map(|segment| segment.ident.to_string())
    } else {
        None
    }
}

fn ensure_type_symbol(
    symbols: &mut Vec<NativeRustSymbol>,
    indices: &mut BTreeMap<String, usize>,
    name: String,
) -> usize {
    if let Some(index) = indices.get(&name) {
        return *index;
    }
    let index = symbols.len();
    symbols.push(NativeRustSymbol {
        kind: "class".to_string(),
        name: name.clone(),
        methods: Vec::new(),
    });
    indices.insert(name, index);
    index
}

fn append_method(methods: &mut Vec<String>, name: String) {
    if !methods.contains(&name) {
        methods.push(name);
    }
}

struct CallVisitor<'a> {
    local_functions: &'a BTreeSet<String>,
    imported_bindings: &'a BTreeMap<String, NativeRustImportedTarget>,
    source_kind: &'a str,
    source_name: &'a str,
    calls: &'a mut Vec<NativeRustCall>,
}

impl Visit<'_> for CallVisitor<'_> {
    fn visit_expr_call(&mut self, node: &syn::ExprCall) {
        if let Expr::Path(path) = node.func.as_ref()
            && let Some(name) = direct_identifier(path)
            && (self.local_functions.contains(&name) || self.imported_bindings.contains_key(&name))
        {
            self.calls.push(NativeRustCall {
                name: name.clone(),
                source_kind: self.source_kind.to_string(),
                source_name: self.source_name.to_string(),
                imported: self.imported_bindings.get(&name).cloned(),
            });
        }
        visit::visit_expr_call(self, node);
    }

    fn visit_expr_closure(&mut self, _node: &syn::ExprClosure) {}
}

fn parse_rust_file(content: &str) -> NativeRustFacts {
    let parsed: File = match syn::parse_file(content) {
        Ok(parsed) => parsed,
        Err(error) => {
            return NativeRustFacts {
                schema_version: NATIVE_RUST_FACTS_SCHEMA.to_string(),
                parser: "syn".to_string(),
                status: "parse-failed".to_string(),
                diagnostics: 1,
                error: Some(error.to_string()),
                imports: Vec::new(),
                symbols: Vec::new(),
                calls: Vec::new(),
                methods: Vec::new(),
            };
        }
    };
    let mut imports = Vec::new();
    let mut type_symbols = Vec::new();
    let mut type_indices = BTreeMap::new();
    let mut functions = Vec::new();
    for item in &parsed.items {
        match item {
            Item::Use(item) => use_facts(&item.tree, &[], &mut imports),
            Item::Struct(item) => {
                ensure_type_symbol(&mut type_symbols, &mut type_indices, item.ident.to_string());
            }
            Item::Enum(item) => {
                ensure_type_symbol(&mut type_symbols, &mut type_indices, item.ident.to_string());
            }
            Item::Trait(item) => {
                let index = ensure_type_symbol(
                    &mut type_symbols,
                    &mut type_indices,
                    item.ident.to_string(),
                );
                for member in &item.items {
                    if let TraitItem::Fn(method) = member {
                        append_method(
                            &mut type_symbols[index].methods,
                            method.sig.ident.to_string(),
                        );
                    }
                }
            }
            Item::Union(item) => {
                ensure_type_symbol(&mut type_symbols, &mut type_indices, item.ident.to_string());
            }
            Item::Impl(item) => {
                if let Some(name) = type_name(item.self_ty.as_ref())
                    && let Some(index) = type_indices.get(&name)
                {
                    for member in &item.items {
                        if let ImplItem::Fn(method) = member {
                            append_method(
                                &mut type_symbols[*index].methods,
                                method.sig.ident.to_string(),
                            );
                        }
                    }
                }
            }
            Item::Fn(item) => functions.push(item),
            _ => {}
        }
    }
    let imported_bindings = imports
        .iter()
        .filter_map(|import| {
            import.binding.as_ref().map(|binding| {
                (
                    binding.local_name.clone(),
                    NativeRustImportedTarget {
                        specifier: import.specifier.clone(),
                        exported_name: binding.exported_name.clone(),
                    },
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    let local_functions = functions
        .iter()
        .map(|item| item.sig.ident.to_string())
        .collect::<BTreeSet<_>>();
    let mut calls = Vec::new();
    for item in &functions {
        let name = item.sig.ident.to_string();
        CallVisitor {
            local_functions: &local_functions,
            imported_bindings: &imported_bindings,
            source_kind: "function",
            source_name: &name,
            calls: &mut calls,
        }
        .visit_block(&item.block);
    }
    for item in &parsed.items {
        let Item::Impl(implementation) = item else {
            continue;
        };
        let Some(name) = type_name(implementation.self_ty.as_ref()) else {
            continue;
        };
        if !type_indices.contains_key(&name) {
            continue;
        }
        for member in &implementation.items {
            if let ImplItem::Fn(method) = member {
                CallVisitor {
                    local_functions: &local_functions,
                    imported_bindings: &imported_bindings,
                    source_kind: "class",
                    source_name: &name,
                    calls: &mut calls,
                }
                .visit_block(&method.block);
            }
        }
    }
    let mut symbols = type_symbols;
    symbols.extend(functions.iter().map(|item| NativeRustSymbol {
        kind: "function".to_string(),
        name: item.sig.ident.to_string(),
        methods: Vec::new(),
    }));
    let mut methods = Vec::new();
    for method in symbols
        .iter()
        .filter(|symbol| symbol.kind == "class")
        .flat_map(|symbol| symbol.methods.iter().cloned())
    {
        if methods.len() == 12 {
            break;
        }
        append_method(&mut methods, method);
    }
    NativeRustFacts {
        schema_version: NATIVE_RUST_FACTS_SCHEMA.to_string(),
        parser: "syn".to_string(),
        status: "parsed".to_string(),
        diagnostics: 0,
        error: None,
        imports,
        symbols,
        calls,
        methods,
    }
}

pub fn scan_native_rust_facts(input_root: &Path) -> Result<NativeRustFactsStatus, String> {
    let inventory = scan_native_inventory(input_root)?;
    let project_root = inventory.project_root.clone();
    let project_identity = inventory.project_identity.clone();
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
            .filter(|(path, _)| path.to_ascii_lowercase().ends_with(".rs"))
            .collect::<Vec<_>>()
    };
    let mut parsed_files = 0;
    let mut reused_files = 0;
    let mut failed_files = 0;
    let mut facts = BTreeMap::new();
    for (path, source_hash) in &candidates {
        let cached = connection
            .query_row(
                "SELECT payload_json FROM parser_facts
                 WHERE project_pk = ?1 AND path = ?2 AND source_hash = ?3 AND adapter_version = ?4",
                params![project_pk, path, source_hash, NATIVE_RUST_ADAPTER_VERSION],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let fact = if let Some(payload) = cached {
            reused_files += 1;
            serde_json::from_str(&payload).map_err(|error| {
                format!("Invalid cached native Rust parser fact for {path}: {error}")
            })?
        } else {
            parsed_files += 1;
            let content = read_source_text(project_root.join(path))
                .map_err(|error| format!("Unable to read Rust source {path}: {error}"))?;
            let parsed = parse_rust_file(&content);
            connection
                .execute(
                    "DELETE FROM parser_facts
                     WHERE project_pk = ?1 AND path = ?2 AND adapter_version = ?3 AND source_hash != ?4",
                    params![project_pk, path, NATIVE_RUST_ADAPTER_VERSION, source_hash],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT INTO parser_facts(project_pk, path, source_hash, adapter_version, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(project_pk, path, source_hash, adapter_version)
                     DO UPDATE SET payload_json = excluded.payload_json",
                    params![project_pk, path, source_hash, NATIVE_RUST_ADAPTER_VERSION, serde_json::to_string(&parsed).map_err(|error| error.to_string())?],
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
            params![project_pk, NATIVE_RUST_ADAPTER_VERSION],
        )
        .map_err(|error| error.to_string())?;
    Ok(NativeRustFactsStatus {
        project_root,
        project_identity,
        adapter_version: NATIVE_RUST_ADAPTER_VERSION.to_string(),
        parsed_files,
        reused_files,
        failed_files,
        removed_facts,
        facts,
    })
}

#[cfg(test)]
mod tests {
    use super::{NATIVE_RUST_FACTS_SCHEMA, scan_native_rust_facts};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_root() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "flopeek-native-rust-facts-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn parses_and_reuses_bounded_rust_facts() {
        let root = temporary_root();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/orders.rs"),
            "use crate::service::validate;\nstruct Orders;\ntrait Persists { fn persist(&self); }\nimpl Orders { fn submit(&self) { validate(); } }\nfn validate() {}\n",
        )
        .unwrap();
        let first = scan_native_rust_facts(&root).unwrap();
        let facts = first.facts.get("src/orders.rs").unwrap();
        assert_eq!(facts.schema_version, NATIVE_RUST_FACTS_SCHEMA);
        assert_eq!(facts.status, "parsed");
        assert_eq!(facts.symbols[0].name, "Orders");
        assert!(facts.symbols.iter().any(|symbol| symbol.name == "Persists"));
        assert_eq!(facts.calls.len(), 1);
        assert_eq!(first.parsed_files, 1);
        let second = scan_native_rust_facts(&root).unwrap();
        assert_eq!(second.parsed_files, 0);
        assert_eq!(second.reused_files, 1);
        fs::write(
            root.join("src/orders.rs"),
            "struct Orders;\nimpl Orders { fn submit(&self) {} }\nfn validate() {}\n",
        )
        .unwrap();
        let changed = scan_native_rust_facts(&root).unwrap();
        assert_eq!(changed.parsed_files, 1);
        assert_eq!(changed.reused_files, 0);
        fs::remove_file(root.join("src/orders.rs")).unwrap();
        let removed = scan_native_rust_facts(&root).unwrap();
        assert_eq!(removed.removed_facts, 1);
        fs::remove_dir_all(root).unwrap();
    }
}
