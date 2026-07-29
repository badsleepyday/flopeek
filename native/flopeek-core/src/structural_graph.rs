use crate::identity::{
    public_endpoint_node_id, public_external_node_id, public_file_node_id,
    public_framework_command_node_id, public_package_command_node_id, public_runtime_node_id,
    public_schedule_node_id, public_symbol_node_id,
};
use crate::protocol::STRUCTURAL_FACT_BATCH_SCHEMA;
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale_core::locale;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock};

pub const STRUCTURAL_GRAPH_SCHEMA: &str = "flopeek-native-structural-graph-shadow/v1";

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralGraphNode {
    pub id: String,
    pub kind: String,
    pub node_type: String,
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// The compatibility projection still exposes string IDs at the JSON boundary,
// but graph assembly must not carry those long IDs once per edge.  Keep one
// interned public spelling per node and use compact, contiguous IDs for the
// internal adjacency set.  This is deliberately private: it is a memory-layout
// improvement, not a new public graph schema.
#[derive(Debug)]
struct CompactStructuralGraphNode {
    kind: Arc<str>,
    node_type: Arc<str>,
    path: Option<Arc<str>>,
    metadata: Option<CompactNodeMetadata>,
}

// The public contract accepts metadata as JSON, but its common fields are
// stable strings repeated across every file/symbol descendant. Keep those
// typed and interned in the arena; retain only genuinely open-ended payloads
// (evidence, contracts, adapter additions) as JSON until the boundary.
#[derive(Debug)]
struct CompactNodeMetadata {
    stable: BTreeMap<&'static str, Arc<str>>,
    methods: Option<Vec<Arc<str>>>,
    remainder: serde_json::Map<String, Value>,
}

impl CompactNodeMetadata {
    fn from_value(value: Value, intern: &mut BTreeMap<Arc<str>, Arc<str>>) -> Self {
        let mut remainder = match value {
            Value::Object(object) => object,
            other => {
                let mut object = serde_json::Map::new();
                object.insert("_nativeMetadata".to_string(), other);
                object
            }
        };
        let mut stable = BTreeMap::new();
        for field in [
            "domain",
            "feature",
            "layer",
            "sourceScope",
            "language",
            "label",
            "detectedResponsibility",
            "handlerId",
            "handlerBinding",
        ] {
            if let Some(value) = remainder.remove(field) {
                match value {
                    Value::String(value) => {
                        let interned = CompactStructuralGraph::intern(intern, &value);
                        stable.insert(field, interned);
                    }
                    other => {
                        remainder.insert(field.to_string(), other);
                    }
                }
            }
        }
        let methods = match remainder.remove("methods") {
            Some(Value::Array(values)) => {
                match values.iter().map(Value::as_str).collect::<Option<Vec<_>>>() {
                    Some(values) => Some(
                        values
                            .into_iter()
                            .map(|value| CompactStructuralGraph::intern(intern, value))
                            .collect(),
                    ),
                    None => {
                        remainder.insert("methods".to_string(), Value::Array(values));
                        None
                    }
                }
            }
            Some(other) => {
                remainder.insert("methods".to_string(), other);
                None
            }
            None => None,
        };
        Self {
            stable,
            methods,
            remainder,
        }
    }

    fn into_value(self) -> Value {
        let mut value = self.remainder;
        for (field, item) in self.stable {
            value.insert(field.to_string(), Value::String(item.to_string()));
        }
        if let Some(methods) = self.methods {
            value.insert(
                "methods".to_string(),
                Value::Array(
                    methods
                        .into_iter()
                        .map(|item| Value::String(item.to_string()))
                        .collect(),
                ),
            );
        }
        Value::Object(value)
    }

    fn insert_dynamic(&mut self, key: String, value: Value) {
        self.remainder.insert(key, value);
    }
}

#[derive(Debug, Default)]
struct CompactStructuralGraph {
    node_by_public_id: BTreeMap<Arc<str>, u32>,
    public_node_ids: Vec<Arc<str>>,
    nodes: Vec<CompactStructuralGraphNode>,
    node_kind_intern: BTreeMap<Arc<str>, Arc<str>>,
    node_type_intern: BTreeMap<Arc<str>, Arc<str>>,
    path_intern: BTreeMap<Arc<str>, Arc<str>>,
    metadata_string_intern: BTreeMap<Arc<str>, Arc<str>>,
    // Edge kinds repeat far more often than nodes in a repository graph. Keep
    // one interned spelling per kind while numeric endpoints stay contiguous.
    edge_type_intern: BTreeMap<Arc<str>, Arc<str>>,
    edges: BTreeSet<(u32, u32, Arc<str>)>,
}

impl CompactStructuralGraph {
    fn intern(table: &mut BTreeMap<Arc<str>, Arc<str>>, value: &str) -> Arc<str> {
        table.get(value).cloned().unwrap_or_else(|| {
            let interned: Arc<str> = Arc::from(value);
            table.insert(interned.clone(), interned.clone());
            interned
        })
    }

    fn insert_node(
        &mut self,
        id: String,
        kind: &str,
        node_type: &str,
        path: Option<&str>,
        metadata: Option<Value>,
    ) {
        if self.node_by_public_id.contains_key(id.as_str()) {
            return;
        }
        let compact_id = u32::try_from(self.nodes.len())
            .expect("native structural graph exceeds u32 node capacity");
        let public_id: Arc<str> = Arc::from(id);
        self.node_by_public_id.insert(public_id.clone(), compact_id);
        self.public_node_ids.push(public_id);
        self.nodes.push(CompactStructuralGraphNode {
            kind: Self::intern(&mut self.node_kind_intern, kind),
            node_type: Self::intern(&mut self.node_type_intern, node_type),
            path: path.map(|path| Self::intern(&mut self.path_intern, path)),
            metadata: metadata.map(|value| {
                CompactNodeMetadata::from_value(value, &mut self.metadata_string_intern)
            }),
        });
    }

    fn contains_node(&self, id: &str) -> bool {
        self.node_by_public_id.contains_key(id)
    }

    fn insert_edge(&mut self, source: &str, target: &str, edge_type: &str) {
        let Some(&source) = self.node_by_public_id.get(source) else {
            return;
        };
        let Some(&target) = self.node_by_public_id.get(target) else {
            return;
        };
        let edge_type = Self::intern(&mut self.edge_type_intern, edge_type);
        self.edges.insert((source, target, edge_type));
    }

    fn into_public_parts(self) -> (Vec<StructuralGraphNode>, Vec<StructuralGraphEdge>) {
        let edges = self
            .edges
            .into_iter()
            .map(|(source, target, edge_type)| StructuralGraphEdge {
                source: self.public_node_ids[source as usize].to_string(),
                target: self.public_node_ids[target as usize].to_string(),
                edge_type: edge_type.to_string(),
                confidence: None,
                evidence: None,
            })
            .collect::<Vec<_>>();
        let nodes = self
            .public_node_ids
            .into_iter()
            .zip(self.nodes)
            .map(|(id, node)| StructuralGraphNode {
                id: id.to_string(),
                kind: node.kind.to_string(),
                node_type: node.node_type.to_string(),
                path: node.path.map(|path| path.to_string()),
                metadata: node.metadata.map(CompactNodeMetadata::into_value),
            })
            .collect::<Vec<_>>();
        (nodes, edges)
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct StructuralGraphEdge {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Value>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StructuralGraphProjection {
    pub schema_version: &'static str,
    pub nodes: Vec<StructuralGraphNode>,
    pub edges: Vec<StructuralGraphEdge>,
    pub canonical_json: String,
    pub limitation: &'static str,
}

#[derive(Debug, Deserialize)]
pub struct StructuralGraphSnapshot {
    pub nodes: Vec<StructuralGraphNode>,
    pub edges: Vec<StructuralGraphEdge>,
}

pub fn structural_graph_snapshot(value: &Value) -> Result<StructuralGraphSnapshot, String> {
    serde_json::from_value(value.clone())
        .map_err(|error| format!("Stored native structural graph is invalid: {error}"))
}

fn edge_key(edge: &StructuralGraphEdge) -> (String, String, String) {
    (
        edge.source.clone(),
        edge.target.clone(),
        edge.edge_type.clone(),
    )
}

/// Produce the bounded, source-safe delta used only by the native structural
/// shadow store. It deliberately retains structural facts rather than claiming
/// public graph or Flow Lens parity; JavaScript remains that compatibility oracle.
pub fn structural_graph_delta(
    project_id: &str,
    from_graph_version: i64,
    to_graph_version: i64,
    previous: &StructuralGraphSnapshot,
    current: &StructuralGraphSnapshot,
) -> Value {
    let previous_nodes = previous
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let current_nodes = current
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let previous_edges = previous
        .edges
        .iter()
        .map(|edge| (edge_key(edge), edge))
        .collect::<BTreeMap<_, _>>();
    let current_edges = current
        .edges
        .iter()
        .map(|edge| (edge_key(edge), edge))
        .collect::<BTreeMap<_, _>>();
    let added_nodes = current_nodes
        .iter()
        .filter(|(id, _)| !previous_nodes.contains_key(**id))
        .map(|(_, node)| serde_json::to_value(*node).expect("structural node serializes"))
        .collect::<Vec<_>>();
    let removed_nodes = previous_nodes
        .iter()
        .filter(|(id, _)| !current_nodes.contains_key(**id))
        .map(|(_, node)| serde_json::to_value(*node).expect("structural node serializes"))
        .collect::<Vec<_>>();
    let changed_nodes = current_nodes
        .iter()
        .filter(|(id, node)| {
            previous_nodes
                .get(**id)
                .is_some_and(|previous| *previous != **node)
        })
        .map(|(_, node)| serde_json::to_value(*node).expect("structural node serializes"))
        .collect::<Vec<_>>();
    let added_edges = current_edges
        .iter()
        .filter(|(key, _)| !previous_edges.contains_key(*key))
        .map(|(_, edge)| serde_json::to_value(*edge).expect("structural edge serializes"))
        .collect::<Vec<_>>();
    let removed_edges = previous_edges
        .iter()
        .filter(|(key, _)| !current_edges.contains_key(*key))
        .map(|(_, edge)| serde_json::to_value(*edge).expect("structural edge serializes"))
        .collect::<Vec<_>>();
    let changed_edges = current_edges
        .iter()
        .filter(|(key, edge)| {
            previous_edges
                .get(*key)
                .is_some_and(|previous| *previous != **edge)
        })
        .map(|(_, edge)| serde_json::to_value(*edge).expect("structural edge serializes"))
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": "flopeek-native-structural-delta-shadow/v1",
        "projectId": project_id,
        "fromGraphVersion": from_graph_version,
        "toGraphVersion": to_graph_version,
        "nodes": { "added": added_nodes, "removed": removed_nodes, "changed": changed_nodes },
        "edges": { "added": added_edges, "removed": removed_edges, "changed": changed_edges },
        "limitation": "This is a source-safe native structural shadow delta. It is not the public Flopeek graph delta, Flow Lens delta, runtime trace, or changed-context result.",
    })
}

fn required<'a>(value: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| format!("StructuralFactBatch/v1 requires {key}."))
}

fn optional<'a>(value: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
}

