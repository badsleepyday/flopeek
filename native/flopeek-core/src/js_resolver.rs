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
    pub metadata: Value,
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
    // `use super::shared` can name an item declared directly in the owning
    // module rather than a child module file.  Resolve that final symbol to
    // the module source so call binding can prove the item from cached facts.
    if remaining.len() == 1 {
        let base = normalize_relative(&base)?;
        for owner in [
            format!("{base}.rs"),
            format!("{base}/mod.rs"),
            format!("{base}/lib.rs"),
            format!("{base}/main.rs"),
        ] {
            if known_paths.contains(&owner) {
                return Some(owner);
            }
        }
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
    let parts = specifier.split(['\\', '/', ':']).collect::<Vec<_>>();
    if specifier.starts_with('@') {
        parts.iter().take(2).copied().collect::<Vec<_>>().join("/")
    } else {
        parts.first().copied().unwrap_or(specifier).to_string()
    }
}

fn workspace_segment_matches(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let parts = pattern.split('*').collect::<Vec<_>>();
    let mut offset = 0;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let Some(found) = value[offset..].find(part).map(|found| found + offset) else {
            return false;
        };
        if index == 0 && !pattern.starts_with('*') && found != 0 {
            return false;
        }
        offset = found + part.len();
    }
    pattern.ends_with('*') || parts.last().is_none_or(|last| value.ends_with(last))
}

fn workspace_path_matches(pattern: &str, relative_path: &str) -> bool {
    let pattern = pattern.trim_start_matches("./").trim_end_matches('/');
    let pattern = pattern
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let path = relative_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    fn matches(pattern: &[&str], path: &[&str]) -> bool {
        let Some((head, tail)) = pattern.split_first() else {
            return path.is_empty();
        };
        if *head == "**" {
            return (0..=path.len()).any(|index| matches(tail, &path[index..]));
        }
        path.split_first().is_some_and(|(value, remainder)| {
            workspace_segment_matches(head, value) && matches(tail, remainder)
        })
    }
    matches(&pattern, &path)
}

