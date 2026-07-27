use flopeek_native_core::facts::scan_native_rust_facts;
use flopeek_native_core::graph::scan_native_rust_graph;
use flopeek_native_core::inventory::{scan_native_inventory, scan_native_inventory_with_paths};
use flopeek_native_core::store::initialize_native_store;
use serde_json::json;
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const NATIVE_WRAPPER_SCHEMA: &str = "flopeek-native-wrapper/v1";

fn equals(argument: &OsString, expected: &str) -> bool {
    argument == OsStr::new(expected)
}

fn repository_root(candidate: Option<OsString>) -> Result<PathBuf, String> {
    if let Some(candidate) = candidate {
        let path = PathBuf::from(candidate);
        if path.join("src").join("cli.js").is_file() {
            return Ok(path);
        }
        return Err(format!(
            "Flopeek JavaScript root is missing src/cli.js: {}",
            path.display()
        ));
    }
    if let Some(configured) = env::var_os("FLOPEEK_JS_ROOT") {
        return repository_root(Some(configured));
    }
    let current =
        env::current_dir().map_err(|error| format!("Unable to read current directory: {error}"))?;
    if current.join("src").join("cli.js").is_file() {
        return Ok(current);
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source_root = manifest
        .parent()
        .and_then(Path::parent)
        .ok_or("Native wrapper cannot derive its source root.")?
        .to_path_buf();
    if source_root.join("src").join("cli.js").is_file() {
        return Ok(source_root);
    }
    Err("Set FLOPEEK_JS_ROOT to a checkout containing src/cli.js.".to_string())
}

fn native_status(root: PathBuf) -> Result<(), String> {
    let store = initialize_native_store(&root)
        .map_err(|error| format!("Unable to initialize native SQLite store: {error}"))?;
    let payload = json!({
        "schemaVersion": NATIVE_WRAPPER_SCHEMA,
        "mode": "javascript-wrapper",
        "projectRoot": root,
        "store": {
            "path": store.path,
            "schemaVersion": store.schema_version,
            "journalMode": store.journal_mode,
            "foreignKeysEnabled": store.foreign_keys_enabled,
        },
        "identity": {
            "schemaVersion": "flopeek-native-node-identity/v1",
            "algorithm": "blake3",
            "publicNodeIdsEnabled": false,
        },
        "limitation": "Normal Flopeek commands are delegated unchanged to the JavaScript CLI. SQLite and native IDs are bootstrap metadata only until compatibility parity promotes them."
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn native_inventory(root: PathBuf, include_paths: bool) -> Result<(), String> {
    let inventory = if include_paths {
        scan_native_inventory_with_paths(&root)?
    } else {
        scan_native_inventory(&root)?
    };
    let mut payload = json!({
        "schemaVersion": "flopeek-native-inventory/v1",
        "mode": "native-inventory-shadow",
        "projectRoot": inventory.project_root,
        "projectId": inventory.project_identity.project_id,
        "identity": {
            "source": inventory.project_identity.source,
            "status": inventory.project_identity.status,
            "originRemote": inventory.project_identity.origin_remote,
            "limitation": inventory.project_identity.limitation,
        },
        "scopeSource": inventory.scope_source,
        "sourceScopeCounts": inventory.source_scope_counts,
        "sourceFingerprint": inventory.source_fingerprint,
        "candidateFiles": inventory.candidate_files,
        "hashedFiles": inventory.hashed_files,
        "reusedFiles": inventory.reused_files,
        "removedFiles": inventory.removed_files,
        "limitation": "This is a native cache inventory only. JavaScript remains the source of truth for source scope, parser facts, graph IDs, Context Refs, and public CLI output."
    });
    if include_paths {
        payload["candidatePaths"] = json!(inventory.candidate_paths.unwrap_or_default());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn native_rust_facts(root: PathBuf) -> Result<(), String> {
    let result = scan_native_rust_facts(&root)?;
    let payload = json!({
        "schemaVersion": "flopeek-native-rust-facts/v1",
        "mode": "native-rust-parser-shadow",
        "projectRoot": result.project_root,
        "projectId": result.project_identity.project_id,
        "identity": {
            "source": result.project_identity.source,
            "status": result.project_identity.status,
            "originRemote": result.project_identity.origin_remote,
            "limitation": result.project_identity.limitation,
        },
        "adapterVersion": result.adapter_version,
        "parsedFiles": result.parsed_files,
        "reusedFiles": result.reused_files,
        "failedFiles": result.failed_files,
        "removedFacts": result.removed_facts,
        "facts": result.facts,
        "limitation": "Native Rust facts are a shadow-mode metadata cache. JavaScript remains authoritative for graph assembly, graph IDs, Context Refs, and public CLI output."
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn native_rust_graph(root: PathBuf) -> Result<(), String> {
    let result = scan_native_rust_graph(&root)?;
    let payload = json!({
        "schemaVersion": "flopeek-native-rust-graph-shadow/v1",
        "mode": "native-rust-graph-shadow",
        "projectRoot": result.project_root,
        "projectId": result.project_identity.project_id,
        "parsedFiles": result.parsed_files,
        "reusedFiles": result.reused_files,
        "failedFiles": result.failed_files,
        "nodes": result.nodes,
        "edges": result.edges,
        "limitation": "This projection covers only the declared native Rust shadow subset. JavaScript remains authoritative for full graph assembly, Context Refs, and public output."
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn delegate(arguments: Vec<OsString>) -> Result<i32, String> {
    let mut node = env::var_os("FLOPEEK_NODE").unwrap_or_else(|| OsString::from("node"));
    let mut root_override = None;
    let mut forwarded = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        if equals(&arguments[index], "--native-node") {
            index += 1;
            node = arguments
                .get(index)
                .cloned()
                .ok_or("--native-node requires a command path.")?;
        } else if equals(&arguments[index], "--native-js-root") {
            index += 1;
            root_override = Some(
                arguments
                    .get(index)
                    .cloned()
                    .ok_or("--native-js-root requires a repository path.")?,
            );
        } else {
            forwarded.push(arguments[index].clone());
        }
        index += 1;
    }
    let root = repository_root(root_override)?;
    let status = Command::new(node)
        .arg(root.join("src").join("cli.js"))
        .args(forwarded)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("Unable to start the JavaScript Flopeek CLI: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn run() -> Result<i32, String> {
    let arguments: Vec<OsString> = env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| equals(argument, "--native-status"))
    {
        if arguments.len() > 2 {
            return Err("--native-status accepts at most one repository path.".to_string());
        }
        let root = if let Some(path) = arguments.get(1) {
            PathBuf::from(path)
        } else {
            repository_root(None)?
        };
        native_status(root)?;
        return Ok(0);
    }
    if arguments
        .first()
        .is_some_and(|argument| equals(argument, "--native-rust-graph"))
    {
        if arguments.len() > 2 {
            return Err("--native-rust-graph accepts at most one repository path.".to_string());
        }
        let root = arguments
            .get(1)
            .map(PathBuf::from)
            .unwrap_or(repository_root(None)?);
        native_rust_graph(root)?;
        return Ok(0);
    }
    if arguments.first().is_some_and(|argument| {
        equals(argument, "--native-inventory") || equals(argument, "--native-inventory-paths")
    }) {
        if arguments.len() > 2 {
            return Err("--native-inventory accepts at most one repository path.".to_string());
        }
        let root = if let Some(path) = arguments.get(1) {
            PathBuf::from(path)
        } else {
            repository_root(None)?
        };
        native_inventory(root, equals(&arguments[0], "--native-inventory-paths"))?;
        return Ok(0);
    }
    if arguments
        .first()
        .is_some_and(|argument| equals(argument, "--native-rust-facts"))
    {
        if arguments.len() > 2 {
            return Err("--native-rust-facts accepts at most one repository path.".to_string());
        }
        let root = if let Some(path) = arguments.get(1) {
            PathBuf::from(path)
        } else {
            repository_root(None)?
        };
        native_rust_facts(root)?;
        return Ok(0);
    }
    delegate(arguments)
}

fn main() {
    match run() {
        Ok(status) => std::process::exit(status),
        Err(error) => {
            eprintln!("flopeek-native: {error}");
            std::process::exit(1);
        }
    }
}