fn insert_node_with_metadata(
    graph: &mut CompactStructuralGraph,
    id: String,
    kind: &str,
    node_type: &str,
    path: Option<&str>,
    metadata: Option<Value>,
) {
    graph.insert_node(id, kind, node_type, path, metadata);
}

fn insert_edge(
    graph: &mut CompactStructuralGraph,
    source: impl AsRef<str>,
    target: impl AsRef<str>,
    edge_type: &str,
) {
    graph.insert_edge(source.as_ref(), target.as_ref(), edge_type);
}

fn symbol_metadata(
    file_metadata: Option<&Value>,
    symbol: &serde_json::Map<String, Value>,
    symbol_type: &str,
    symbol_name: &str,
) -> Value {
    let mut metadata = serde_json::Map::new();
    for field in ["domain", "feature", "layer", "sourceScope", "language"] {
        if let Some(value) = file_metadata
            .and_then(Value::as_object)
            .and_then(|file| file.get(field))
        {
            metadata.insert(field.to_string(), value.clone());
        }
    }
    metadata.insert("label".to_string(), Value::String(symbol_name.to_string()));
    metadata.insert(
        "detectedResponsibility".to_string(),
        Value::String(
            if symbol_type == "class" {
                "Class declaration extracted from the syntax tree."
            } else {
                "Function declaration extracted from the syntax tree."
            }
            .to_string(),
        ),
    );
    metadata.insert(
        "methods".to_string(),
        symbol
            .get("methods")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    let parser = symbol
        .get("evidence")
        .and_then(Value::as_object)
        .and_then(|evidence| evidence.get("parser"))
        .cloned()
        .unwrap_or_else(|| Value::String("unknown".to_string()));
    let confidence = symbol
        .get("confidence")
        .cloned()
        .unwrap_or_else(|| Value::String("exact".to_string()));
    metadata.insert(
        "analysis".to_string(),
        json!({ "parser": parser, "status": "parsed", "confidence": confidence }),
    );
    if let Some(evidence) = symbol.get("evidence") {
        metadata.insert("evidence".to_string(), evidence.clone());
    }
    Value::Object(metadata)
}

fn endpoint_metadata(
    file_metadata: Option<&Value>,
    endpoint: &serde_json::Map<String, Value>,
    method: &str,
    route: &str,
    target: &str,
    exact_handler: bool,
) -> Value {
    let mut metadata = serde_json::Map::new();
    for field in ["domain", "feature", "layer", "sourceScope"] {
        if let Some(value) = file_metadata
            .and_then(Value::as_object)
            .and_then(|file| file.get(field))
        {
            metadata.insert(field.to_string(), value.clone());
        }
    }
    let handler_binding = if exact_handler {
        "exact-symbol"
    } else {
        "file-fallback"
    };
    metadata.insert(
        "label".to_string(),
        Value::String(format!("{method} {route}")),
    );
    metadata.insert(
        "detectedResponsibility".to_string(),
        endpoint
            .get("detectedResponsibility")
            .cloned()
            .unwrap_or_else(|| {
                Value::String("HTTP endpoint detected by the AST parser.".to_string())
            }),
    );
    metadata.insert("methods".to_string(), Value::Array(Vec::new()));
    let parser = endpoint
        .get("evidence")
        .and_then(Value::as_object)
        .and_then(|evidence| evidence.get("parser"))
        .cloned()
        .unwrap_or_else(|| Value::String("typescript-ast".to_string()));
    let confidence = endpoint
        .get("confidence")
        .cloned()
        .unwrap_or_else(|| Value::String("exact".to_string()));
    metadata.insert(
        "analysis".to_string(),
        json!({ "parser": parser, "status": "parsed", "confidence": confidence, "handlerBinding": handler_binding }),
    );
    metadata.insert(
        "handlerId".to_string(),
        if exact_handler {
            Value::String(target.to_string())
        } else {
            Value::Null
        },
    );
    metadata.insert(
        "handlerBinding".to_string(),
        Value::String(handler_binding.to_string()),
    );
    metadata.insert(
        "contract".to_string(),
        endpoint.get("contract").cloned().unwrap_or(Value::Null),
    );
    if let Some(evidence) = endpoint.get("evidence") {
        metadata.insert("evidence".to_string(), evidence.clone());
    }
    Value::Object(metadata)
}

fn integration_metadata(
    file_metadata: Option<&Value>,
    integration: &serde_json::Map<String, Value>,
    integration_type: &str,
) -> Value {
    let mut metadata = serde_json::Map::new();
    for field in ["domain", "feature", "sourceScope", "language"] {
        if let Some(value) = file_metadata
            .and_then(Value::as_object)
            .and_then(|file| file.get(field))
        {
            metadata.insert(field.to_string(), value.clone());
        }
    }
    metadata.insert(
        "label".to_string(),
        integration
            .get("label")
            .cloned()
            .unwrap_or_else(|| Value::String(integration_type.to_string())),
    );
    metadata.insert("layer".to_string(), Value::String("runtime".to_string()));
    metadata.insert(
        "detectedResponsibility".to_string(),
        Value::String(
            if integration_type == "database" {
                "Database or ORM client initialized from a static import."
            } else {
                "Queue or worker initialized from a static import."
            }
            .to_string(),
        ),
    );
    metadata.insert("methods".to_string(), Value::Array(Vec::new()));
    metadata.insert(
        "analysis".to_string(),
        json!({ "parser": "typescript-ast", "status": "parsed", "confidence": "exact" }),
    );
    if let Some(evidence) = integration.get("evidence") {
        metadata.insert("evidence".to_string(), evidence.clone());
    }
    if let Some(package) = integration.get("package") {
        metadata.insert("package".to_string(), package.clone());
    }
    Value::Object(metadata)
}

type EdgeMetadataFacts = BTreeMap<String, (Option<Value>, Option<Value>)>;

fn edge_metadata_key(source: &str, target: &str, edge_type: &str) -> String {
    format!("{source}\0{target}\0{edge_type}")
}

fn add_edge_metadata(
    facts: &mut EdgeMetadataFacts,
    source: String,
    target: String,
    edge_type: &str,
    confidence: Option<Value>,
    evidence: Option<Value>,
) {
    facts.insert(
        edge_metadata_key(&source, &target, edge_type),
        (confidence, evidence),
    );
}

fn exact_edge_metadata(evidence: Option<&Value>) -> (Option<Value>, Option<Value>) {
    (Some(Value::String("exact".to_string())), evidence.cloned())
}

// Most edge metadata is already attached to the parser fact that creates the
// edge. Reconstruct its key locally instead of receiving a second global map
// whose long source/target IDs and repeated evidence dominate JSONL payloads.
// Entry adapters remain exceptional and are supplied through entryEdgeMetadata.
fn record_edge_metadata(batch: &serde_json::Map<String, Value>) -> EdgeMetadataFacts {
    let mut facts = EdgeMetadataFacts::new();
    let records = batch
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut symbols = BTreeMap::new();
    let mut runtime_nodes = BTreeMap::new();
    let mut endpoints = BTreeMap::new();

    for record in &records {
        let (Some(_record), Some(relative_path), Some(result)) = (
            record.as_object(),
            record
                .as_object()
                .and_then(|record| optional(record, "relativePath")),
            record
                .as_object()
                .and_then(|record| record.get("result"))
                .and_then(Value::as_object),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        for integration in result
            .get("integrations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(integration) = integration.as_object() else {
                continue;
            };
            let (Some(kind), Some(instance)) = (
                optional(integration, "type"),
                optional(integration, "instance"),
            ) else {
                continue;
            };
            let runtime_id = public_runtime_node_id(relative_path, kind, instance);
            runtime_nodes.insert(
                (relative_path.to_string(), instance.to_string()),
                runtime_id.clone(),
            );
            let (confidence, evidence) = exact_edge_metadata(integration.get("evidence"));
            add_edge_metadata(
                &mut facts,
                file_id.clone(),
                runtime_id,
                "initializes",
                confidence,
                evidence,
            );
        }
        for symbol in result
            .get("symbols")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(symbol) = symbol.as_object() else {
                continue;
            };
            let (Some(kind), Some(name)) = (optional(symbol, "type"), optional(symbol, "name"))
            else {
                continue;
            };
            let symbol_id = public_symbol_node_id(relative_path, kind, name);
            symbols.insert(
                (
                    relative_path.to_string(),
                    kind.to_string(),
                    name.to_string(),
                ),
                symbol_id.clone(),
            );
            let confidence = symbol
                .get("confidence")
                .cloned()
                .unwrap_or_else(|| Value::String("exact".to_string()));
            let evidence = symbol.get("evidence").cloned();
            add_edge_metadata(
                &mut facts,
                symbol_id.clone(),
                file_id.clone(),
                "declares",
                Some(confidence.clone()),
                evidence.clone(),
            );
            add_edge_metadata(
                &mut facts,
                file_id.clone(),
                symbol_id,
                "contains",
                Some(confidence),
                evidence,
            );
        }
    }

    let mut introduced_go_packages = BTreeSet::new();
    for record in &records {
        let (Some(_record), Some(relative_path), Some(result)) = (
            record.as_object(),
            record
                .as_object()
                .and_then(|record| optional(record, "relativePath")),
            record
                .as_object()
                .and_then(|record| record.get("result"))
                .and_then(Value::as_object),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        let resolved = result
            .get("resolvedImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some((
                    item.as_object()?.get("specifier")?.as_str()?.to_string(),
                    item.as_object()?.get("targetPath")?.as_str()?.to_string(),
                ))
            })
            .collect::<BTreeMap<_, _>>();
        let packages = result
            .get("resolvedPackages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let item = item.as_object()?;
                Some((item.get("specifier")?.as_str()?.to_string(), item))
            })
            .collect::<BTreeMap<_, _>>();
        let external = result
            .get("externalImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                item.as_object()?
                    .get("specifier")?
                    .as_str()
                    .map(ToString::to_string)
            })
            .collect::<BTreeSet<_>>();
        for imported in result
            .get("imports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(imported) = imported.as_object() else {
                continue;
            };
            if imported.get("standard").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(specifier) = optional(imported, "specifier") else {
                continue;
            };
            let (confidence, evidence) = exact_edge_metadata(imported.get("evidence"));
            if let Some(target_path) = resolved.get(specifier) {
                add_edge_metadata(
                    &mut facts,
                    file_id.clone(),
                    public_file_node_id(target_path),
                    "imports",
                    confidence,
                    evidence,
                );
            } else if let Some(package) = packages.get(specifier) {
                let Some(package_path) = optional(package, "packagePath") else {
                    continue;
                };
                let package_id = format!("go-package:{package_path}");
                if introduced_go_packages.insert(package_path.to_string()) {
                    for path in package
                        .get("files")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        add_edge_metadata(
                            &mut facts,
                            package_id.clone(),
                            public_file_node_id(path),
                            "contains",
                            confidence.clone(),
                            evidence.clone(),
                        );
                    }
                }
                add_edge_metadata(
                    &mut facts,
                    file_id.clone(),
                    package_id,
                    "imports",
                    confidence,
                    evidence,
                );
            } else if external.contains(specifier) {
                add_edge_metadata(
                    &mut facts,
                    file_id.clone(),
                    public_external_node_id(specifier),
                    "uses",
                    confidence,
                    evidence,
                );
            }
        }
        for endpoint in result
            .get("endpoints")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(endpoint) = endpoint.as_object() else {
                continue;
            };
            let (Some(method), Some(route)) =
                (optional(endpoint, "method"), optional(endpoint, "route"))
            else {
                continue;
            };
            let endpoint_id = public_endpoint_node_id(relative_path, method, route);
            let target = optional(endpoint, "handlerName")
                .and_then(|name| {
                    symbols.get(&(
                        relative_path.to_string(),
                        optional(endpoint, "handlerType")
                            .unwrap_or("function")
                            .to_string(),
                        name.to_string(),
                    ))
                })
                .cloned()
                .unwrap_or_else(|| file_id.clone());
            endpoints
                .entry((method.to_string(), route.to_string()))
                .or_insert_with(|| endpoint_id.clone());
            add_edge_metadata(
                &mut facts,
                endpoint_id,
                target,
                "handles",
                Some(endpoint.get("confidence").cloned().unwrap_or_else(|| {
                    Value::String(if optional(endpoint, "handlerName").is_some() {
                        "exact".to_string()
                    } else {
                        "likely".to_string()
                    })
                })),
                endpoint.get("evidence").cloned(),
            );
        }
    }

    for record in &records {
        let (Some(_record), Some(relative_path), Some(result)) = (
            record.as_object(),
            record
                .as_object()
                .and_then(|record| optional(record, "relativePath")),
            record
                .as_object()
                .and_then(|record| record.get("result"))
                .and_then(Value::as_object),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        let resolved = result
            .get("resolvedImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some((
                    item.as_object()?.get("specifier")?.as_str()?.to_string(),
                    item.as_object()?.get("targetPath")?.as_str()?.to_string(),
                ))
            })
            .collect::<BTreeMap<_, _>>();
        let packages = result
            .get("resolvedPackages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let item = item.as_object()?;
                Some((item.get("specifier")?.as_str()?.to_string(), item))
            })
            .collect::<BTreeMap<_, _>>();
        // Source-symbol keys include their path. Keep the closure local to this
        // record so a missing or foreign source retains JS's file fallback.
        let source_id = |fact: &serde_json::Map<String, Value>| {
            fact.get("source")
                .and_then(Value::as_object)
                .and_then(|source| {
                    Some(symbols.get(&(
                        relative_path.to_string(),
                        optional(source, "type")?.to_string(),
                        optional(source, "name")?.to_string(),
                    )))
                })
                .and_then(|candidate| candidate.cloned())
                .unwrap_or_else(|| file_id.clone())
        };
        for call in result
            .get("calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(call) = call.as_object() else {
                continue;
            };
            let Some(name) = optional(call, "name") else {
                continue;
            };
            let imported = call.get("imported").and_then(Value::as_object);
            let target_name = imported
                .and_then(|item| optional(item, "exportedName"))
                .unwrap_or(name);
            let target = imported
                .and_then(|item| optional(item, "specifier"))
                .and_then(|specifier| {
                    if let Some(path) = resolved.get(specifier) {
                        symbols
                            .get(&(
                                path.clone(),
                                "function".to_string(),
                                target_name.to_string(),
                            ))
                            .cloned()
                    } else {
                        let matches = packages
                            .get(specifier)?
                            .get("files")?
                            .as_array()?
                            .iter()
                            .filter_map(|file| {
                                symbols
                                    .get(&(
                                        file.as_str()?.to_string(),
                                        "function".to_string(),
                                        target_name.to_string(),
                                    ))
                                    .cloned()
                            })
                            .collect::<Vec<_>>();
                        (matches.len() == 1).then(|| matches[0].clone())
                    }
                })
                .or_else(|| {
                    symbols
                        .get(&(
                            relative_path.to_string(),
                            "function".to_string(),
                            target_name.to_string(),
                        ))
                        .cloned()
                });
            if let Some(target) = target {
                let (confidence, evidence) = exact_edge_metadata(call.get("evidence"));
                add_edge_metadata(
                    &mut facts,
                    source_id(call),
                    target,
                    "calls",
                    confidence,
                    evidence,
                );
            }
        }
        for action in result
            .get("runtimeActions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(action) = action.as_object() else {
                continue;
            };
            let (Some(instance), Some(kind)) =
                (optional(action, "instance"), optional(action, "type"))
            else {
                continue;
            };
            if let Some(target) =
                runtime_nodes.get(&(relative_path.to_string(), instance.to_string()))
            {
                let (confidence, evidence) = exact_edge_metadata(action.get("evidence"));
                add_edge_metadata(
                    &mut facts,
                    source_id(action),
                    target.clone(),
                    kind,
                    confidence,
                    evidence,
                );
            }
        }
        for request in result
            .get("requests")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(request) = request.as_object() else {
                continue;
            };
            let (Some(method), Some(route)) =
                (optional(request, "method"), optional(request, "route"))
            else {
                continue;
            };
            if let Some(target) = endpoints.get(&(method.to_string(), route.to_string())) {
                let (confidence, evidence) = exact_edge_metadata(request.get("evidence"));
                add_edge_metadata(
                    &mut facts,
                    file_id.clone(),
                    target.clone(),
                    "requests",
                    confidence,
                    evidence,
                );
            }
        }
    }
    facts
}

