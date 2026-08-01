mod canonical_encoding;

use blake3::Hasher as Blake3Hasher;
use canonical_encoding::{
    CanonicalEncoder, normalized_identifier, normalized_repository_path, normalized_text,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use uuid::Uuid;

pub use canonical_encoding::{
    CANONICAL_ENCODING_SCHEMA, IdentityError, MAX_IDENTITY_PATH_BYTES, MAX_IDENTITY_TEXT_BYTES,
};

pub const SEMANTIC_IDENTITY_SCHEMA: &str = "flopeek-node-semantic-identity/v2";
pub const REVISION_IDENTITY_SCHEMA: &str = "flopeek-node-revision-identity/v2";
pub const EDGE_IDENTITY_SCHEMA: &str = "flopeek-edge-identity/v2";
pub const EVIDENCE_IDENTITY_SCHEMA: &str = "flopeek-edge-evidence-identity/v2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodePk(pub i64);

macro_rules! uuid_identity {
    ($name:ident, $public_prefix:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new_v7() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn from_slice(value: &[u8]) -> Result<Self, IdentityError> {
                Uuid::from_slice(value)
                    .map(Self)
                    .map_err(|_| IdentityError::InvalidUuid)
            }

            pub fn as_bytes(&self) -> &[u8; 16] {
                self.0.as_bytes()
            }

            pub fn as_uuid(&self) -> Uuid {
                self.0
            }

            pub fn public_id(&self) -> String {
                format!(concat!($public_prefix, "{}"), self.0.simple())
            }

            pub fn from_public_id(value: &str) -> Result<Self, IdentityError> {
                let encoded = value
                    .strip_prefix($public_prefix)
                    .ok_or(IdentityError::InvalidUuid)?;
                Uuid::parse_str(encoded)
                    .map(Self)
                    .map_err(|_| IdentityError::InvalidUuid)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "{}", self.0)
            }
        }
    };
}

uuid_identity!(ProjectUid, "p_");
uuid_identity!(NodeUid, "n_");

macro_rules! digest_identity {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; 32]);

        impl $name {
            pub fn from_bytes(value: [u8; 32]) -> Self {
                Self(value)
            }

            pub fn from_slice(field: &'static str, value: &[u8]) -> Result<Self, IdentityError> {
                let bytes: [u8; 32] =
                    value
                        .try_into()
                        .map_err(|_| IdentityError::InvalidDigestLength {
                            field,
                            actual: value.len(),
                        })?;
                Ok(Self(bytes))
            }

            pub fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, concat!($prefix, ":"))?;
                for byte in self.0 {
                    write!(formatter, "{byte:02x}")?;
                }
                Ok(())
            }
        }
    };
}

digest_identity!(SemanticHash, "blake3");
digest_identity!(RevisionHash, "sha256");
digest_identity!(EdgeUid, "blake3");
digest_identity!(EvidenceUid, "blake3");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticIdentity {
    canonical: Vec<u8>,
    hash: SemanticHash,
}

impl SemanticIdentity {
    pub fn canonical(&self) -> &[u8] {
        &self.canonical
    }

