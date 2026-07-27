use blake3::Hasher;

pub const NODE_IDENTITY_SCHEMA: &str = "flopeek-native-node-identity/v1";

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
    use super::{NodeIdentity, semantic_key, stable_node_id};

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