fn edge_metadata(
    batch: &serde_json::Map<String, Value>,
    facts: &EdgeMetadataFacts,
    source: &str,
    target: &str,
    edge_type: &str,
) -> (Option<Value>, Option<Value>) {
    let key = edge_metadata_key(source, target, edge_type);
    if let Some(metadata) = batch
        .get("edgeMetadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(&key))
        .and_then(Value::as_object)
    {
        return (
            metadata.get("confidence").cloned(),
            metadata.get("evidence").cloned(),
        );
    }
    if let Some(metadata) = facts.get(&key) {
        return metadata.clone();
    }
    let Some(metadata) = batch
        .get("entryEdgeMetadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get(&key))
        .and_then(Value::as_object)
    else {
        return (None, None);
    };
    (
        metadata.get("confidence").cloned(),
        metadata.get("evidence").cloned(),
    )
}

// JavaScript's public compatibility projection orders IDs with
// String#localeCompare. ASCII keeps the established punctuation rules below;
// non-ASCII values use the same ICU collation family as V8's default sort
// locale. This avoids falling back to Unicode scalar ordering for public IDs.
fn javascript_ascii_collation_key(value: &str) -> Vec<u32> {
    value
        .chars()
        .map(|character| match character {
            '_' => 1,
            '-' => 2,
            '.' => 3,
            '/' => 4,
            'A'..='Z' => 100 + character.to_ascii_lowercase() as u32,
            'a'..='z' | '0'..='9' => 100 + character as u32,
            _ if character.is_ascii() => 50 + character as u32,
            _ => 10_000 + character as u32,
        })
        .collect()
}

pub(crate) fn javascript_ascii_cmp(left: &str, right: &str) -> Ordering {
    if !(left.is_ascii() && right.is_ascii())
        && let Some(collator) = javascript_unicode_collator()
    {
        let order = collator.compare(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    javascript_ascii_collation_key(left)
        .cmp(&javascript_ascii_collation_key(right))
        .then_with(|| left.cmp(right))
}

// The public graph sorts human labels with JavaScript String#localeCompare,
// rather than the ID ordering contract above.  For the audited portable-ASCII
// subset, its remaining distinction after case folding is lowercase before
// uppercase (for example, "Prisma client" before "Prisma Client").  Keep
// this separate from public-ID ordering: changing the latter would alter
// canonical node IDs and graph versions.
fn javascript_ascii_locale_case_key(value: &str) -> Vec<u8> {
    value
        .chars()
        .map(|character| match character {
            'a'..='z' => 0,
            'A'..='Z' => 1,
            _ => 0,
        })
        .collect()
}

fn javascript_ascii_locale_collation_key(value: &str) -> Vec<u32> {
    value
        .chars()
        .map(|character| match character {
            // This is intentionally distinct from public-ID ordering. These
            // are the punctuation weights observed from String#localeCompare
            // across the portable-ASCII compatibility corpus.
            ' ' => 1,
            '_' => 2,
            '-' => 3,
            ':' => 4,
            '.' => 5,
            '/' => 6,
            'A'..='Z' => 100 + character.to_ascii_lowercase() as u32,
            'a'..='z' | '0'..='9' => 100 + character as u32,
            _ if character.is_ascii() => 50 + character as u32,
            _ => 10_000 + character as u32,
        })
        .collect()
}

pub(crate) fn javascript_ascii_locale_cmp(left: &str, right: &str) -> Ordering {
    if !(left.is_ascii() && right.is_ascii())
        && let Some(collator) = javascript_unicode_collator()
    {
        let order = collator.compare(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    javascript_ascii_locale_collation_key(left)
        .cmp(&javascript_ascii_locale_collation_key(right))
        .then_with(|| {
            javascript_ascii_locale_case_key(left).cmp(&javascript_ascii_locale_case_key(right))
        })
        .then_with(|| left.cmp(right))
}

fn javascript_unicode_collator() -> Option<&'static CollatorBorrowed<'static>> {
    static COLLATOR: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| Collator::try_new(locale!("en").into(), Default::default()).ok())
        .as_ref()
}

fn traversal_edge_key(source: &str, target: &str, edge_type: &str) -> String {
    format!("{source}\0{target}\0{edge_type}")
}

fn structural_record_result(
    record: &serde_json::Map<String, Value>,
) -> Option<&serde_json::Map<String, Value>> {
    record.get("result").and_then(Value::as_object)
}

fn structural_record_path(record: &serde_json::Map<String, Value>) -> Option<&str> {
    record.get("relativePath").and_then(Value::as_str)
}

/// Reconstruct the JavaScript graph builder's *edge construction phases* from
/// StructuralFactBatch/v1. This deliberately consumes parser and manifest
/// facts, never `graph.edges` ordering. Facts outside the supported structural
/// families remain after the derived sequence in native canonical order; they
/// must gain explicit phase rules and corpus coverage before native default.
pub fn structural_edge_traversal_order(
    batch: &Value,
    graph: &StructuralGraphProjection,
) -> BTreeMap<String, usize> {
    let Some(batch) = batch.as_object() else {
        return BTreeMap::new();
    };
    let Some(records) = batch.get("records").and_then(Value::as_array) else {
        return BTreeMap::new();
    };
    let mut records = records
        .iter()
        .filter_map(Value::as_object)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left.get("recordOrder")
            .and_then(Value::as_u64)
            .cmp(&right.get("recordOrder").and_then(Value::as_u64))
            .then_with(|| {
                javascript_ascii_cmp(
                    left.get("relativePath")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    right
                        .get("relativePath")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
            })
    });
    let available = graph
        .edges
        .iter()
        .map(|edge| traversal_edge_key(&edge.source, &edge.target, &edge.edge_type))
        .collect::<BTreeSet<_>>();
    let mut order = BTreeMap::new();
    let mut add = |source: String, target: String, edge_type: &str| {
        let key = traversal_edge_key(&source, &target, edge_type);
        if available.contains(&key) {
            let index = order.len();
            order.entry(key).or_insert(index);
        }
    };
    // Phase 1: integrations, then declaration and containment edges.
    for record in &records {
        let (Some(relative_path), Some(result)) = (
            structural_record_path(record),
            structural_record_result(record),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        for integration in result
            .get("integrations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(_integration), Some(kind), Some(instance)) = (
                integration.as_object(),
                integration.get("type").and_then(Value::as_str),
                integration.get("instance").and_then(Value::as_str),
            ) else {
                continue;
            };
            add(
                file_id.clone(),
                public_runtime_node_id(relative_path, kind, instance),
                "initializes",
            );
        }
        for symbol in result
            .get("symbols")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(_symbol), Some(kind), Some(name)) = (
                symbol.as_object(),
                symbol.get("type").and_then(Value::as_str),
                symbol.get("name").and_then(Value::as_str),
            ) else {
                continue;
            };
            let symbol_id = public_symbol_node_id(relative_path, kind, name);
            add(symbol_id.clone(), file_id.clone(), "declares");
            add(file_id.clone(), symbol_id, "contains");
        }
    }

    // Phase 2: source-order imports, followed by endpoint bindings.
    for record in &records {
        let (Some(relative_path), Some(result)) = (
            structural_record_path(record),
            structural_record_result(record),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        let resolved = result
            .get("resolvedImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|fact| {
                Some((
                    fact.as_object()?.get("specifier")?.as_str()?.to_string(),
                    fact.as_object()?.get("targetPath")?.as_str()?.to_string(),
                ))
            })
            .collect::<BTreeMap<_, _>>();
        let external = result
            .get("externalImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|fact| {
                Some((
                    fact.as_object()?.get("specifier")?.as_str()?.to_string(),
                    fact.as_object()?.get("specifier")?.as_str()?.to_string(),
                ))
            })
            .collect::<BTreeMap<_, _>>();
        for imported in result
            .get("imports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(imported) = imported.as_object() else {
                continue;
            };
            if imported.get("standard").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(specifier) = imported.get("specifier").and_then(Value::as_str) else {
                continue;
            };
            if let Some(target_path) = resolved.get(specifier) {
                add(file_id.clone(), public_file_node_id(target_path), "imports");
            } else if let Some(external_specifier) = external.get(specifier) {
                add(
                    file_id.clone(),
                    public_external_node_id(external_specifier),
                    "uses",
                );
            }
        }
        for endpoint in result
            .get("endpoints")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(endpoint), Some(method), Some(route)) = (
                endpoint.as_object(),
                endpoint.get("method").and_then(Value::as_str),
                endpoint.get("route").and_then(Value::as_str),
            ) else {
                continue;
            };
            let target = endpoint
                .get("handlerName")
                .and_then(Value::as_str)
                .map(|name| {
                    public_symbol_node_id(
                        relative_path,
                        endpoint
                            .get("handlerType")
                            .and_then(Value::as_str)
                            .unwrap_or("function"),
                        name,
                    )
                })
                .unwrap_or_else(|| file_id.clone());
            add(
                public_endpoint_node_id(relative_path, method, route),
                target,
                "handles",
            );
        }
    }

    // Phase 3: direct calls and runtime actions, record by record.
    for record in &records {
        let (Some(relative_path), Some(result)) = (
            structural_record_path(record),
            structural_record_result(record),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        let resolved = result
            .get("resolvedImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|fact| {
                Some((
                    fact.as_object()?.get("specifier")?.as_str()?.to_string(),
                    fact.as_object()?.get("targetPath")?.as_str()?.to_string(),
                ))
            })
            .collect::<BTreeMap<_, _>>();
        let source_id = |fact: &serde_json::Map<String, Value>| {
            fact.get("source")
                .and_then(Value::as_object)
                .and_then(|source| {
                    Some(public_symbol_node_id(
                        relative_path,
                        source.get("type")?.as_str()?,
                        source.get("name")?.as_str()?,
                    ))
                })
                .unwrap_or_else(|| file_id.clone())
        };
        for call in result
            .get("calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(call) = call.as_object() else {
                continue;
            };
            let Some(name) = call.get("name").and_then(Value::as_str) else {
                continue;
            };
            let imported = call.get("imported").and_then(Value::as_object);
            let target_path = imported
                .and_then(|item| item.get("specifier"))
                .and_then(Value::as_str)
                .and_then(|specifier| resolved.get(specifier).map(String::as_str))
                .unwrap_or(relative_path);
            let target_name = imported
                .and_then(|item| item.get("exportedName"))
                .and_then(Value::as_str)
                .unwrap_or(name);
            add(
                source_id(call),
                public_symbol_node_id(target_path, "function", target_name),
                "calls",
            );
        }
        for action in result
            .get("runtimeActions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(action) = action.as_object() else {
                continue;
            };
            let (Some(instance), Some(action_type)) = (
                action.get("instance").and_then(Value::as_str),
                action.get("type").and_then(Value::as_str),
            ) else {
                continue;
            };
            add(
                source_id(action),
                public_runtime_node_id(relative_path, "database", instance),
                action_type,
            );
            add(
                source_id(action),
                public_runtime_node_id(relative_path, "queue", instance),
                action_type,
            );
        }
    }

    // Phase 4: static HTTP requests.
    for record in &records {
        let (Some(relative_path), Some(result)) = (
            structural_record_path(record),
            structural_record_result(record),
        ) else {
            continue;
        };
        let file_id = public_file_node_id(relative_path);
        for request in result
            .get("requests")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(_request), Some(method), Some(route)) = (
                request.as_object(),
                request.get("method").and_then(Value::as_str),
                request.get("route").and_then(Value::as_str),
            ) else {
                continue;
            };
            // The JavaScript target is the first endpoint node with this label;
            // identical method/route facts are deduplicated by public edge key.
            let endpoint = records.iter().find_map(|candidate| {
                let candidate_path = structural_record_path(candidate)?;
                structural_record_result(candidate)?
                    .get("endpoints")
                    .and_then(Value::as_array)?
                    .iter()
                    .find_map(|endpoint| {
                        let endpoint = endpoint.as_object()?;
                        (endpoint.get("method").and_then(Value::as_str) == Some(method)
                            && endpoint.get("route").and_then(Value::as_str) == Some(route))
                        .then(|| public_endpoint_node_id(candidate_path, method, route))
                    })
            });
            if let Some(endpoint) = endpoint {
                add(file_id.clone(), endpoint, "requests");
            }
        }
    }

    // Phase 5: manifest commands, framework commands, then schedules.
    for command in batch
        .get("packageCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(_command), Some(manifest), Some(script_name), Some(target_path)) = (
            command.as_object(),
            command.get("manifest").and_then(Value::as_str),
            command.get("scriptName").and_then(Value::as_str),
            command.get("targetPath").and_then(Value::as_str),
        ) else {
            continue;
        };
        add(
            public_package_command_node_id(manifest, script_name),
            public_file_node_id(target_path),
            "declares-command-target",
        );
    }
    for record in &records {
        let (Some(relative_path), Some(result)) = (
            structural_record_path(record),
            structural_record_result(record),
        ) else {
            continue;
        };
        for command in result
            .get("frameworkCommands")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (
                Some(command),
                Some(adapter),
                Some(command_name),
                Some(target_name),
                Some(target_type),
            ) = (
                command.as_object(),
                command.get("adapter").and_then(Value::as_str),
                command.get("commandName").and_then(Value::as_str),
                command.get("targetName").and_then(Value::as_str),
                command.get("targetType").and_then(Value::as_str),
            )
            else {
                continue;
            };
            let command_path = command
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(relative_path);
            add(
                public_framework_command_node_id(command_path, adapter, command_name),
                public_symbol_node_id(command_path, target_type, target_name),
                "declares-command-target",
            );
        }
    }
    for record in &records {
        let (Some(relative_path), Some(result)) = (
            structural_record_path(record),
            structural_record_result(record),
        ) else {
            continue;
        };
        for schedule in result
            .get("schedules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(schedule) = schedule.as_object() else {
                continue;
            };
            let Some(task_name) = schedule.get("taskName").and_then(Value::as_str) else {
                continue;
            };
            let start = schedule
                .get("evidence")
                .and_then(Value::as_object)
                .and_then(|evidence| evidence.get("range"))
                .and_then(Value::as_object)
                .and_then(|range| range.get("start"))
                .and_then(Value::as_object);
            let (Some(line), Some(column)) = (
                start
                    .and_then(|start| start.get("line"))
                    .and_then(Value::as_i64),
                start
                    .and_then(|start| start.get("column"))
                    .and_then(Value::as_i64),
            ) else {
                continue;
            };
            add(
                public_schedule_node_id(relative_path, task_name, line, column),
                public_symbol_node_id(relative_path, "function", task_name),
                "schedules",
            );
        }
    }
    order
}