    pub fn hash(&self) -> SemanticHash {
        self.hash
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SemanticIdentityInput<'a> {
    pub project_uid: &'a ProjectUid,
    pub kind: &'a str,
    pub language: Option<&'a str>,
    pub ecosystem: Option<&'a str>,
    pub path: Option<&'a str>,
    pub qualified_name: Option<&'a str>,
    pub owner_uid: Option<&'a NodeUid>,
    pub signature: Option<&'a str>,
    pub discriminator: Option<&'a str>,
}

fn optional_identifier(
    field: &'static str,
    value: Option<&str>,
) -> Result<Option<String>, IdentityError> {
    value
        .map(|value| normalized_identifier(field, value))
        .transpose()
}

fn optional_text(
    field: &'static str,
    value: Option<&str>,
) -> Result<Option<String>, IdentityError> {
    value
        .map(|value| normalized_text(field, value, MAX_IDENTITY_TEXT_BYTES))
        .transpose()
}

pub fn semantic_identity(
    input: SemanticIdentityInput<'_>,
) -> Result<SemanticIdentity, IdentityError> {
    let kind = normalized_identifier("kind", input.kind)?;
    let language = optional_identifier("language", input.language)?;
    let ecosystem = optional_identifier("ecosystem", input.ecosystem)?;
    let path = input.path.map(normalized_repository_path).transpose()?;
    let qualified_name = optional_text("qualified_name", input.qualified_name)?;
    let signature = optional_text("signature", input.signature)?;
    let discriminator = optional_identifier("discriminator", input.discriminator)?;
    let mut encoder = CanonicalEncoder::new(SEMANTIC_IDENTITY_SCHEMA)?;
    encoder.field_bytes("project_uid", Some(input.project_uid.as_bytes()))?;
    encoder.field_text("kind", Some(&kind))?;
    encoder.field_text("language", language.as_deref())?;
    encoder.field_text("ecosystem", ecosystem.as_deref())?;
    encoder.field_text("path", path.as_deref())?;
    encoder.field_text("qualified_name", qualified_name.as_deref())?;
    encoder.field_bytes(
        "owner_uid",
        input
            .owner_uid
            .map(NodeUid::as_bytes)
            .map(<[u8; 16]>::as_slice),
    )?;
    encoder.field_text("signature", signature.as_deref())?;
    encoder.field_text("discriminator", discriminator.as_deref())?;
    let canonical = encoder.finish();
    let hash = SemanticHash::from_bytes(*blake3::hash(&canonical).as_bytes());
    Ok(SemanticIdentity { canonical, hash })
}

#[derive(Debug)]
pub struct RevisionIdentityInput<'a> {
    pub semantic: &'a SemanticIdentity,
    pub lexical_owner_uid: Option<&'a NodeUid>,
    pub display_name: Option<&'a str>,
    pub source_sha256: Option<&'a [u8; 32]>,
    pub content_blake3: Option<&'a [u8; 32]>,
    pub evidence: Option<&'a Value>,
    pub metadata: Option<&'a Value>,
}

fn canonical_json(value: Option<&Value>) -> Result<Option<Vec<u8>>, IdentityError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let bytes = serde_json::to_vec(value).map_err(|_| IdentityError::InvalidJson)?;
    if bytes.len() > MAX_IDENTITY_TEXT_BYTES {
        return Err(IdentityError::TooLong {
            field: "metadata",
            maximum: MAX_IDENTITY_TEXT_BYTES,
        });
    }
    Ok(Some(bytes))
}

pub fn revision_hash(input: RevisionIdentityInput<'_>) -> Result<RevisionHash, IdentityError> {
    let display_name = optional_text("display_name", input.display_name)?;
    let evidence = canonical_json(input.evidence)?;
    let metadata = canonical_json(input.metadata)?;
    let mut encoder = CanonicalEncoder::new(REVISION_IDENTITY_SCHEMA)?;
    encoder.field_bytes("semantic_identity", Some(input.semantic.canonical()))?;
    encoder.field_bytes(
        "lexical_owner_uid",
        input
            .lexical_owner_uid
            .map(NodeUid::as_bytes)
            .map(<[u8; 16]>::as_slice),
    )?;
    encoder.field_text("display_name", display_name.as_deref())?;
    encoder.field_bytes(
        "source_sha256",
        input.source_sha256.map(<[u8; 32]>::as_slice),
    )?;
    encoder.field_bytes(
        "content_blake3",
        input.content_blake3.map(<[u8; 32]>::as_slice),
    )?;
    encoder.field_bytes("evidence", evidence.as_deref())?;
    encoder.field_bytes("metadata", metadata.as_deref())?;
    let digest = Sha256::digest(encoder.finish());
    RevisionHash::from_slice("revision_hash", &digest)
}

#[derive(Debug, Clone, Copy)]
pub struct EdgeIdentityInput<'a> {
    pub project_uid: &'a ProjectUid,
    pub source_uid: &'a NodeUid,
    pub target_uid: &'a NodeUid,
    pub relation: &'a str,
    pub qualifier: Option<&'a str>,
}

