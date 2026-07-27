use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

pub const SCOPE_CONFIG_RELATIVE_PATH: &str = ".flopeek/config.json";
const CONFIG_SCHEMA_VERSION: i64 = 1;
const DEFAULT_TEST_ROOTS: &[&str] = &["test", "tests", "__tests__"];
const DEFAULT_FIXTURE_ROOTS: &[&str] = &["test/fixtures", "tests/fixtures", "__fixtures__"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceScope {
    Application,
    Test,
    Fixture,
    Generated,
    Excluded,
}

impl SourceScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Test => "test",
            Self::Fixture => "fixture",
            Self::Generated => "generated",
            Self::Excluded => "excluded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeScope {
    pub source: String,
    pub project_id: Option<String>,
    source_roots: Vec<String>,
    test_roots: Vec<String>,
    fixture_roots: Vec<String>,
    exclude: Vec<String>,
}

fn normalise_rule(value: &str, field: &str, allow_glob: bool) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} entries must be non-empty strings."));
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with("\\\\")
        || (trimmed.len() > 1 && trimmed.as_bytes()[1] == b':')
    {
        return Err(format!(
            "{field} entries must be repository-relative paths."
        ));
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    normalized = normalized.trim_end_matches('/').to_string();
    if normalized.is_empty() {
        normalized = ".".to_string();
    }
    let segments = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.iter().any(|segment| *segment == "..") {
        return Err(format!(
            "{field} entries must not traverse outside the repository."
        ));
    }
    for segment in &segments {
        if !segment.contains('*') {
            continue;
        }
        if !allow_glob || (*segment != "*" && *segment != "**") {
            return Err(format!(
                "{field} supports only whole-segment * and ** globs."
            ));
        }
    }
    Ok(normalized)
}

fn path_list(
    value: Option<&Value>,
    field: &str,
    defaults: &[&str],
    allow_glob: bool,
) -> Result<Vec<String>, String> {
    let values = match value {
        None => defaults
            .iter()
            .map(|value| Value::String((*value).to_string()))
            .collect::<Vec<_>>(),
        Some(Value::Array(values)) => values.clone(),
        Some(_) => {
            return Err(format!(
                "{field} must be an array of repository-relative paths."
            ));
        }
    };
    let mut normalized = BTreeSet::new();
    for value in values {
        let Some(value) = value.as_str() else {
            return Err(format!("{field} entries must be non-empty strings."));
        };
        normalized.insert(normalise_rule(value, field, allow_glob)?);
    }
    Ok(normalized.into_iter().collect())
}

fn valid_project_id(value: &str) -> bool {
    value.len() >= 8
        && value.len() <= 160
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ':' | '.' | '_' | '-')
        })
}

fn path_within_root(path: &str, root: &str) -> bool {
    root == "." || path == root || path.starts_with(&format!("{root}/"))
}

fn matches_pattern(path_segments: &[&str], pattern_segments: &[&str]) -> bool {
    match pattern_segments.split_first() {
        None => path_segments.is_empty(),
        Some((&"**", rest)) => {
            (0..=path_segments.len()).any(|index| matches_pattern(&path_segments[index..], rest))
        }
        Some((&pattern, rest)) => path_segments
            .split_first()
            .is_some_and(|(path, remaining)| {
                (pattern == "*" || pattern == *path) && matches_pattern(remaining, rest)
            }),
    }
}

fn matches_exclude(path: &str, pattern: &str) -> bool {
    if !pattern.contains('*') {
        return path_within_root(path, pattern);
    }
    matches_pattern(
        &path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>(),
        &pattern
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>(),
    )
}

fn looks_like_test(path: &str) -> bool {
    let segments = path
        .to_ascii_lowercase()
        .split('/')
        .map(str::to_string)
        .collect::<Vec<_>>();
    let filename = segments.last().map(String::as_str).unwrap_or_default();
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename);
    segments.iter().any(|segment| segment == "__tests__")
        || stem.contains(".test")
        || stem.contains(".spec")
        || stem.ends_with("_test")
}