pub fn build_structural_graph(batch: &Value) -> Result<StructuralGraphProjection, String> {
    let batch = batch
        .as_object()
        .ok_or("StructuralFactBatch/v1 must be an object.")?;
    if batch.get("schemaVersion").and_then(Value::as_str) != Some(STRUCTURAL_FACT_BATCH_SCHEMA) {
        return Err(format!("Expected {STRUCTURAL_FACT_BATCH_SCHEMA}."));
    }
    let records = batch
        .get("records")
        .and_then(Value::as_array)
        .ok_or("StructuralFactBatch/v1 requires records.")?;
    let mut graph = CompactStructuralGraph::default();
    let mut symbols = BTreeMap::new();
    let mut runtime_nodes = BTreeMap::new();
    let mut endpoints = BTreeMap::new();
    let mut resolved_imports = BTreeMap::new();
    let mut resolved_packages = BTreeMap::new();
    let entry_metadata = batch.get("entryMetadata").and_then(Value::as_object);
    for record in records {
        let record = record
            .as_object()
            .ok_or("StructuralFactBatch/v1 records must be objects.")?;
        let relative_path = required(record, "relativePath")?;
        let file_id = public_file_node_id(relative_path);
        let file_metadata = record
            .get("fileMetadata")
            .filter(|metadata| metadata.is_object())
            .cloned();
        insert_node_with_metadata(
            &mut graph,
            file_id.clone(),
            "file",
            optional(record, "fileNodeType").unwrap_or("file"),
            Some(relative_path),
            file_metadata.clone(),
        );
        let result = record
            .get("result")
            .and_then(Value::as_object)
            .ok_or("StructuralFactBatch/v1 records require result facts.")?;
        for resolved_import in result
            .get("resolvedImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let resolved_import = resolved_import
                .as_object()
                .ok_or("StructuralFactBatch/v1 resolvedImports must be objects.")?;
            let specifier = required(resolved_import, "specifier")?;
            let target_path = required(resolved_import, "targetPath")?;
            resolved_imports.insert(
                (relative_path.to_string(), specifier.to_string()),
                target_path.to_string(),
            );
        }
        for resolved_package in result
            .get("resolvedPackages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let resolved_package = resolved_package
                .as_object()
                .ok_or("StructuralFactBatch/v1 resolvedPackages must be objects.")?;
            let specifier = required(resolved_package, "specifier")?;
            let package_path = required(resolved_package, "packagePath")?;
            let files = resolved_package
                .get("files")
                .and_then(Value::as_array)
                .ok_or("StructuralFactBatch/v1 resolvedPackages require files.")?
                .iter()
                .map(|file| {
                    file.as_str()
                        .map(ToString::to_string)
                        .ok_or("StructuralFactBatch/v1 resolvedPackages.files must contain paths.")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let package_id = format!("go-package:{package_path}");
            insert_node_with_metadata(
                &mut graph,
                package_id,
                "package",
                "package",
                Some(package_path),
                resolved_package
                    .get("metadata")
                    .filter(|metadata| metadata.is_object())
                    .cloned(),
            );
            resolved_packages.insert((relative_path.to_string(), specifier.to_string()), files);
        }
        for symbol in result
            .get("symbols")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let symbol = symbol
                .as_object()
                .ok_or("StructuralFactBatch/v1 symbols must be objects.")?;
            let symbol_type = required(symbol, "type")?;
            let symbol_name = required(symbol, "name")?;
            let symbol_id = public_symbol_node_id(relative_path, symbol_type, symbol_name);
            symbols.insert(
                (
                    relative_path.to_string(),
                    symbol_type.to_string(),
                    symbol_name.to_string(),
                ),
                symbol_id.clone(),
            );
            insert_node_with_metadata(
                &mut graph,
                symbol_id.clone(),
                "symbol",
                symbol_type,
                Some(relative_path),
                Some(symbol_metadata(
                    file_metadata.as_ref(),
                    symbol,
                    symbol_type,
                    symbol_name,
                )),
            );
            insert_edge(&mut graph, symbol_id.clone(), file_id.clone(), "declares");
            insert_edge(&mut graph, file_id.clone(), symbol_id, "contains");
        }
        for integration in result
            .get("integrations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let integration = integration
                .as_object()
                .ok_or("StructuralFactBatch/v1 integrations must be objects.")?;
            let integration_type = required(integration, "type")?;
            let instance = required(integration, "instance")?;
            let runtime_id = public_runtime_node_id(relative_path, integration_type, instance);
            runtime_nodes.insert(
                (relative_path.to_string(), instance.to_string()),
                runtime_id.clone(),
            );
            insert_node_with_metadata(
                &mut graph,
                runtime_id.clone(),
                "integration",
                integration_type,
                Some(relative_path),
                Some(integration_metadata(
                    file_metadata.as_ref(),
                    integration,
                    integration_type,
                )),
            );
            insert_edge(&mut graph, file_id.clone(), runtime_id, "initializes");
        }
        for endpoint in result
            .get("endpoints")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let endpoint = endpoint
                .as_object()
                .ok_or("StructuralFactBatch/v1 endpoints must be objects.")?;
            let method = required(endpoint, "method")?;
            let route = required(endpoint, "route")?;
            let endpoint_id = public_endpoint_node_id(relative_path, method, route);
            let target = optional(endpoint, "handlerName")
                .and_then(|name| {
                    symbols.get(&(
                        relative_path.to_string(),
                        optional(endpoint, "handlerType")
                            .unwrap_or("function")
                            .to_string(),
                        name.to_string(),
                    ))
                })
                .cloned()
                .unwrap_or_else(|| file_id.clone());
            let exact_handler = target.starts_with("symbol:");
            endpoints
                .entry((method.to_string(), route.to_string()))
                .or_insert_with(|| endpoint_id.clone());
            insert_node_with_metadata(
                &mut graph,
                endpoint_id.clone(),
                "endpoint",
                "endpoint",
                Some(relative_path),
                Some(endpoint_metadata(
                    file_metadata.as_ref(),
                    endpoint,
                    method,
                    route,
                    &target,
                    exact_handler,
                )),
            );
            insert_edge(&mut graph, endpoint_id, target, "handles");
        }
        for external_import in result
            .get("externalImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let external_import = external_import
                .as_object()
                .ok_or("StructuralFactBatch/v1 externalImports must be objects.")?;
            let specifier = required(external_import, "specifier")?;
            let node_type = required(external_import, "nodeType")?;
            let external_id = public_external_node_id(specifier);
            let metadata = external_import
                .get("metadata")
                .filter(|metadata| metadata.is_object())
                .cloned();
            insert_node_with_metadata(
                &mut graph,
                external_id.clone(),
                "external",
                node_type,
                None,
                metadata,
            );
            insert_edge(&mut graph, file_id.clone(), external_id, "uses");
        }
        for command in result
            .get("frameworkCommands")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let command = command
                .as_object()
                .ok_or("StructuralFactBatch/v1 frameworkCommands must be objects.")?;
            let adapter = required(command, "adapter")?;
            let command_name = required(command, "commandName")?;
            let target_name = required(command, "targetName")?;
            let target_type = required(command, "targetType")?;
            let command_path = optional(command, "path").unwrap_or(relative_path);
            let target_id = public_symbol_node_id(command_path, target_type, target_name);
            if graph.contains_node(&target_id) {
                let command_id =
                    public_framework_command_node_id(command_path, adapter, command_name);
                insert_node_with_metadata(
                    &mut graph,
                    command_id.clone(),
                    "command",
                    "command",
                    Some(command_path),
                    entry_metadata
                        .and_then(|entries| entries.get(&command_id))
                        .filter(|metadata| metadata.is_object())
                        .cloned(),
                );
                insert_edge(&mut graph, command_id, target_id, "declares-command-target");
            }
        }
        for schedule in result
            .get("schedules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let schedule = schedule
                .as_object()
                .ok_or("StructuralFactBatch/v1 schedules must be objects.")?;
            let task_name = required(schedule, "taskName")?;
            let line = schedule
                .get("evidence")
                .and_then(Value::as_object)
                .and_then(|evidence| evidence.get("range"))
                .and_then(Value::as_object)
                .and_then(|range| range.get("start"))
                .and_then(Value::as_object)
                .and_then(|start| start.get("line"))
                .and_then(Value::as_i64);
            let column = schedule
                .get("evidence")
                .and_then(Value::as_object)
                .and_then(|evidence| evidence.get("range"))
                .and_then(Value::as_object)
                .and_then(|range| range.get("start"))
                .and_then(Value::as_object)
                .and_then(|start| start.get("column"))
                .and_then(Value::as_i64);
            let target_id = public_symbol_node_id(relative_path, "function", task_name);
            if let (Some(line), Some(column)) = (line, column)
                && graph.contains_node(&target_id)
            {
                let schedule_id = public_schedule_node_id(relative_path, task_name, line, column);
                insert_node_with_metadata(
                    &mut graph,
                    schedule_id.clone(),
                    "schedule",
                    "schedule",
                    Some(relative_path),
                    entry_metadata
                        .and_then(|entries| entries.get(&schedule_id))
                        .filter(|metadata| metadata.is_object())
                        .cloned(),
                );
                insert_edge(&mut graph, schedule_id, target_id, "schedules");
            }
        }
    }
    for command in batch
        .get("packageCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let command = command
            .as_object()
            .ok_or("StructuralFactBatch/v1 packageCommands must be objects.")?;
        let manifest = required(command, "manifest")?;
        let script_name = required(command, "scriptName")?;
        let target_path = required(command, "targetPath")?;
        let target_id = public_file_node_id(target_path);
        if graph.contains_node(&target_id) {
            let command_id = public_package_command_node_id(manifest, script_name);
            insert_node_with_metadata(
                &mut graph,
                command_id.clone(),
                "command",
                "command",
                Some(manifest),
                entry_metadata
                    .and_then(|entries| entries.get(&command_id))
                    .filter(|metadata| metadata.is_object())
                    .cloned(),
            );
            insert_edge(&mut graph, command_id, target_id, "declares-command-target");
        }
    }
    for record in records {
        let record = record
            .as_object()
            .ok_or("StructuralFactBatch/v1 records must be objects.")?;
        let relative_path = required(record, "relativePath")?;
        let file_id = public_file_node_id(relative_path);
        let result = record
            .get("result")
            .and_then(Value::as_object)
            .ok_or("StructuralFactBatch/v1 records require result facts.")?;
        for resolved_import in result
            .get("resolvedImports")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let resolved_import = resolved_import
                .as_object()
                .ok_or("StructuralFactBatch/v1 resolvedImports must be objects.")?;
            let specifier = required(resolved_import, "specifier")?;
            let target_path = required(resolved_import, "targetPath")?;
            let target_id = public_file_node_id(target_path);
            if graph.contains_node(&target_id) {
                resolved_imports.insert(
                    (relative_path.to_string(), specifier.to_string()),
                    target_path.to_string(),
                );
                insert_edge(&mut graph, file_id.clone(), target_id, "imports");
            }
        }
        for resolved_package in result
            .get("resolvedPackages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let resolved_package = resolved_package
                .as_object()
                .ok_or("StructuralFactBatch/v1 resolvedPackages must be objects.")?;
            let package_path = required(resolved_package, "packagePath")?;
            let package_id = format!("go-package:{package_path}");
            if graph.contains_node(&package_id) {
                for file in resolved_package
                    .get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let file_path = file.as_str().ok_or(
                        "StructuralFactBatch/v1 resolvedPackages.files must contain paths.",
                    )?;
                    let contained_file_id = public_file_node_id(file_path);
                    if graph.contains_node(&contained_file_id) {
                        insert_edge(
                            &mut graph,
                            package_id.clone(),
                            contained_file_id,
                            "contains",
                        );
                    }
                }
                insert_edge(&mut graph, file_id.clone(), package_id, "imports");
            }
        }
        for call in result
            .get("calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let call = call
                .as_object()
                .ok_or("StructuralFactBatch/v1 calls must be objects.")?;
            let Some(name) = optional(call, "name") else {
                continue;
            };
            let source = call
                .get("source")
                .and_then(Value::as_object)
                .and_then(|source| {
                    Some((
                        optional(source, "type")?.to_string(),
                        optional(source, "name")?.to_string(),
                    ))
                })
                .and_then(|(symbol_type, symbol_name)| {
                    symbols
                        .get(&(relative_path.to_string(), symbol_type, symbol_name))
                        .cloned()
                })
                .unwrap_or_else(|| file_id.clone());
            let imported_specifier = call
                .get("imported")
                .and_then(Value::as_object)
                .and_then(|imported| optional(imported, "specifier"));
            let target_name = call
                .get("imported")
                .and_then(Value::as_object)
                .and_then(|imported| optional(imported, "exportedName"))
                .unwrap_or(name);
            let target = match imported_specifier {
                Some(specifier) => resolved_imports
                    .get(&(relative_path.to_string(), specifier.to_string()))
                    .and_then(|target_path| {
                        symbols.get(&(
                            target_path.clone(),
                            String::from("function"),
                            target_name.to_string(),
                        ))
                    })
                    .cloned()
                    .or_else(|| {
                        let matches = resolved_packages
                            .get(&(relative_path.to_string(), specifier.to_string()))?
                            .iter()
                            .filter_map(|path| {
                                symbols
                                    .get(&(
                                        path.clone(),
                                        String::from("function"),
                                        target_name.to_string(),
                                    ))
                                    .cloned()
                            })
                            .collect::<Vec<_>>();
                        (matches.len() == 1).then(|| matches[0].clone())
                    }),
                None => symbols
                    .get(&(
                        relative_path.to_string(),
                        String::from("function"),
                        target_name.to_string(),
                    ))
                    .cloned(),
            };
            if let Some(target) = target {
                insert_edge(&mut graph, source, target, "calls");
            }
        }
        for action in result
            .get("runtimeActions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let action = action
                .as_object()
                .ok_or("StructuralFactBatch/v1 runtimeActions must be objects.")?;
            let Some(instance) = optional(action, "instance") else {
                continue;
            };
            let Some(action_type) = optional(action, "type") else {
                continue;
            };
            let source = action
                .get("source")
                .and_then(Value::as_object)
                .and_then(|source| {
                    Some((
                        optional(source, "type")?.to_string(),
                        optional(source, "name")?.to_string(),
                    ))
                })
                .and_then(|(symbol_type, symbol_name)| {
                    symbols
                        .get(&(relative_path.to_string(), symbol_type, symbol_name))
                        .cloned()
                })
                .unwrap_or_else(|| file_id.clone());
            if let Some(target) = runtime_nodes
                .get(&(relative_path.to_string(), instance.to_string()))
                .cloned()
            {
                insert_edge(&mut graph, source, target, action_type);
            }
        }
        for request in result
            .get("requests")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let request = request
                .as_object()
                .ok_or("StructuralFactBatch/v1 requests must be objects.")?;
            let (Some(method), Some(route)) =
                (optional(request, "method"), optional(request, "route"))
            else {
                continue;
            };
            if let Some(target) = endpoints
                .get(&(method.to_string(), route.to_string()))
                .cloned()
            {
                insert_edge(&mut graph, file_id.clone(), target, "requests");
            }
        }
    }
    let manual_descriptions = batch.get("manualDescriptions").and_then(Value::as_object);
    for (node_id, node) in graph.public_node_ids.iter().zip(graph.nodes.iter_mut()) {
        if !matches!(node.kind.as_ref(), "symbol" | "endpoint" | "integration") {
            continue;
        }
        let Some(metadata) = node.metadata.as_mut() else {
            continue;
        };
        metadata.insert_dynamic(
            "manualDescription".to_string(),
            manual_descriptions
                .and_then(|descriptions| descriptions.get(node_id.as_ref()))
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
    }
    let record_edge_metadata = record_edge_metadata(batch);
    let (nodes, mut edges) = graph.into_public_parts();
    for edge in &mut edges {
        (edge.confidence, edge.evidence) = edge_metadata(
            batch,
            &record_edge_metadata,
            &edge.source,
            &edge.target,
            &edge.edge_type,
        );
    }
    structural_graph_projection_from_parts(nodes, edges)
}

