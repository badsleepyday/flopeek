use crate::facts::{NativeRustFacts, NativeRustFactsStatus, scan_native_rust_facts};
use crate::project_identity::ProjectIdentity;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const NATIVE_RUST_GRAPH_SCHEMA: &str = "flopeek-native-rust-graph-shadow/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeRustGraphNode {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeRustGraphEdge {
    #[serde(rename = "type")]
    pub edge_type: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRustGraphStatus {
    pub project_root: PathBuf,
    pub project_identity: ProjectIdentity,
    pub parsed_files: usize,
    pub reused_files: usize,
    pub failed_files: usize,
    pub nodes: Vec<NativeRustGraphNode>,
    pub edges: Vec<NativeRustGraphEdge>,
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().map(|value| {
        value
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    })
}

fn nearest_cargo_package(root: &Path, source: &str) -> Option<PathBuf> {
    let mut directory = root.join(source).parent()?.to_path_buf();
    loop {
        if directory.join("Cargo.toml").is_file() {
            return Some(directory);
        }
        if directory == root {
            return None;
        }
        directory = directory.parent()?.to_path_buf();
    }
}

fn rust_module_path(source_root: &Path, source: &Path) -> Option<Vec<String>> {
    let relative = source.strip_prefix(source_root).ok()?;
    let mut parts = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let filename = parts.pop()?;
    if matches!(filename.as_str(), "lib.rs" | "main.rs" | "mod.rs") {
        return Some(parts);
    }
    if parts.len() == 1 && parts[0] == "bin" && filename.ends_with(".rs") {
        return Some(Vec::new());
    }
    parts.push(filename.trim_end_matches(".rs").to_string());
    Some(parts)
}

fn resolve_module(root: &Path, source_root: &Path, segments: &[String]) -> Option<String> {
    for length in (1..=segments.len()).rev() {
        let base = segments[..length]
            .iter()
            .fold(source_root.to_path_buf(), |path, segment| {
                path.join(segment)
            });
        for candidate in [base.with_extension("rs"), base.join("mod.rs")] {
            if candidate.is_file() {
                return relative(root, &candidate);
            }
        }
    }
    None
}

fn resolve_internal_import(root: &Path, source: &str, specifier: &str) -> Option<String> {
    let segments = specifier
        .split("::")
        .filter(|segment| !segment.is_empty() && *segment != "*")
        .map(str::to_string)
        .collect::<Vec<_>>();
    if segments.is_empty() || !matches!(segments[0].as_str(), "crate" | "self" | "super") {
        return None;
    }
    let package = nearest_cargo_package(root, source)?;
    let source_root = package.join("src");
    if !source_root.is_dir() {
        return None;
    }
    let target = if segments[0] == "crate" {
        segments[1..].to_vec()
    } else {
        let mut current = rust_module_path(&source_root, &root.join(source))?;
        let mut index = 0;
        if segments.get(index).is_some_and(|segment| segment == "self") {
            index += 1;
        }
        while segments
            .get(index)
            .is_some_and(|segment| segment == "super")
        {
            current.pop()?;
            index += 1;
        }
        current.extend_from_slice(&segments[index..]);
        current
    };
    resolve_module(root, &source_root, &target)
}

fn function_id(path: &str, name: &str) -> String {
    format!("symbol:{path}:function:{name}")
}

fn class_id(path: &str, name: &str) -> String {
    format!("symbol:{path}:class:{name}")
}

fn add_node(nodes: &mut BTreeMap<String, NativeRustGraphNode>, node: NativeRustGraphNode) {
    nodes.entry(node.id.clone()).or_insert(node);
}

fn add_edge(
    edges: &mut BTreeSet<(String, String, String)>,
    edge_type: &str,
    source: String,
    target: String,
) {
    edges.insert((edge_type.to_string(), source, target));
}