pub fn edge_uid(input: EdgeIdentityInput<'_>) -> Result<EdgeUid, IdentityError> {
    let relation = normalized_identifier("relation", input.relation)?;
    let qualifier = optional_text("qualifier", input.qualifier)?;
    let mut encoder = CanonicalEncoder::new(EDGE_IDENTITY_SCHEMA)?;
    encoder.field_bytes("project_uid", Some(input.project_uid.as_bytes()))?;
    encoder.field_bytes("source_uid", Some(input.source_uid.as_bytes()))?;
    encoder.field_text("relation", Some(&relation))?;
    encoder.field_bytes("target_uid", Some(input.target_uid.as_bytes()))?;
    encoder.field_text("qualifier", qualifier.as_deref())?;
    let mut hasher = Blake3Hasher::new();
    hasher.update(&encoder.finish());
    Ok(EdgeUid::from_bytes(*hasher.finalize().as_bytes()))
}

#[derive(Debug, Clone, Copy)]
pub struct EvidenceIdentityInput<'a> {
    pub edge_uid: &'a EdgeUid,
    pub path: Option<&'a str>,
    pub start_line: Option<i64>,
    pub start_column: Option<i64>,
    pub end_line: Option<i64>,
    pub end_column: Option<i64>,
    pub parser: &'a str,
    pub parser_version: Option<&'a str>,
    pub confidence: &'a str,
}