pub fn structural_graph_projection_from_parts(
    mut nodes: Vec<StructuralGraphNode>,
    mut edges: Vec<StructuralGraphEdge>,
) -> Result<StructuralGraphProjection, String> {
    // Native canonicalization must be derived from the assembled projection,
    // never from a topology order supplied by the JavaScript oracle.
    nodes.sort_by(|left, right| javascript_ascii_cmp(&left.id, &right.id));
    edges.sort_by(|left, right| {
        let left_key = format!("{}\0{}\0{}", left.source, left.target, left.edge_type);
        let right_key = format!("{}\0{}\0{}", right.source, right.target, right.edge_type);
        javascript_ascii_cmp(&left_key, &right_key)
    });
    let canonical_nodes: Vec<Value> = nodes
        .iter()
        .map(|node| {
            json!({
                "id": &node.id,
                "kind": &node.kind,
                "nodeType": &node.node_type,
                "path": &node.path,
            })
        })
        .collect();
    let canonical_edges: Vec<Value> = edges
        .iter()
        .map(|edge| {
            json!({
                "source": &edge.source,
                "target": &edge.target,
                "type": &edge.edge_type,
            })
        })
        .collect();
    let canonical_json =
        serde_json::to_string(&json!({ "edges": canonical_edges, "nodes": canonical_nodes }))
            .map_err(|error| format!("Unable to canonicalize native structural graph: {error}"))?;
    Ok(StructuralGraphProjection {
        schema_version: STRUCTURAL_GRAPH_SCHEMA,
        nodes,
        edges,
        canonical_json,
        limitation: "Shadow subset: file, symbol, endpoint, and runtime nodes plus local structural edges are assembled. Import resolution, external packages, entry commands, schedules, flows, graph lifecycle, and public compatibility projection remain JavaScript-authoritative.",
    })
}

