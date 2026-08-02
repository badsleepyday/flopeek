use std::fmt;
use unicode_normalization::UnicodeNormalization;

pub const CANONICAL_ENCODING_SCHEMA: &str = "flopeek-identity-canonical/v1";
pub const MAX_IDENTITY_PATH_BYTES: usize = 4_096;
pub const MAX_IDENTITY_TEXT_BYTES: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    InvalidFieldName,
    InvalidIdentifier { field: &'static str },
    InvalidPath,
    Nul { field: &'static str },
    TooLong { field: &'static str, maximum: usize },
    InvalidDigestLength { field: &'static str, actual: usize },
    InvalidUuid,
    InvalidJson,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFieldName => write!(
                formatter,
                "canonical identity field names must be non-empty ASCII"
            ),
            Self::InvalidIdentifier { field } => write!(
                formatter,
                "{field} must be a lowercase portable identity token"
            ),
            Self::InvalidPath => write!(
                formatter,
                "identity path must be normalized and repository-relative"
            ),
            Self::Nul { field } => write!(formatter, "{field} must not contain NUL"),
            Self::TooLong { field, maximum } => write!(
                formatter,
                "{field} exceeds the {maximum}-byte identity limit"
            ),
            Self::InvalidDigestLength { field, actual } => write!(
                formatter,
                "{field} must contain 32 bytes, received {actual}"
            ),
            Self::InvalidUuid => write!(formatter, "identity UUID must contain 16 canonical bytes"),
            Self::InvalidJson => write!(formatter, "identity metadata must be canonical JSON"),
        }
    }
}

impl std::error::Error for IdentityError {}

pub fn normalized_text(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<String, IdentityError> {
    if value.contains('\0') {
        return Err(IdentityError::Nul { field });
    }
    let normalized = value.nfc().collect::<String>();
    if normalized.len() > maximum {
        return Err(IdentityError::TooLong { field, maximum });
    }
    Ok(normalized)
}

pub fn normalized_identifier(field: &'static str, value: &str) -> Result<String, IdentityError> {
    let normalized = normalized_text(field, value, 128)?;
    if normalized.is_empty()
        || !normalized.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
    {
        return Err(IdentityError::InvalidIdentifier { field });
    }
    Ok(normalized)
}

pub fn normalized_repository_path(value: &str) -> Result<String, IdentityError> {
    let normalized = normalized_text("path", &value.replace('\\', "/"), MAX_IDENTITY_PATH_BYTES)?;
    let bytes = normalized.as_bytes();
    if normalized.is_empty()
        || normalized.starts_with('/')
        || bytes.get(1) == Some(&b':')
        || normalized
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(IdentityError::InvalidPath);
    }
    Ok(normalized)
}

#[derive(Debug, Clone)]
pub struct CanonicalEncoder {
    bytes: Vec<u8>,
}

impl CanonicalEncoder {
    pub fn new(record_schema: &str) -> Result<Self, IdentityError> {
        let mut encoder = Self { bytes: Vec::new() };
        encoder
            .bytes
            .extend_from_slice(CANONICAL_ENCODING_SCHEMA.as_bytes());
        encoder.bytes.push(0);
        encoder.field_bytes("record_schema", Some(record_schema.as_bytes()))?;
        Ok(encoder)
    }

    pub fn field_text(&mut self, name: &str, value: Option<&str>) -> Result<(), IdentityError> {
        self.field_bytes(name, value.map(str::as_bytes))
    }

    pub fn field_bytes(&mut self, name: &str, value: Option<&[u8]>) -> Result<(), IdentityError> {
        if name.is_empty() || !name.is_ascii() || name.len() > u16::MAX as usize {
            return Err(IdentityError::InvalidFieldName);
        }
        self.bytes
            .extend_from_slice(&(name.len() as u16).to_be_bytes());
        self.bytes.extend_from_slice(name.as_bytes());
        match value {
            Some(value) => {
                if value.len() > u32::MAX as usize {
                    return Err(IdentityError::TooLong {
                        field: "canonical-field",
                        maximum: u32::MAX as usize,
                    });
                }
                self.bytes.push(1);
                self.bytes
                    .extend_from_slice(&(value.len() as u32).to_be_bytes());
                self.bytes.extend_from_slice(value);
            }
            None => self.bytes.push(0),
        }
        Ok(())
    }

    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::{CanonicalEncoder, IdentityError, normalized_repository_path, normalized_text};

    #[test]
    fn canonical_fields_distinguish_missing_and_empty_values() {
        let mut missing = CanonicalEncoder::new("test/v1").unwrap();
        missing.field_text("value", None).unwrap();
        let mut empty = CanonicalEncoder::new("test/v1").unwrap();
        empty.field_text("value", Some("")).unwrap();
        assert_ne!(missing.finish(), empty.finish());
    }

    #[test]
    fn paths_are_portable_and_unicode_is_nfc() {
        assert_eq!(
            normalized_repository_path("src\\cafe\u{301}.ts").unwrap(),
            "src/caf\u{e9}.ts"
        );
        assert_eq!(
            normalized_text("name", "cafe\u{301}", 32).unwrap(),
            "caf\u{e9}"
        );
        for invalid in [
            "../secret",
            "src/../secret",
            "/absolute",
            "C:/absolute",
            "src//file.rs",
            "src/./file.rs",
        ] {
            assert_eq!(
                normalized_repository_path(invalid),
                Err(IdentityError::InvalidPath)
            );
        }
        assert!(matches!(
            normalized_repository_path("src/a\0.rs"),
            Err(IdentityError::Nul { .. })
        ));
    }
}