pub fn evidence_uid(input: EvidenceIdentityInput<'_>) -> Result<EvidenceUid, IdentityError> {
    let path = input.path.map(normalized_repository_path).transpose()?;
    let parser = normalized_identifier("parser", input.parser)?;
    let parser_version = optional_text("parser_version", input.parser_version)?;
    let confidence = normalized_identifier("confidence", input.confidence)?;
    let mut encoder = CanonicalEncoder::new(EVIDENCE_IDENTITY_SCHEMA)?;
    encoder.field_bytes("edge_uid", Some(input.edge_uid.as_bytes()))?;
    encoder.field_text("path", path.as_deref())?;
    for (name, value) in [
        ("start_line", input.start_line),
        ("start_column", input.start_column),
        ("end_line", input.end_line),
        ("end_column", input.end_column),
    ] {
        let bytes = value.map(i64::to_be_bytes);
        encoder.field_bytes(name, bytes.as_ref().map(<[u8; 8]>::as_slice))?;
    }
    encoder.field_text("parser", Some(&parser))?;
    encoder.field_text("parser_version", parser_version.as_deref())?;
    encoder.field_text("confidence", Some(&confidence))?;
    Ok(EvidenceUid::from_bytes(
        *blake3::hash(&encoder.finish()).as_bytes(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        EdgeIdentityInput, EvidenceIdentityInput, NodeUid, ProjectUid, RevisionIdentityInput,
        SemanticIdentityInput, edge_uid, evidence_uid, revision_hash, semantic_identity,
    };
    use serde_json::json;

    fn semantic<'a>(
        project_uid: &'a ProjectUid,
        owner_uid: Option<&'a NodeUid>,
    ) -> super::SemanticIdentity {
        semantic_identity(SemanticIdentityInput {
            project_uid,
            kind: "method",
            language: Some("java"),
            ecosystem: Some("maven"),
            path: Some("src\\OrderService.java"),
            qualified_name: Some("OrderService.save"),
            owner_uid,
            signature: Some("(Order,User):void"),
            discriminator: Some("instance-method"),
        })
        .unwrap()
    }

    #[test]
    fn uuidv7_types_are_distinct_and_time_ordered_values() {
        let project = ProjectUid::new_v7();
        let node = NodeUid::new_v7();
        assert_eq!(project.as_uuid().get_version_num(), 7);
        assert_eq!(node.as_uuid().get_version_num(), 7);
        assert_eq!(ProjectUid::from_slice(project.as_bytes()).unwrap(), project);
        assert_eq!(NodeUid::from_slice(node.as_bytes()).unwrap(), node);
        assert_eq!(NodeUid::from_public_id(&node.public_id()).unwrap(), node);
        assert!(node.public_id().starts_with("n_"));
    }

    #[test]
    fn semantic_identity_normalizes_paths_and_changes_with_owner() {
        let project = ProjectUid::new_v7();
        let owner = NodeUid::new_v7();
        let without_owner = semantic(&project, None);
        let with_owner = semantic(&project, Some(&owner));
        assert_ne!(without_owner.hash(), with_owner.hash());
        assert_eq!(semantic(&project, Some(&owner)), with_owner);
    }

    #[test]
    fn revisions_and_edge_occurrences_have_separate_identities() {
        let project = ProjectUid::new_v7();
        let source = NodeUid::new_v7();
        let target = NodeUid::new_v7();
        let semantic = semantic(&project, Some(&source));
        let first_revision = revision_hash(RevisionIdentityInput {
            semantic: &semantic,
            lexical_owner_uid: Some(&source),
            display_name: Some("save"),
            source_sha256: Some(&[1; 32]),
            content_blake3: Some(&[2; 32]),
            evidence: Some(&json!({"line": 20})),
            metadata: None,
        })
        .unwrap();
        let second_revision = revision_hash(RevisionIdentityInput {
            semantic: &semantic,
            lexical_owner_uid: Some(&source),
            display_name: Some("save"),
            source_sha256: Some(&[1; 32]),
            content_blake3: Some(&[2; 32]),
            evidence: Some(&json!({"line": 80})),
            metadata: None,
        })
        .unwrap();
        assert_ne!(first_revision, second_revision);

        let edge = edge_uid(EdgeIdentityInput {
            project_uid: &project,
            source_uid: &source,
            target_uid: &target,
            relation: "calls",
            qualifier: None,
        })
        .unwrap();
        let occurrence = |line| {
            evidence_uid(EvidenceIdentityInput {
                edge_uid: &edge,
                path: Some("src/service.ts"),
                start_line: Some(line),
                start_column: Some(1),
                end_line: Some(line),
                end_column: Some(5),
                parser: "typescript-ast",
                parser_version: Some("5.9.3"),
                confidence: "exact",
            })
            .unwrap()
        };
        assert_ne!(occurrence(20), occurrence(80));
    }

    #[test]
    fn fixed_contract_vector() {
        let project = ProjectUid::from_slice(&[0x11; 16]).unwrap();
        let source = NodeUid::from_slice(&[0x22; 16]).unwrap();
        let target = NodeUid::from_slice(&[0x33; 16]).unwrap();
        let semantic = semantic(&project, Some(&source));
        let revision = revision_hash(RevisionIdentityInput {
            semantic: &semantic,
            lexical_owner_uid: Some(&source),
            display_name: Some("save"),
            source_sha256: Some(&[0x44; 32]),
            content_blake3: Some(&[0x55; 32]),
            evidence: Some(&json!({"line": 20})),
            metadata: Some(&json!({"visibility": "public"})),
        })
        .unwrap();
        let edge = edge_uid(EdgeIdentityInput {
            project_uid: &project,
            source_uid: &source,
            target_uid: &target,
            relation: "calls",
            qualifier: None,
        })
        .unwrap();
        let evidence = evidence_uid(EvidenceIdentityInput {
            edge_uid: &edge,
            path: Some("src/service.ts"),
            start_line: Some(20),
            start_column: Some(1),
            end_line: Some(20),
            end_column: Some(5),
            parser: "typescript-ast",
            parser_version: Some("5.9.3"),
            confidence: "exact",
        })
        .unwrap();
        assert_eq!(
            semantic.hash().to_string(),
            "blake3:75fb7469215f52aabd5001e7049b94da0abca7ab16e65f4233ecdfa34e318033"
        );
        assert_eq!(
            revision.to_string(),
            "sha256:f31d9fcaee9b354d3943a093c69860784e2e5ffeca5b18b987e4b32081524f20"
        );
        assert_eq!(
            edge.to_string(),
            "blake3:3c91ff8b65c82cc067a9c0887690370c3d3aa20689c0eaa067c5d57971d170ed"
        );
        assert_eq!(
            evidence.to_string(),
            "blake3:14f4260bed5b6876e9a9db6769e1409afd3a1d7a20aa9cff9b892a4f8eae5e26"
        );
    }
}