#[cfg(test)]
mod tests {
    use super::{
        CompactNodeMetadata, STRUCTURAL_GRAPH_SCHEMA, build_structural_graph, javascript_ascii_cmp,
        javascript_ascii_locale_cmp,
    };
    use crate::protocol::STRUCTURAL_FACT_BATCH_SCHEMA;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn assembles_javascript_public_ids_for_the_supported_shadow_subset() {
        let graph = build_structural_graph(&json!({
            "schemaVersion": STRUCTURAL_FACT_BATCH_SCHEMA,
            "records": [{
                "recordOrder": 0,
                "relativePath": "src/orders.ts",
                "result": {
                "symbols": [
                    { "type": "function", "name": "helper" },
                    { "type": "function", "name": "submit" }
                ],
                "integrations": [{ "type": "database", "instance": "db" }],
                "endpoints": [{ "method": "POST", "route": "/orders", "handlerName": "submit" }],
                "calls": [{ "name": "helper", "source": { "type": "function", "name": "submit" } }],
                "runtimeActions": [{ "instance": "db", "type": "queries", "source": { "type": "function", "name": "submit" } }],
                "requests": [{ "method": "POST", "route": "/orders" }]
                }
            }]
        }))
        .unwrap();
        assert_eq!(graph.schema_version, STRUCTURAL_GRAPH_SCHEMA);
        assert_eq!(
            graph
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "endpoint:src/orders.ts:POST:/orders",
                "file:src/orders.ts",
                "runtime:src/orders.ts:database:db",
                "symbol:src/orders.ts:function:helper",
                "symbol:src/orders.ts:function:submit",
            ]
        );
        assert_eq!(graph.edges.len(), 9);
        assert!(graph.edges.iter().any(|edge| edge.edge_type == "handles"
            && edge.target == "symbol:src/orders.ts:function:submit"));
        assert!(graph.edges.iter().any(|edge| edge.edge_type == "calls"
            && edge.source == "symbol:src/orders.ts:function:submit"
            && edge.target == "symbol:src/orders.ts:function:helper"));
        assert!(graph.edges.iter().any(|edge| edge.edge_type == "queries"
            && edge.target == "runtime:src/orders.ts:database:db"));
    }

    #[test]
    fn canonicalization_matches_the_audited_javascript_ascii_id_order() {
        let mut ids = vec![
            "file:src/checkout.php",
            "file:src/checkout_test.php",
            "file:src/a/b",
            "file:src/a.b",
            "file:src/a-b",
            "file:src/a_b",
        ];
        ids.sort_by(|left, right| javascript_ascii_cmp(left, right));
        assert_eq!(
            ids,
            vec![
                "file:src/a_b",
                "file:src/a-b",
                "file:src/a.b",
                "file:src/a/b",
                "file:src/checkout_test.php",
                "file:src/checkout.php",
            ]
        );
    }

    #[test]
    fn public_label_order_matches_the_audited_javascript_ascii_locale_order() {
        let mut labels = vec![
            "Prisma Client",
            "Prisma client",
            "Rebuild Index",
            "rebuild_search_index",
            "submit",
        ];
        labels.sort_by(|left, right| javascript_ascii_locale_cmp(left, right));
        assert_eq!(
            labels,
            vec![
                "Prisma client",
                "Prisma Client",
                "Rebuild Index",
                "rebuild_search_index",
                "submit",
            ]
        );
    }

    #[test]
    fn compact_metadata_preserves_non_string_stable_fields_and_mixed_methods() {
        let mut intern = BTreeMap::new();
        let metadata = CompactNodeMetadata::from_value(
            json!({
                "label": "Order",
                "handlerId": null,
                "methods": ["submit", { "dynamic": true }],
                "evidence": { "parser": "native" },
            }),
            &mut intern,
        )
        .into_value();
        assert_eq!(metadata["label"], "Order");
        assert!(metadata["handlerId"].is_null());
        assert_eq!(metadata["methods"][1]["dynamic"], true);
        assert_eq!(metadata["evidence"]["parser"], "native");
    }
}
