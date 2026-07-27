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
