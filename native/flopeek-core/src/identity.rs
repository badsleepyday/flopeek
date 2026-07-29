use blake3::Hasher;

pub const NODE_IDENTITY_SCHEMA: &str = "flopeek-native-node-identity/v1";

// Public graph IDs intentionally mirror the JavaScript scanner. They are not
// derived from the BLAKE3 internal identity below.
pub fn public_file_node_id(relative_path: &str) -> String {
    format!("file:{relative_path}")
}

pub fn public_symbol_node_id(relative_path: &str, symbol_type: &str, symbol_name: &str) -> String {
    format!("symbol:{relative_path}:{symbol_type}:{symbol_name}")
}

pub fn public_runtime_node_id(
    relative_path: &str,
    integration_type: &str,
    instance: &str,
) -> String {
    format!("runtime:{relative_path}:{integration_type}:{instance}")
}

pub fn public_endpoint_node_id(relative_path: &str, method: &str, route: &str) -> String {
    format!("endpoint:{relative_path}:{method}:{route}")
}

pub fn public_go_package_node_id(package_path: &str) -> String {
    format!("go-package:{package_path}")
}

pub fn public_external_node_id(specifier: &str) -> String {
    let parts: Vec<&str> = specifier.split(['\\', '/', ':']).collect();
    let package_name = if specifier.starts_with('@') {
        parts.iter().take(2).copied().collect::<Vec<_>>().join("/")
    } else {
        parts.first().copied().unwrap_or_default().to_string()
    };
    format!("external:{package_name}")
}

pub fn public_framework_command_node_id(path: &str, adapter: &str, command_name: &str) -> String {
    format!("command:{path}:{adapter}:{command_name}")
}

pub fn public_package_command_node_id(manifest: &str, script_name: &str) -> String {
    format!("command:{manifest}:{script_name}")
}

pub fn public_schedule_node_id(path: &str, task_name: &str, line: i64, column: i64) -> String {
    format!("schedule:{path}:{task_name}:{line}:{column}")
}

#[derive(Debug, Clone, Copy)]
pub struct NodeIdentity<'a> {
    pub kind: &'a str,
    pub path: &'a str,
    pub symbol: Option<&'a str>,
    pub signature: Option<&'a str>,
}

fn append_component(target: &mut String, name: &str, value: Option<&str>) {
    target.push_str(name);
    target.push('\0');
    match value {
        Some(value) => {
            target.push('1');
            target.push(':');
            target.push_str(&value.len().to_string());
            target.push(':');
            target.push_str(value);
        }
        None => target.push('0'),
    }
    target.push('\0');
}

pub fn semantic_key(identity: NodeIdentity<'_>) -> String {
    let mut key = String::from(NODE_IDENTITY_SCHEMA);
    key.push('\0');
    append_component(&mut key, "kind", Some(identity.kind));
    append_component(&mut key, "path", Some(identity.path));
    append_component(&mut key, "symbol", identity.symbol);
    append_component(&mut key, "signature", identity.signature);
    key
}

pub fn stable_node_id(identity: NodeIdentity<'_>) -> String {
    let mut hasher = Hasher::new();
    hasher.update(semantic_key(identity).as_bytes());
    format!("node:v1:{}", hasher.finalize().to_hex())
}

#[cfg(test)]
mod tests {
    use super::{
        NodeIdentity, public_endpoint_node_id, public_external_node_id, public_file_node_id,
        public_framework_command_node_id, public_go_package_node_id,
        public_package_command_node_id, public_runtime_node_id, public_schedule_node_id,
        public_symbol_node_id, semantic_key, stable_node_id,
    };

    #[test]
    fn public_node_ids_match_the_javascript_canonical_format() {
        assert_eq!(public_file_node_id("src/orders.ts"), "file:src/orders.ts");
        assert_eq!(
            public_symbol_node_id("src/orders.ts", "function", "submit"),
            "symbol:src/orders.ts:function:submit"
        );
        assert_eq!(
            public_runtime_node_id("src/orders.ts", "database", "db"),
            "runtime:src/orders.ts:database:db"
        );
        assert_eq!(
            public_endpoint_node_id("src/routes.ts", "POST", "/orders"),
            "endpoint:src/routes.ts:POST:/orders"
        );
        assert_eq!(
            public_go_package_node_id("internal/orders"),
            "go-package:internal/orders"
        );
        assert_eq!(
            public_external_node_id("@scope/tool/runtime"),
            "external:@scope/tool"
        );
        assert_eq!(public_external_node_id("/src/utils/getAuth"), "external:");
        assert_eq!(
            public_framework_command_node_id("src/commands.py", "click", "cleanup"),
            "command:src/commands.py:click:cleanup"
        );
        assert_eq!(
            public_package_command_node_id("package.json", "serve"),
            "command:package.json:serve"
        );
        assert_eq!(
            public_schedule_node_id("src/jobs.ts", "refresh", 8, 1),
            "schedule:src/jobs.ts:refresh:8:1"
        );
    }

    #[test]
    fn stable_node_id_is_repeatable_for_one_semantic_identity() {
        let identity = NodeIdentity {
            kind: "function",
            path: "src/scanner.js",
            symbol: Some("createFileRecord"),
            signature: Some("(root, absolutePath, sourceScope, goFact)"),
        };
        assert_eq!(stable_node_id(identity), stable_node_id(identity));
        assert!(stable_node_id(identity).starts_with("node:v1:"));
    }

    #[test]
    fn semantic_key_distinguishes_missing_and_empty_optional_fields() {
        let missing = NodeIdentity {
            kind: "function",
            path: "src/main.rs",
            symbol: None,
            signature: None,
        };
        let empty = NodeIdentity {
            kind: "function",
            path: "src/main.rs",
            symbol: Some(""),
            signature: None,
        };
        assert_ne!(semantic_key(missing), semantic_key(empty));
        assert_ne!(stable_node_id(missing), stable_node_id(empty));
    }
}