fn looks_generated(path: &str) -> bool {
    let segments = path
        .to_ascii_lowercase()
        .split('/')
        .map(str::to_string)
        .collect::<Vec<_>>();
    let filename = segments.last().map(String::as_str).unwrap_or_default();
    segments
        .iter()
        .any(|segment| segment == "generated" || segment == "__generated__")
        || filename.contains(".generated.")
}

impl NativeScope {
    pub fn classify(&self, path: &str) -> SourceScope {
        if self
            .exclude
            .iter()
            .any(|pattern| matches_exclude(path, pattern))
        {
            return SourceScope::Excluded;
        }
        if self
            .fixture_roots
            .iter()
            .any(|root| path_within_root(path, root))
        {
            return SourceScope::Fixture;
        }
        if self
            .test_roots
            .iter()
            .any(|root| path_within_root(path, root))
            || looks_like_test(path)
        {
            return SourceScope::Test;
        }
        if looks_generated(path) {
            return SourceScope::Generated;
        }
        if !self.source_roots.is_empty()
            && !self
                .source_roots
                .iter()
                .any(|root| path_within_root(path, root))
        {
            return SourceScope::Excluded;
        }
        SourceScope::Application
    }
}

pub fn read_native_scope(root: &Path) -> Result<NativeScope, String> {
    let config_path = root.join(SCOPE_CONFIG_RELATIVE_PATH);
    if !config_path.exists() {
        return Ok(NativeScope {
            source: "defaults".to_string(),
            project_id: None,
            source_roots: Vec::new(),
            test_roots: DEFAULT_TEST_ROOTS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            fixture_roots: DEFAULT_FIXTURE_ROOTS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            exclude: Vec::new(),
        });
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("Unable to read .flopeek/config.json: {error}"))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!(".flopeek/config.json is not valid JSON ({error})."))?;
    let Some(object) = value.as_object() else {
        return Err(".flopeek/config.json must contain an object.".to_string());
    };
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "schemaVersion"
                | "sourceRoots"
                | "testRoots"
                | "fixtureRoots"
                | "exclude"
                | "projectId"
                | "flowEntries"
        ) {
            return Err(format!(
                ".flopeek/config.json has unknown property \"{key}\"."
            ));
        }
    }
    if object.get("schemaVersion").and_then(Value::as_i64) != Some(CONFIG_SCHEMA_VERSION) {
        return Err(".flopeek/config.json schemaVersion must be 1.".to_string());
    }
    let project_id = match object.get("projectId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if valid_project_id(value) => Some(value.clone()),
        Some(_) => {
            return Err(
                ".flopeek/config.json projectId must be null or a stable safe identifier."
                    .to_string(),
            );
        }
    };
    if let Some(flow_entries) = object.get("flowEntries") {
        let Some(flow_entries) = flow_entries.as_object() else {
            return Err(".flopeek/config.json flowEntries must be an object.".to_string());
        };
        for (key, value) in flow_entries {
            if !matches!(key.as_str(), "tests" | "fixtures") || !value.is_boolean() {
                return Err(".flopeek/config.json flowEntries is invalid.".to_string());
            }
        }
    }
    Ok(NativeScope {
        source: "config".to_string(),
        project_id,
        source_roots: path_list(object.get("sourceRoots"), "sourceRoots", &[], false)?,
        test_roots: path_list(
            object.get("testRoots"),
            "testRoots",
            DEFAULT_TEST_ROOTS,
            false,
        )?,
        fixture_roots: path_list(
            object.get("fixtureRoots"),
            "fixtureRoots",
            DEFAULT_FIXTURE_ROOTS,
            false,
        )?,
        exclude: path_list(object.get("exclude"), "exclude", &[], true)?,
    })
}