fn build_graph(
    root: &Path,
    facts: &BTreeMap<String, NativeRustFacts>,
) -> (Vec<NativeRustGraphNode>, Vec<NativeRustGraphEdge>) {
    let mut nodes = BTreeMap::new();
    let mut edges = BTreeSet::new();
    let functions = facts
        .iter()
        .map(|(path, fact)| {
            (
                path.clone(),
                fact.symbols
                    .iter()
                    .filter(|symbol| symbol.kind == "function")
                    .map(|symbol| symbol.name.clone())
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for (path, fact) in facts {
        let file_id = format!("file:{path}");
        add_node(
            &mut nodes,
            NativeRustGraphNode {
                id: file_id.clone(),
                kind: "file".to_string(),
                path: Some(path.clone()),
            },
        );
        for symbol in &fact.symbols {
            let id = if symbol.kind == "class" {
                class_id(path, &symbol.name)
            } else {
                function_id(path, &symbol.name)
            };
            add_node(
                &mut nodes,
                NativeRustGraphNode {
                    id: id.clone(),
                    kind: symbol.kind.clone(),
                    path: Some(path.clone()),
                },
            );
            add_edge(&mut edges, "contains", file_id.clone(), id);
        }
        for imported in &fact.imports {
            if imported.standard {
                continue;
            }
            if imported.internal {
                if let Some(target) = resolve_internal_import(root, path, &imported.specifier) {
                    add_edge(
                        &mut edges,
                        "imports",
                        file_id.clone(),
                        format!("file:{target}"),
                    );
                }
            } else if let Some(package) = imported.specifier.split("::").next() {
                let id = format!("external:{package}");
                add_node(
                    &mut nodes,
                    NativeRustGraphNode {
                        id: id.clone(),
                        kind: "external".to_string(),
                        path: None,
                    },
                );
                add_edge(&mut edges, "imports", file_id.clone(), id);
            }
        }
        for call in &fact.calls {
            let source = if call.source_kind == "class" {
                class_id(path, &call.source_name)
            } else {
                function_id(path, &call.source_name)
            };
            let target = if functions
                .get(path)
                .is_some_and(|names| names.contains(&call.name))
            {
                Some(function_id(path, &call.name))
            } else if let Some(imported) = &call.imported {
                resolve_internal_import(root, path, &imported.specifier).and_then(|target_path| {
                    functions
                        .get(&target_path)
                        .filter(|names| names.contains(&imported.exported_name))
                        .map(|_| function_id(&target_path, &imported.exported_name))
                })
            } else {
                None
            };
            if let Some(target) = target {
                add_edge(&mut edges, "calls", source, target);
            }
        }
    }
    (
        nodes.into_values().collect(),
        edges
            .into_iter()
            .map(|(edge_type, source, target)| NativeRustGraphEdge {
                edge_type,
                source,
                target,
            })
            .collect(),
    )
}

pub fn scan_native_rust_graph(input_root: &Path) -> Result<NativeRustGraphStatus, String> {
    let facts: NativeRustFactsStatus = scan_native_rust_facts(input_root)?;
    let (nodes, edges) = build_graph(&facts.project_root, &facts.facts);
    Ok(NativeRustGraphStatus {
        project_root: facts.project_root,
        project_identity: facts.project_identity,
        parsed_files: facts.parsed_files,
        reused_files: facts.reused_files,
        failed_files: facts.failed_files,
        nodes,
        edges,
    })
}

#[cfg(test)]
mod tests {
    use super::scan_native_rust_graph;
    use std::fs;

    #[test]
    fn resolves_crate_imports_and_direct_calls_into_shadow_edges() {
        let root =
            std::env::temp_dir().join(format!("flopeek-native-rust-graph-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"graph\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "mod helpers; use crate::helpers::parse; pub fn run() { parse(); }\n",
        )
        .unwrap();
        fs::write(root.join("src/helpers.rs"), "pub fn parse() {}\n").unwrap();
        let graph = scan_native_rust_graph(&root).unwrap();
        assert!(graph.edges.iter().any(|edge| edge.edge_type == "imports"
            && edge.source == "file:src/lib.rs"
            && edge.target == "file:src/helpers.rs"));
        assert!(graph.edges.iter().any(|edge| edge.edge_type == "calls"
            && edge.source == "symbol:src/lib.rs:function:run"
            && edge.target == "symbol:src/helpers.rs:function:parse"));
        fs::remove_dir_all(root).unwrap();
    }
}
