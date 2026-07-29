use crate::js_facts::NativeJsFacts;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use crate::js_facts::js_locale_compare;

const RESOLVE_EXTENSIONS: &[&str] = &[
    "", ".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py", ".rs", ".svelte", ".vue", ".json",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResolvedImport {
    pub specifier: String,
    pub target_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResolvedPackage {
    pub specifier: String,
    pub package_path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExternalImport {
    pub specifier: String,
    pub node_type: String,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJsResolutionFacts {
    pub resolved_imports: Vec<NativeResolvedImport>,
    pub resolved_packages: Vec<NativeResolvedPackage>,
    pub external_imports: Vec<NativeExternalImport>,
}

fn normalize_relative(path: &Path) -> Option<String> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => segments.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                segments.pop()?;
            }
            _ => return None,
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

fn without_extension(path: &str) -> &str {
    let slash = path.rfind('/').map_or(0, |index| index + 1);
    path[slash..]
        .rfind('.')
        .map(|index| &path[..slash + index])
        .unwrap_or(path)
}

fn resolve_file(base: &str, known_paths: &BTreeSet<String>) -> Option<String> {
    let mut candidates = Vec::new();
    for extension in RESOLVE_EXTENSIONS {
        candidates.push(format!("{base}{extension}"));
    }
    for extension in &RESOLVE_EXTENSIONS[1..] {
        candidates.push(format!("{base}/index{extension}"));
    }
    candidates
        .into_iter()
        .find(|candidate| known_paths.contains(candidate))
}

fn resolve_relative(
    from_path: &str,
    specifier: &str,
    known_paths: &BTreeSet<String>,
) -> Option<String> {
    let parent = Path::new(from_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let base = normalize_relative(&parent.join(specifier))?;
    resolve_file(&base, known_paths).or_else(|| resolve_file(without_extension(&base), known_paths))
}

fn resolve_python_relative(
    from_path: &str,
    specifier: &str,
    known_paths: &BTreeSet<String>,
) -> Option<String> {
    let dots = specifier.bytes().take_while(|byte| *byte == b'.').count();
    if dots == 0 {
        return None;
    }
    let mut directory = Path::new(from_path).parent()?.to_path_buf();
    for _ in 1..dots {
        directory = directory.parent()?.to_path_buf();
    }
    let module = specifier[dots..].replace('.', "/");
    let base = normalize_relative(&directory.join(module))?;
    resolve_file(&base, known_paths).or_else(|| resolve_file(without_extension(&base), known_paths))
}

fn rust_module_directory(from_path: &str) -> Option<PathBuf> {
    let source = Path::new(from_path);
    let parent = source.parent()?.to_path_buf();
    let stem = source.file_stem()?.to_string_lossy();
    if matches!(stem.as_ref(), "lib" | "main" | "mod") {
        Some(parent)
    } else {
        Some(parent.join(stem.as_ref()))
    }
}

fn resolve_rust_import(
    _root: &Path,
    from_path: &str,
    specifier: &str,
    known_paths: &BTreeSet<String>,
) -> Option<String> {
    let segments = specifier
        .split("::")
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let first = *segments.first()?;
    if !["crate", "self", "super"].contains(&first) {
        return None;
    }
    let (base, consumed) = match first {
        "crate" => (PathBuf::from("src"), 1),
        "self" => (rust_module_directory(from_path)?, 1),
        "super" => {
            let supers = segments
                .iter()
                .take_while(|segment| **segment == "super")
                .count();
            let mut module = rust_module_directory(from_path)?;
            for _ in 0..supers {
                module = module.parent()?.to_path_buf();
            }
            (module, supers)
        }
        _ => return None,
    };
    let remaining = &segments[consumed..];
    for length in (1..=remaining.len()).rev() {
        let mut candidate = base.clone();
        for segment in &remaining[..length] {
            candidate.push(segment);
        }
        let candidate = normalize_relative(&candidate)?;
        if let Some(resolved) = resolve_file(&candidate, known_paths) {
            return Some(resolved);
        }
    }
    if remaining.is_empty() {
        return resolve_file(&normalize_relative(&base)?, known_paths);
    }
    None
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
}

fn dev_packages(root: &Path) -> BTreeSet<String> {
    read_json(&root.join("package.json"))
        .and_then(|manifest| manifest.get("devDependencies").cloned())
        .and_then(|value| value.as_object().cloned())
        .map(|dependencies| dependencies.into_iter().map(|(name, _)| name).collect())
        .unwrap_or_default()
}

fn package_name(specifier: &str) -> String {
    let parts = specifier.split('/').collect::<Vec<_>>();
    if specifier.starts_with('@') {
        parts.iter().take(2).copied().collect::<Vec<_>>().join("/")
    } else {
        parts.first().copied().unwrap_or(specifier).to_string()
    }
}

fn title_case(value: &str) -> String {
    value
        .trim_start_matches('@')
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            characters
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + characters.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn includes_any(value: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|candidate| value.contains(candidate))
}

fn package_kind(specifier: &str) -> &'static str {
    let name = package_name(specifier);
    if includes_any(
        &name,
        &[
            "prisma",
            "typeorm",
            "sequelize",
            "mongoose",
            "knex",
            "drizzle-orm",
            "postgres",
            "mysql",
            "sqlite",
            "redis",
            "mongo",
        ],
    ) {
        "database"
    } else if includes_any(
        &name,
        &["bull", "kafka", "rabbit", "amqp", "nats", "sqs", "queue"],
    ) {
        "queue"
    } else {
        "external"
    }
}

fn dependency_kind(specifier: &str, dev_packages: &BTreeSet<String>) -> &'static str {
    let name = package_name(specifier);
    if specifier.starts_with("$app/")
        || specifier.starts_with("$env/")
        || specifier == "$service-worker"
        || name == "svelte"
        || name == "@sveltejs/kit"
        || name.starts_with("@sveltejs/")
        || ["fastapi", "flask", "django"].contains(&name.as_str())
    {
        "framework"
    } else if includes_any(
        &name,
        &[
            "prisma",
            "typeorm",
            "sequelize",
            "mongoose",
            "knex",
            "drizzle-orm",
            "postgres",
            "mysql",
            "sqlite",
            "redis",
            "mongo",
            "bull",
            "kafka",
            "rabbit",
            "amqp",
            "nats",
            "sqs",
            "queue",
            "stripe",
            "twilio",
            "resend",
        ],
    ) {
        "runtime"
    } else if [
        "vite",
        "vitest",
        "eslint",
        "prettier",
        "tailwindcss",
        "postcss",
        "typescript",
        "tsx",
        "drizzle-kit",
        "playwright",
        "storybook",
        "pgtyped",
    ]
    .contains(&name.as_str())
        || name.starts_with("@eslint/")
        || name.starts_with("@typescript-eslint/")
        || dev_packages.contains(&name)
    {
        "devtool"
    } else {
        "package"
    }
}

fn is_node_builtin(specifier: &str) -> bool {
    let name = specifier.strip_prefix("node:").unwrap_or(specifier);
    [
        "assert",
        "async_hooks",
        "buffer",
        "child_process",
        "cluster",
        "console",
        "constants",
        "crypto",
        "dgram",
        "diagnostics_channel",
        "dns",
        "domain",
        "events",
        "fs",
        "http",
        "http2",
        "https",
        "module",
        "net",
        "os",
        "path",
        "perf_hooks",
        "process",
        "punycode",
        "querystring",
        "readline",
        "repl",
        "stream",
        "string_decoder",
        "sys",
        "timers",
        "tls",
        "trace_events",
        "tty",
        "url",
        "util",
        "v8",
        "vm",
        "wasi",
        "worker_threads",
        "zlib",
    ]
    .contains(&name)
}

fn is_java_standard_library(specifier: &str) -> bool {
    specifier.starts_with("java.") || specifier.starts_with("javax.")
}

fn external_import(specifier: &str, dev_packages: &BTreeSet<String>) -> NativeExternalImport {
    let name = package_name(specifier);
    let dependency_kind = dependency_kind(specifier, dev_packages);
    let node_type = if dependency_kind == "runtime" {
        package_kind(specifier)
    } else {
        "external"
    };
    let responsibility = match dependency_kind {
        "runtime" if node_type == "database" => "External runtime data store or ORM.",
        "runtime" if node_type == "queue" => "External runtime queue or messaging system.",
        "runtime" => "External runtime integration.",
        "framework" => "Framework or platform virtual module.",
        "devtool" => "Build, linting, testing, or development dependency.",
        _ => "Third-party library used by application code.",
    };
    NativeExternalImport {
        specifier: specifier.to_string(),
        node_type: node_type.to_string(),
        metadata: json!({
            "label": title_case(&name),
            "domain": "External",
            "layer": dependency_kind,
            "dependencyKind": dependency_kind,
            "detectedResponsibility": responsibility,
            "methods": [],
            "analysis": { "parser": "typescript-ast", "status": "resolved-import", "confidence": "exact" },
        }),
    }
}

fn resolve_configured_alias(
    root: &Path,
    specifier: &str,
    known_paths: &BTreeSet<String>,
) -> Option<String> {
    if specifier == "$lib" || specifier.starts_with("$lib/") {
        return resolve_file(
            &format!(
                "src/lib/{}",
                specifier.trim_start_matches("$lib").trim_start_matches('/')
            ),
            known_paths,
        );
    }
    if let Some(suffix) = specifier.strip_prefix("@/") {
        return resolve_file(&format!("src/{suffix}"), known_paths);
    }
    for filename in ["tsconfig.json", "jsconfig.json"] {
        let Some(config) = read_json(&root.join(filename)) else {
            continue;
        };
        let compiler = config.get("compilerOptions").and_then(Value::as_object);
        let base_url = compiler
            .and_then(|value| value.get("baseUrl"))
            .and_then(Value::as_str)
            .unwrap_or(".");
        if let Some(paths) = compiler
            .and_then(|value| value.get("paths"))
            .and_then(Value::as_object)
        {
            let mut patterns = paths.iter().collect::<Vec<_>>();
            patterns.sort_by(|(left, _), (right, _)| {
                right
                    .replace('*', "")
                    .len()
                    .cmp(&left.replace('*', "").len())
                    .then(left.cmp(right))
            });
            for (pattern, targets) in patterns {
                let wildcard = if let Some(index) = pattern.find('*') {
                    let (prefix, suffix) = pattern.split_at(index);
                    let suffix = &suffix[1..];
                    (specifier.starts_with(prefix) && specifier.ends_with(suffix))
                        .then(|| &specifier[prefix.len()..specifier.len() - suffix.len()])
                } else {
                    (pattern == specifier).then_some("")
                };
                let Some(wildcard) = wildcard else { continue };
                for target in targets
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    let candidate = PathBuf::from(base_url).join(target.replace('*', wildcard));
                    if let Some(relative) = normalize_relative(&candidate)
                        && let Some(resolved) = resolve_file(&relative, known_paths)
                    {
                        return Some(resolved);
                    }
                }
            }
        }
        if let Some(relative) = normalize_relative(&PathBuf::from(base_url).join(specifier))
            && let Some(resolved) = resolve_file(&relative, known_paths)
        {
            return Some(resolved);
        }
    }
    None
}

fn resolve_python_module(specifier: &str, known_paths: &BTreeSet<String>) -> Option<String> {
    if specifier.starts_with('.') || !specifier.contains('.') {
        return None;
    }
    let module = specifier.replace('.', "/");
    resolve_file(&module, known_paths)
        .or_else(|| resolve_file(&format!("src/{module}"), known_paths))
}

pub fn resolve_native_js_imports(
    root: &Path,
    facts: &BTreeMap<String, NativeJsFacts>,
    known_paths: &BTreeSet<String>,
) -> BTreeMap<String, NativeJsResolutionFacts> {
    let dev_packages = dev_packages(root);
    facts
        .iter()
        .map(|(path, fact)| {
            let mut result = NativeJsResolutionFacts {
                resolved_imports: Vec::new(),
                resolved_packages: Vec::new(),
                external_imports: Vec::new(),
            };
            for imported in &fact.structural.imports {
                let specifier = imported.specifier.as_str();
                let resolved = if path.ends_with(".rs") {
                    resolve_rust_import(root, path, specifier, known_paths)
                } else if specifier.starts_with('.') {
                    if path.ends_with(".py") {
                        resolve_python_relative(path, specifier, known_paths)
                    } else {
                        resolve_relative(path, specifier, known_paths)
                    }
                } else {
                    resolve_configured_alias(root, specifier, known_paths).or_else(|| {
                        if path.ends_with(".py") {
                            resolve_python_module(specifier, known_paths)
                        } else {
                            None
                        }
                    })
                };
                if let Some(target_path) = resolved {
                    result.resolved_imports.push(NativeResolvedImport {
                        specifier: specifier.to_string(),
                        target_path,
                    });
                // The JavaScript scanner never turns an unresolved relative
                // import (for example a CSS asset outside its resolver
                // extensions) into an external dependency node.
                } else if !specifier.starts_with('.')
                    && !is_node_builtin(specifier)
                    && !is_java_standard_library(specifier)
                {
                    result
                        .external_imports
                        .push(external_import(specifier, &dev_packages));
                }
            }
            result.resolved_imports.sort_by(|left, right| {
                js_locale_compare(&left.specifier, &right.specifier)
                    .then(js_locale_compare(&left.target_path, &right.target_path))
            });
            result.resolved_packages.sort_by(|left, right| {
                js_locale_compare(&left.specifier, &right.specifier)
                    .then(js_locale_compare(&left.package_path, &right.package_path))
            });
            result.external_imports.sort_by(|left, right| {
                js_locale_compare(&left.specifier, &right.specifier)
                    .then(js_locale_compare(&left.node_type, &right.node_type))
            });
            (path.clone(), result)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resolve_native_js_imports;
    use crate::js_facts::parse_native_js_facts;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;

    #[test]
    fn resolves_relative_alias_external_and_builtin_imports() {
        let facts = BTreeMap::from([(
            "src/index.ts".to_string(),
            parse_native_js_facts(
                "src/index.ts",
                "import './service'; import '@/shared'; import cron from 'node-cron'; import fs from 'node:fs';",
            )
            .unwrap(),
        )]);
        let known = BTreeSet::from([
            "src/index.ts".to_string(),
            "src/service.ts".to_string(),
            "src/shared.ts".to_string(),
        ]);
        let resolved = resolve_native_js_imports(Path::new("."), &facts, &known);
        let result = &resolved["src/index.ts"];
        assert_eq!(result.resolved_imports.len(), 2);
        assert_eq!(result.external_imports.len(), 1);
        assert_eq!(result.external_imports[0].specifier, "node-cron");
    }

    #[test]
    fn orders_resolution_results_with_javascript_locale_compatibility() {
        let facts = BTreeMap::from([(
            "src/index.ts".to_string(),
            parse_native_js_facts(
                "src/index.ts",
                "import local from '/src/local'; import mui from '@mui/material';",
            )
            .unwrap(),
        )]);
        let resolved = resolve_native_js_imports(Path::new("."), &facts, &BTreeSet::new());
        assert_eq!(
            resolved["src/index.ts"]
                .external_imports
                .iter()
                .map(|item| item.specifier.as_str())
                .collect::<Vec<_>>(),
            vec!["@mui/material", "/src/local"]
        );
    }
}