fn workspace_patterns(root: &Path) -> Vec<String> {
    let Some(manifest) = read_json(&root.join("package.json")) else {
        return Vec::new();
    };
    let workspaces = manifest.get("workspaces");
    let values = workspaces
        .and_then(Value::as_array)
        .or_else(|| workspaces?.get("packages")?.as_array());
    values
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn static_export_targets(value: &Value) -> Vec<String> {
    match value {
        Value::String(target) => vec![target.clone()],
        Value::Array(values) => values.iter().flat_map(static_export_targets).collect(),
        Value::Object(values) => ["import", "node", "default", "require", "types"]
            .iter()
            .find_map(|condition| values.get(*condition))
            .map(static_export_targets)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn workspace_targets(manifest: &Value, subpath: &str) -> Vec<String> {
    if let Some(exports) = manifest.get("exports") {
        match exports {
            Value::String(_) | Value::Array(_) if subpath.is_empty() => {
                return static_export_targets(exports);
            }
            Value::Object(exports) => {
                let key = if subpath.is_empty() {
                    ".".to_string()
                } else {
                    format!("./{subpath}")
                };
                if let Some(value) = exports.get(&key) {
                    return static_export_targets(value);
                }
                if subpath.is_empty() && exports.keys().all(|key| !key.starts_with('.')) {
                    return static_export_targets(&Value::Object(exports.clone()));
                }
            }
            _ => {}
        }
    }
    if !subpath.is_empty() {
        return vec![format!("./{subpath}"), format!("./src/{subpath}")];
    }
    ["module", "main", "source", "types"]
        .iter()
        .filter_map(|field| manifest.get(*field).and_then(Value::as_str))
        .map(str::to_owned)
        .chain(["./src/index".to_string(), "./index".to_string()])
        .collect()
}

fn resolve_workspace_import(
    root: &Path,
    specifier: &str,
    known_paths: &BTreeSet<String>,
) -> Option<String> {
    let patterns = workspace_patterns(root);
    if patterns.is_empty() {
        return None;
    }
    let positive = patterns
        .iter()
        .filter(|pattern| !pattern.starts_with('!'))
        .collect::<Vec<_>>();
    let negative = patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('!'))
        .collect::<Vec<_>>();
    let requested_name = package_name(specifier);
    let mut directories = BTreeSet::new();
    for known in known_paths {
        let mut directory = Path::new(known).parent().unwrap_or_else(|| Path::new(""));
        loop {
            if let Some(relative) = normalize_relative(directory) {
                directories.insert(relative);
            }
            let Some(parent) = directory.parent() else {
                break;
            };
            if parent == directory {
                break;
            }
            directory = parent;
        }
    }
    for directory in directories {
        let manifest_path = root.join(&directory).join("package.json");
        let Some(manifest) = read_json(&manifest_path) else {
            continue;
        };
        if !positive
            .iter()
            .any(|pattern| workspace_path_matches(pattern, &directory))
            || negative
                .iter()
                .any(|pattern| workspace_path_matches(pattern, &directory))
            || manifest.get("name").and_then(Value::as_str) != Some(requested_name.as_str())
        {
            continue;
        }
        let subpath = specifier
            .strip_prefix(&requested_name)
            .unwrap_or_default()
            .trim_start_matches('/');
        for target in workspace_targets(&manifest, subpath) {
            if !target.starts_with('.') {
                continue;
            }
            let relative = normalize_relative(&Path::new(&directory).join(target))?;
            if let Some(resolved) = resolve_file(&relative, known_paths)
                .or_else(|| resolve_file(without_extension(&relative), known_paths))
            {
                return Some(resolved);
            }
        }
    }
    None
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

fn title_case_path(value: &str) -> String {
    let mut result = String::new();
    let mut previous_was_lower = false;
    for character in value.chars() {
        let separator = ".-_/@".contains(character);
        let uppercase = character.is_ascii_uppercase();
        if separator {
            if !result.is_empty() && !result.ends_with(' ') {
                result.push(' ');
            }
        } else {
            if uppercase && previous_was_lower && !result.ends_with(' ') {
                result.push(' ');
            }
            if result.is_empty() || result.ends_with(' ') {
                result.push(character.to_ascii_uppercase());
            } else {
                result.push(character);
            }
        }
        previous_was_lower = character.is_ascii_lowercase();
    }
    result.trim().to_string()
}

fn go_package_metadata(package_path: &str, files: &[String]) -> Value {
    let parts = package_path.split('/').collect::<Vec<_>>();
    let source_root = parts
        .iter()
        .position(|part| ["src", "apps", "packages", "modules", "services"].contains(part));
    let candidate = source_root
        .and_then(|index| parts.get(index + 1))
        .or_else(|| parts.first())
        .copied()
        .unwrap_or(".");
    let domain =
        if candidate.contains('.') || ["index", "main", "app", "routes"].contains(&candidate) {
            "Project".to_string()
        } else {
            title_case_path(candidate)
        };
    let feature_parts = source_root
        .map(|index| &parts[index + 1..])
        .unwrap_or(parts.as_slice());
    let feature = feature_parts.first().copied().unwrap_or("project");
    let feature = if feature.contains('.') {
        "project".to_string()
    } else {
        feature.to_string()
    };
    let basename = parts.last().copied().unwrap_or(".");
    json!({
        "label": if package_path == "." { "Root Go package".to_string() } else { title_case_path(basename) },
        "domain": domain,
        "feature": feature,
        "layer": "application",
        "detectedResponsibility": "Internal Go package resolved statically from go.mod.",
        "methods": [],
        "language": "go",
        "analysis": { "parser": "go-module-resolver", "status": "resolved-import", "confidence": "exact" },
        "evidence": { "file": package_path },
        "files": files,
    })
}

fn go_module_declaration(root: &Path, from_path: &str) -> Option<(String, String)> {
    let mut directory = Path::new(from_path).parent()?.to_path_buf();
    loop {
        let relative = normalize_relative(&directory).unwrap_or_default();
        let manifest = root.join(&directory).join("go.mod");
        if let Ok(contents) = std::fs::read_to_string(manifest) {
            let module = contents.lines().find_map(|line| {
                let line = line.trim();
                line.strip_prefix("module ")
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })?;
            return Some((
                module,
                if relative.is_empty() {
                    ".".into()
                } else {
                    relative
                },
            ));
        }
        if directory.as_os_str().is_empty() || !directory.pop() {
            break;
        }
    }
    None
}

fn resolve_go_module(
    root: &Path,
    from_path: &str,
    specifier: &str,
    known_paths: &BTreeSet<String>,
) -> Option<Result<NativeResolvedImport, NativeResolvedPackage>> {
    let (module, module_directory) = go_module_declaration(root, from_path)?;
    let suffix = if specifier == module {
        ""
    } else {
        specifier.strip_prefix(&format!("{module}/"))?
    };
    let package_path = match (module_directory.as_str(), suffix) {
        (".", "") => ".".to_string(),
        (".", suffix) => suffix.to_string(),
        (base, "") => base.to_string(),
        (base, suffix) => format!("{base}/{suffix}"),
    };
    let mut files = known_paths
        .iter()
        .filter(|path| path.ends_with(".go") && !path.ends_with("_test.go"))
        .filter(|path| {
            let parent = Path::new(path)
                .parent()
                .and_then(normalize_relative)
                .unwrap_or_else(|| ".".to_string());
            parent == package_path
        })
        .cloned()
        .collect::<Vec<_>>();
    files.sort_by(|left, right| js_locale_compare(left, right));
    match files.as_slice() {
        [] => None,
        [target_path] => Some(Ok(NativeResolvedImport {
            specifier: specifier.to_string(),
            target_path: target_path.clone(),
        })),
        _ => Some(Err(NativeResolvedPackage {
            specifier: specifier.to_string(),
            package_path: package_path.clone(),
            metadata: go_package_metadata(&package_path, &files),
            files,
        })),
    }
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
                if path.ends_with(".go")
                    && let Some(go_resolution) =
                        resolve_go_module(root, path, specifier, known_paths)
                {
                    match go_resolution {
                        Ok(value) => result.resolved_imports.push(value),
                        Err(value) => result.resolved_packages.push(value),
                    }
                    continue;
                }
                let resolved = if path.ends_with(".rs") {
                    resolve_rust_import(root, path, specifier, known_paths)
                } else if specifier.starts_with('.') {
                    if path.ends_with(".py") {
                        resolve_python_relative(path, specifier, known_paths)
                    } else {
                        resolve_relative(path, specifier, known_paths)
                    }
                } else {
                    resolve_configured_alias(root, specifier, known_paths)
                        .or_else(|| resolve_workspace_import(root, specifier, known_paths))
                        .or_else(|| {
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
                    && !(path.ends_with(".rs")
                        && ["crate::", "self::", "super::"]
                            .iter()
                            .any(|prefix| specifier.starts_with(prefix)))
                    && imported.standard != Some(true)
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
    use super::{package_name, resolve_native_js_imports};
    use crate::js_facts::parse_native_js_facts;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn external_package_names_match_javascript_separator_normalization() {
        assert_eq!(package_name("App\\Helper"), "App");
        assert_eq!(package_name("node:fs"), "node");
        assert_eq!(package_name("@scope/tool/runtime"), "@scope/tool");
    }

    #[test]
    fn unresolved_rust_internal_paths_do_not_become_external_packages() {
        let facts = BTreeMap::from([(
            "src/lib.rs".to_string(),
            parse_native_js_facts(
                "src/lib.rs",
                "use crate::missing::ping;\npub fn run() { ping(); }\n",
            )
            .unwrap(),
        )]);
        let known = BTreeSet::from(["src/lib.rs".to_string()]);
        let resolved = resolve_native_js_imports(Path::new("."), &facts, &known);
        assert!(resolved["src/lib.rs"].resolved_imports.is_empty());
        assert!(resolved["src/lib.rs"].external_imports.is_empty());
    }

    #[test]
    fn resolves_super_item_to_the_parent_module_source() {
        let facts = BTreeMap::from([
            (
                "src/area/child.rs".to_string(),
                parse_native_js_facts(
                    "src/area/child.rs",
                    "use super::shared;\npub fn run() { shared(); }\n",
                )
                .unwrap(),
            ),
            (
                "src/area/mod.rs".to_string(),
                parse_native_js_facts("src/area/mod.rs", "pub fn shared() {}\n").unwrap(),
            ),
        ]);
        let known = facts.keys().cloned().collect::<BTreeSet<_>>();
        let resolved = resolve_native_js_imports(Path::new("."), &facts, &known);
        assert_eq!(
            resolved["src/area/child.rs"].resolved_imports[0].target_path,
            "src/area/mod.rs"
        );
    }

    #[test]
    fn resolves_declared_workspace_package_exports_without_javascript() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "flopeek-native-workspace-resolution-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("packages/core")).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"workspaces":["packages/*"]}"#,
        )
        .unwrap();
        fs::write(
            root.join("packages/core/package.json"),
            r#"{"name":"@parity/core","exports":{".":"./src/index.ts"}}"#,
        )
        .unwrap();
        let facts = BTreeMap::from([
            (
                "apps/api/src/main.ts".to_string(),
                parse_native_js_facts(
                    "apps/api/src/main.ts",
                    "import { ping } from '@parity/core';\nexport function main() { ping(); }\n",
                )
                .unwrap(),
            ),
            (
                "packages/core/src/index.ts".to_string(),
                parse_native_js_facts("packages/core/src/index.ts", "export function ping() {}\n")
                    .unwrap(),
            ),
        ]);
        let known = facts.keys().cloned().collect::<BTreeSet<_>>();
        let resolved = resolve_native_js_imports(&root, &facts, &known);
        assert_eq!(
            resolved["apps/api/src/main.ts"].resolved_imports[0].target_path,
            "packages/core/src/index.ts"
        );
        assert!(resolved["apps/api/src/main.ts"].external_imports.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
