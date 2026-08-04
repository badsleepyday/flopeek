use crate::identity::{NodeIdentity, semantic_key, stable_node_id};
use crate::project_identity::{
    ProjectIdentity, resolve_ephemeral_project_identity, resolve_project_identity,
};
use crate::scope::{NativeScope, SourceScope, read_native_scope};
use crate::store::open_native_store;
use blake3::Hasher;
use rayon::prelude::*;
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const NATIVE_INVENTORY_SCHEMA: &str = "flopeek-native-inventory/v1";
pub const MAX_NATIVE_SOURCE_FILE_BYTES: u64 = 1_000_000;
/// Ephemeral JSONL source transfer is deliberately bounded. It may reduce
/// duplicate cold-scan reads, but must never become a source-body cache.
const MAX_SOURCE_BATCH_BYTES: usize = 32 * 1024 * 1024;
const IGNORED_DIRECTORIES: &[&str] = &[
    ".flopeek",
    ".git",
    ".next",
    ".nuxt",
    ".project-flow",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
];
const REGISTERED_EXTENSIONS: &[&str] = &[
    ".asm", ".astro", ".bash", ".c", ".cc", ".cjs", ".cpp", ".cs", ".cxx", ".go", ".h", ".java",
    ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".rb", ".rs", ".scala", ".sh", ".svelte",
    ".swift", ".ts", ".tsx", ".vue", ".zsh",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct CandidateFile {
    path: String,
    size_bytes: i64,
    modified_at_ns: i64,
    source_scope: SourceScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CachedFile {
    size_bytes: i64,
    modified_at_ns: i64,
    content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InventoryRecord {
    candidate: CandidateFile,
    content_hash: String,
}

/// Limits checked during bounded discovery. This keeps an over-limit package
/// from completing an otherwise unbounded metadata traversal before rejection.
struct CandidateCollectionLimits {
    max_files: Option<usize>,
    max_bytes: Option<i64>,
    started: Instant,
    budget_ms: Option<u64>,
    total_bytes: i64,
}

impl CandidateCollectionLimits {
    fn check_budget(&self) -> Result<(), String> {
        if let Some(limit) = self.budget_ms
            && self.started.elapsed().as_millis() > u128::from(limit)
        {
            return Err(format!("native-bounded-budget-exceeded:{limit}"));
        }
        Ok(())
    }

    fn accept(&mut self, candidate: &CandidateFile, existing_files: usize) -> Result<(), String> {
        self.check_budget()?;
        let next_files = existing_files
            .checked_add(1)
            .ok_or_else(|| "native-bounded-max-files-exceeded:overflow".to_string())?;
        if let Some(limit) = self.max_files
            && next_files > limit
        {
            return Err(format!(
                "native-bounded-max-files-exceeded:{limit}:{next_files}"
            ));
        }
        self.total_bytes = self
            .total_bytes
            .checked_add(candidate.size_bytes)
            .ok_or_else(|| "native-bounded-max-bytes-exceeded:overflow".to_string())?;
        if let Some(limit) = self.max_bytes
            && self.total_bytes > limit
        {
            return Err(format!(
                "native-bounded-max-bytes-exceeded:{limit}:{}",
                self.total_bytes
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeSourceBatchRecord {
    pub path: String,
    pub utf8: String,
    pub size_bytes: i64,
    pub modified_at_ns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeInventoryStatus {
    pub project_root: PathBuf,
    pub project_identity: ProjectIdentity,
    pub scope_source: String,
    pub source_scope_counts: BTreeMap<String, usize>,
    pub source_fingerprint: String,
    pub candidate_files: usize,
    pub hashed_files: usize,
    pub reused_files: usize,
    pub removed_files: usize,
    pub candidate_paths: Option<Vec<String>>,
    pub changed_paths: Vec<String>,
    pub reused_paths: Vec<String>,
    pub removed_paths: Vec<String>,
    pub source_batch_records: Option<Vec<NativeSourceBatchRecord>>,
    pub source_batch_omitted_files: usize,
    /// Parser input retained transiently from the same read used for the
    /// inventory hash. It is never serialized or persisted; the durable path
    /// uses it only to avoid reading a cold source file twice.
    pub ephemeral_source_texts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeIncrementalManifest {
    pub inventory: NativeInventoryStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeBoundedCandidate {
    pub path: String,
    pub size_bytes: i64,
    pub modified_at_ns: i64,
    pub source_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeBoundedDiscovery {
    pub project_root: PathBuf,
    pub package_path: Option<String>,
    pub scope_source: String,
    pub candidates: Vec<NativeBoundedCandidate>,
    pub total_bytes: i64,
    pub plan_fingerprint: String,
}

fn now_millis() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock precedes Unix epoch: {error}"))?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| "Current time exceeds SQLite integer range.".to_string())
}

fn modified_at_ns(metadata: &fs::Metadata) -> Result<i64, String> {
    let elapsed = metadata
        .modified()
        .map_err(|error| format!("Unable to read file modification time: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("File modification time precedes Unix epoch: {error}"))?;
    i64::try_from(elapsed.as_nanos())
        .map_err(|_| "File modification time exceeds SQLite integer range.".to_string())
}

fn normalized_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| format!("Inventory path is outside project root: {error}"))?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn is_registered_source_path(path: &Path) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    let name = name.to_string_lossy().to_lowercase();
    if name == "makefile" {
        return true;
    }
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_lowercase()));
    extension.is_some_and(|extension| REGISTERED_EXTENSIONS.contains(&extension.as_str()))
}

fn collect_candidates(
    root: &Path,
    directory: &Path,
    scope: &NativeScope,
    source_scope_counts: &mut BTreeMap<String, usize>,
    output: &mut Vec<CandidateFile>,
) -> Result<(), String> {
    collect_candidates_with_limits(root, directory, scope, source_scope_counts, output, None)
}

fn collect_candidates_with_limits(
    root: &Path,
    directory: &Path,
    scope: &NativeScope,
    source_scope_counts: &mut BTreeMap<String, usize>,
    output: &mut Vec<CandidateFile>,
    mut limits: Option<&mut CandidateCollectionLimits>,
) -> Result<(), String> {
    if let Some(limits) = limits.as_deref_mut() {
        limits.check_budget()?;
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to enumerate {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Unable to read directory entry in {}: {error}",
                directory.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if let Some(limits) = limits.as_deref_mut() {
            limits.check_budget()?;
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read type for {}: {error}", path.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_dir() {
            if !name.starts_with('.') && !IGNORED_DIRECTORIES.contains(&name.as_ref()) {
                collect_candidates_with_limits(
                    root,
                    &path,
                    scope,
                    source_scope_counts,
                    output,
                    limits.as_deref_mut(),
                )?;
            }
            continue;
        }
        if !file_type.is_file() || !is_registered_source_path(&path) {
            continue;
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to read metadata for {}: {error}", path.display()))?;
        if metadata.len() > MAX_NATIVE_SOURCE_FILE_BYTES {
            continue;
        }
        let relative_path = normalized_relative_path(root, &path)?;
        let source_scope = scope.classify(&relative_path);
        *source_scope_counts
            .entry(source_scope.as_str().to_string())
            .or_default() += 1;
        if source_scope == SourceScope::Excluded {
            continue;
        }
        let candidate = CandidateFile {
            path: relative_path,
            size_bytes: i64::try_from(metadata.len()).map_err(|_| {
                format!("File size exceeds SQLite integer range: {}", path.display())
            })?,
            modified_at_ns: modified_at_ns(&metadata)?,
            source_scope,
        };
        if let Some(limits) = limits.as_deref_mut() {
            limits.accept(&candidate, output.len())?;
        }
        output.push(candidate);
    }
    Ok(())
}

fn displayable_root(root: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(value) = root.to_str().and_then(|value| value.strip_prefix(r"\\?\")) {
        return PathBuf::from(value);
    }
    root
}

fn content_hash(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

fn source_fingerprint(records: &[InventoryRecord]) -> String {
    let mut hasher = Hasher::new();
    for record in records {
        hasher.update(record.candidate.path.as_bytes());
        hasher.update(&[0]);
        hasher.update(record.candidate.source_scope.as_str().as_bytes());
        hasher.update(&[0]);
        hasher.update(record.content_hash.as_bytes());
        hasher.update(b"\n");
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn migrate_legacy_path_identity(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> Result<(), String> {
    let current = connection
        .query_row(
            "SELECT project_pk FROM projects WHERE project_id = ?1",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if current.is_some() {
        return Ok(());
    }
    let legacy = connection
        .prepare("SELECT project_pk FROM projects WHERE project_id LIKE 'project:v1:%'")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if legacy.len() == 1 {
        connection
            .execute(
                "UPDATE projects SET project_id = ?1 WHERE project_pk = ?2",
                params![project_id, legacy[0]],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn scan_native_inventory_with_options(
    input_root: &Path,
    include_paths: bool,
    include_source_batch: bool,
    include_native_source_texts: bool,
) -> Result<NativeInventoryStatus, String> {
    let root = displayable_root(fs::canonicalize(input_root).map_err(|error| {
        format!(
            "Unable to resolve project root {}: {error}",
            input_root.display()
        )
    })?);
    if !root.is_dir() {
        return Err(format!(
            "Native inventory root is not a directory: {}",
            root.display()
        ));
    }
    let scope = read_native_scope(&root)?;
    let project_identity = resolve_project_identity(&root, scope.project_id.as_deref())?;
    let mut source_scope_counts = [
        SourceScope::Application,
        SourceScope::Test,
        SourceScope::Fixture,
        SourceScope::Generated,
        SourceScope::Excluded,
    ]
    .into_iter()
    .map(|source_scope| (source_scope.as_str().to_string(), 0))
    .collect::<BTreeMap<_, _>>();
    let mut candidates = Vec::new();
    collect_candidates(
        &root,
        &root,
        &scope,
        &mut source_scope_counts,
        &mut candidates,
    )?;
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    let created_at_ms = now_millis()?;
    let mut connection = open_native_store(&root).map_err(|error| error.to_string())?;
    migrate_legacy_path_identity(&connection, &project_identity.project_id)?;
    connection
        .execute(
            "INSERT INTO projects(project_id, created_at_ms) VALUES (?1, ?2)
             ON CONFLICT(project_id) DO NOTHING",
            params![project_identity.project_id, created_at_ms],
        )
        .map_err(|error| error.to_string())?;
    let project_pk: i64 = connection
        .query_row(
            "SELECT project_pk FROM projects WHERE project_id = ?1",
            [project_identity.project_id.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let cached = {
        let mut statement = connection
            .prepare(
                "SELECT path, size_bytes, modified_at_ns, content_hash
                 FROM inventory_files WHERE project_pk = ?1",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map([project_pk], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CachedFile {
                        size_bytes: row.get(1)?,
                        modified_at_ns: row.get(2)?,
                        content_hash: row.get(3)?,
                    },
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut hashed_files = 0;
    let mut reused_files = 0;
    let mut changed_paths = Vec::new();
    let mut reused_paths = Vec::new();
    let mut source_batch_records = Vec::new();
    let mut source_batch_bytes = 0usize;
    let mut source_batch_omitted_files = 0usize;
    let mut ephemeral_source_texts = BTreeMap::new();
    // Reading and hashing candidate files is independent work. On a cold
    // checkout the old serial loop paid one Windows filesystem round-trip per
    // file before parser workers could start; perform those reads in parallel
    // and merge the deterministic source-batch/cache order below.
    let candidate_reads = candidates
        .into_par_iter()
        .map(|candidate| {
            let cached = cached.get(&candidate.path);
            if let Some(cached) = cached.filter(|cached| {
                cached.size_bytes == candidate.size_bytes
                    && cached.modified_at_ns == candidate.modified_at_ns
            }) {
                return Ok((candidate, cached.content_hash.clone(), None));
            }
            let source_path = root.join(&candidate.path);
            let bytes = fs::read(&source_path)
                .map_err(|error| format!("Unable to read {}: {error}", source_path.display()))?;
            Ok((candidate, content_hash(&bytes), Some(bytes)))
        })
        .collect::<Vec<Result<(CandidateFile, String, Option<Vec<u8>>), String>>>();
    let mut records = Vec::with_capacity(candidate_reads.len());
    for read in candidate_reads {
        let (candidate, hash, bytes) = read?;
        if let Some(bytes) = bytes {
            hashed_files += 1;
            changed_paths.push(candidate.path.clone());
            if include_source_batch {
                let utf8 = String::from_utf8_lossy(&bytes).into_owned();
                let byte_len = utf8.len();
                if source_batch_bytes.saturating_add(byte_len) <= MAX_SOURCE_BATCH_BYTES {
                    source_batch_bytes += byte_len;
                    source_batch_records.push(NativeSourceBatchRecord {
                        path: candidate.path.clone(),
                        utf8,
                        size_bytes: candidate.size_bytes,
                        modified_at_ns: candidate.modified_at_ns,
                    });
                } else {
                    source_batch_omitted_files += 1;
                }
            }
            if include_native_source_texts && is_native_source_path(&candidate.path) {
                ephemeral_source_texts.insert(
                    candidate.path.clone(),
                    String::from_utf8_lossy(&bytes).into_owned(),
                );
            }
        } else {
            reused_files += 1;
            reused_paths.push(candidate.path.clone());
        }
        records.push(InventoryRecord {
            candidate,
            content_hash: hash,
        });
    }
    let fingerprint = source_fingerprint(&records);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO scan_runs(project_pk, source_fingerprint, compatibility_digest, created_at_ms)
             VALUES (?1, ?2, NULL, ?3)",
            params![project_pk, fingerprint, created_at_ms],
        )
        .map_err(|error| error.to_string())?;
    let scan_pk = transaction.last_insert_rowid();
    let mut inventory_insert = transaction
        .prepare(
            "INSERT INTO inventory_files(project_pk, path, size_bytes, modified_at_ns, source_scope, content_hash, last_seen_scan_pk)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_pk, path) DO UPDATE SET
               size_bytes = excluded.size_bytes,
               modified_at_ns = excluded.modified_at_ns,
               source_scope = excluded.source_scope,
               content_hash = excluded.content_hash,
               last_seen_scan_pk = excluded.last_seen_scan_pk",
        )
        .map_err(|error| error.to_string())?;
    let mut node_insert = transaction
        .prepare(
            "INSERT INTO nodes(project_pk, node_id, semantic_key, content_hash, kind, path, symbol, signature)
             VALUES (?1, ?2, ?3, ?4, 'file', ?5, NULL, NULL)
             ON CONFLICT(project_pk, node_id) DO UPDATE SET
               content_hash = excluded.content_hash,
               path = excluded.path",
        )
        .map_err(|error| error.to_string())?;
    for record in &records {
        inventory_insert
            .execute(params![
                project_pk,
                record.candidate.path,
                record.candidate.size_bytes,
                record.candidate.modified_at_ns,
                record.candidate.source_scope.as_str(),
                record.content_hash,
                scan_pk
            ])
            .map_err(|error| error.to_string())?;
        let identity = NodeIdentity {
            kind: "file",
            path: &record.candidate.path,
            symbol: None,
            signature: None,
        };
        node_insert
            .execute(params![
                project_pk,
                stable_node_id(identity),
                semantic_key(identity),
                record.content_hash,
                record.candidate.path
            ])
            .map_err(|error| error.to_string())?;
    }
    drop(inventory_insert);
    drop(node_insert);
    let removed_paths = {
        let mut statement = transaction
            .prepare(
                "SELECT path FROM inventory_files WHERE project_pk = ?1 AND last_seen_scan_pk != ?2 ORDER BY path",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map(params![project_pk, scan_pk], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let removed_files = transaction
        .execute(
            "DELETE FROM inventory_files WHERE project_pk = ?1 AND last_seen_scan_pk != ?2",
            params![project_pk, scan_pk],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM js_file_records
             WHERE project_pk = ?1
               AND path NOT IN (SELECT path FROM inventory_files WHERE project_pk = ?1)",
            [project_pk],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM nodes
             WHERE project_pk = ?1 AND kind = 'file'
               AND path NOT IN (SELECT path FROM inventory_files WHERE project_pk = ?1)",
            [project_pk],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(NativeInventoryStatus {
        project_root: root,
        project_identity,
        scope_source: scope.source,
        source_scope_counts,
        source_fingerprint: fingerprint,
        candidate_files: records.len(),
        hashed_files,
        reused_files,
        removed_files,
        candidate_paths: include_paths.then(|| {
            records
                .iter()
                .map(|record| record.candidate.path.clone())
                .collect()
        }),
        changed_paths,
        reused_paths,
        removed_paths,
        source_batch_records: include_source_batch.then_some(source_batch_records),
        source_batch_omitted_files,
        ephemeral_source_texts,
    })
}

pub fn scan_native_inventory(input_root: &Path) -> Result<NativeInventoryStatus, String> {
    scan_native_inventory_with_options(input_root, false, false, false)
}

pub fn scan_native_inventory_with_paths(
    input_root: &Path,
) -> Result<NativeInventoryStatus, String> {
    scan_native_inventory_with_options(input_root, true, false, true)
}

// A --no-cache scan still needs the same deterministic discovery contract, but
// it must not open SQLite, update inventory rows, or create project metadata.
// All content hashes are intentionally computed in this process and discarded
// with the JSONL session.
pub fn scan_native_ephemeral_inventory_with_paths(
    input_root: &Path,
    session_project_id: Option<&str>,
) -> Result<NativeInventoryStatus, String> {
    let root = displayable_root(fs::canonicalize(input_root).map_err(|error| {
        format!(
            "Unable to resolve project root {}: {error}",
            input_root.display()
        )
    })?);
    if !root.is_dir() {
        return Err(format!(
            "Native inventory root is not a directory: {}",
            root.display()
        ));
    }
    let scope = read_native_scope(&root)?;
    let project_identity =
        resolve_ephemeral_project_identity(scope.project_id.as_deref(), session_project_id)?;
    let mut source_scope_counts = [
        SourceScope::Application,
        SourceScope::Test,
        SourceScope::Fixture,
        SourceScope::Generated,
        SourceScope::Excluded,
    ]
    .into_iter()
    .map(|source_scope| (source_scope.as_str().to_string(), 0))
    .collect::<BTreeMap<_, _>>();
    let mut candidates = Vec::new();
    collect_candidates(
        &root,
        &root,
        &scope,
        &mut source_scope_counts,
        &mut candidates,
    )?;
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    let mut records = Vec::with_capacity(candidates.len());
    let mut ephemeral_source_texts = BTreeMap::new();
    for candidate in candidates {
        let source_path = root.join(&candidate.path);
        let bytes = fs::read(&source_path)
            .map_err(|error| format!("Unable to read {}: {error}", source_path.display()))?;
        if is_native_source_path(&candidate.path) {
            // Match `read_source_text`: malformed source is still parseable
            // with U+FFFD replacement, while the inventory bytes remain the
            // authority for its original content hash.
            ephemeral_source_texts.insert(
                candidate.path.clone(),
                String::from_utf8_lossy(&bytes).into_owned(),
            );
        }
        records.push(InventoryRecord {
            candidate,
            content_hash: content_hash(&bytes),
        });
    }
    let source_fingerprint = source_fingerprint(&records);
    let candidate_paths = records
        .iter()
        .map(|record| record.candidate.path.clone())
        .collect::<Vec<_>>();
    let changed_paths = candidate_paths.clone();
    Ok(NativeInventoryStatus {
        project_root: root,
        project_identity,
        scope_source: scope.source,
        source_scope_counts,
        source_fingerprint,
        candidate_files: records.len(),
        hashed_files: records.len(),
        reused_files: 0,
        removed_files: 0,
        candidate_paths: Some(candidate_paths),
        changed_paths,
        reused_paths: Vec::new(),
        removed_paths: Vec::new(),
        source_batch_records: None,
        source_batch_omitted_files: 0,
        ephemeral_source_texts,
    })
}

fn is_native_source_path(path: &str) -> bool {
    matches!(
        path.rsplit('.').next().map(|extension| extension.to_ascii_lowercase()),
        Some(extension) if matches!(
            extension.as_str(),
            "js" | "cjs" | "mjs" | "jsx" | "ts" | "tsx" | "py" | "php" | "rs" | "java" | "svelte" | "cs"
        )
    )
}

/// Produce a source-free, deterministic plan for a bounded/package scan.
/// The plan is native-owned and validates its selected subtree before any
/// parser or graph lifecycle runs. Exceeding a bound is an error, never a
/// truncated plan that could later be promoted as a complete graph.
pub fn discover_native_bounded_project(
    input_root: &Path,
    package_path: Option<&str>,
    max_files: Option<usize>,
    max_bytes: Option<i64>,
    budget_ms: Option<u64>,
) -> Result<NativeBoundedDiscovery, String> {
    let started = Instant::now();
    let root = displayable_root(fs::canonicalize(input_root).map_err(|error| {
        format!(
            "Unable to resolve project root {}: {error}",
            input_root.display()
        )
    })?);
    let selected = match package_path.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            let relative = Path::new(value);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return Err(format!("native-bounded-invalid-package-path:{value}"));
            }
            let candidate =
                displayable_root(fs::canonicalize(root.join(relative)).map_err(|error| {
                    format!("native-bounded-invalid-package-path:{value}:{error}")
                })?);
            if !candidate.is_dir() || !candidate.starts_with(&root) {
                return Err(format!("native-bounded-invalid-package-path:{value}"));
            }
            candidate
        }
        None => root.clone(),
    };
    let scope = read_native_scope(&root)?;
    let mut counts = BTreeMap::new();
    let mut candidates = Vec::new();
    let mut limits = CandidateCollectionLimits {
        max_files,
        max_bytes,
        started,
        budget_ms,
        total_bytes: 0,
    };
    collect_candidates_with_limits(
        &root,
        &selected,
        &scope,
        &mut counts,
        &mut candidates,
        Some(&mut limits),
    )?;
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    let total_bytes = limits.total_bytes;
    let candidates = candidates
        .into_iter()
        .map(|candidate| NativeBoundedCandidate {
            path: candidate.path,
            size_bytes: candidate.size_bytes,
            modified_at_ns: candidate.modified_at_ns,
            source_scope: candidate.source_scope.as_str().to_string(),
        })
        .collect::<Vec<_>>();
    let mut hasher = Hasher::new();
    for candidate in &candidates {
        hasher.update(candidate.path.as_bytes());
        hasher.update(&[0]);
        hasher.update(candidate.size_bytes.to_string().as_bytes());
        hasher.update(&[0]);
        hasher.update(candidate.modified_at_ns.to_string().as_bytes());
        hasher.update(&[0]);
        hasher.update(candidate.source_scope.as_bytes());
        hasher.update(b"\n");
    }
    let package_path = selected
        .strip_prefix(&root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().replace('\\', "/"));
    Ok(NativeBoundedDiscovery {
        project_root: root,
        package_path,
        scope_source: scope.source,
        candidates,
        total_bytes,
        plan_fingerprint: format!("blake3:{}", hasher.finalize().to_hex()),
    })
}

pub fn scan_native_incremental_manifest(
    input_root: &Path,
) -> Result<NativeIncrementalManifest, String> {
    Ok(NativeIncrementalManifest {
        inventory: scan_native_inventory_with_options(input_root, true, false, false)?,
    })
}

pub fn scan_native_incremental_manifest_with_source_batch(
    input_root: &Path,
) -> Result<NativeIncrementalManifest, String> {
    Ok(NativeIncrementalManifest {
        inventory: scan_native_inventory_with_options(input_root, true, true, false)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        discover_native_bounded_project, scan_native_ephemeral_inventory_with_paths,
        scan_native_inventory, scan_native_inventory_with_paths,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

    fn temporary_root() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "flopeek-native-inventory-{}-{unique}-{}",
            std::process::id(),
            NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed),
        ))
    }

    #[test]
    fn bounded_discovery_scopes_a_package_and_rejects_non_complete_plans() {
        let root = temporary_root();
        fs::create_dir_all(root.join("apps/api/src")).unwrap();
        fs::create_dir_all(root.join("apps/web/src")).unwrap();
        fs::write(
            root.join("apps/api/src/main.ts"),
            "export const api = true;\n",
        )
        .unwrap();
        fs::write(
            root.join("apps/web/src/main.ts"),
            "export const web = true;\n",
        )
        .unwrap();

        let plan = discover_native_bounded_project(
            &root,
            Some("apps/api"),
            Some(1),
            Some(1_000),
            Some(10_000),
        )
        .unwrap();
        assert_eq!(plan.package_path.as_deref(), Some("apps/api"));
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].path, "apps/api/src/main.ts");
        assert!(plan.plan_fingerprint.starts_with("blake3:"));
        assert!(
            discover_native_bounded_project(&root, Some("apps/api"), Some(0), None, None)
                .unwrap_err()
                .starts_with("native-bounded-max-files-exceeded")
        );
        let byte_limit_error =
            discover_native_bounded_project(&root, Some("apps/api"), None, Some(1), None)
                .unwrap_err();
        assert!(
            byte_limit_error.starts_with("native-bounded-max-bytes-exceeded"),
            "unexpected byte-limit error: {byte_limit_error}"
        );
        assert!(
            discover_native_bounded_project(&root, Some("../outside"), None, None, None)
                .unwrap_err()
                .starts_with("native-bounded-invalid-package-path")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ephemeral_inventory_retains_all_native_source_text_with_node_utf8_replacement() {
        let root = temporary_root();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.ts"), "export const app = true;\n").unwrap();
        fs::write(
            root.join("src/service.py"),
            "def service():\n    return True\n",
        )
        .unwrap();
        fs::write(
            root.join("src/legacy.php"),
            b"<?php \x80 function legacy() {}\n",
        )
        .unwrap();
        fs::write(root.join("README.md"), "not a native source adapter\n").unwrap();

        let inventory =
            scan_native_ephemeral_inventory_with_paths(&root, Some("session:source-texts"))
                .unwrap();

        assert_eq!(
            inventory
                .ephemeral_source_texts
                .get("src/app.ts")
                .map(String::as_str),
            Some("export const app = true;\n")
        );
        assert_eq!(
            inventory
                .ephemeral_source_texts
                .get("src/service.py")
                .map(String::as_str),
            Some("def service():\n    return True\n")
        );
        assert_eq!(
            inventory
                .ephemeral_source_texts
                .get("src/legacy.php")
                .map(String::as_str),
            Some("<?php \u{fffd} function legacy() {}\n")
        );
        assert!(!inventory.ephemeral_source_texts.contains_key("README.md"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_reuses_unchanged_hashes_and_removes_deleted_files() {
        let root = temporary_root();
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("node_modules/ignored")).unwrap();
        fs::create_dir_all(root.join(".flopeek")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(
            root.join("src/nested/feature.ts"),
            "export const feature = true;\n",
        )
        .unwrap();
        fs::write(
            root.join("node_modules/ignored/index.js"),
            "module.exports = 1;\n",
        )
        .unwrap();
        fs::write(root.join(".flopeek/cache.js"), "module.exports = 1;\n").unwrap();
        fs::write(root.join("README.md"), "not a registered source file\n").unwrap();

        let first = scan_native_inventory(&root).unwrap();
        assert_eq!(first.candidate_files, 2);
        assert_eq!(first.hashed_files, 2);
        assert_eq!(first.reused_files, 0);
        let second = scan_native_inventory(&root).unwrap();
        assert_eq!(second.source_fingerprint, first.source_fingerprint);
        assert_eq!(second.hashed_files, 0);
        assert_eq!(second.reused_files, 2);

        fs::write(
            root.join("src/main.rs"),
            "fn main() { println!(\"changed\"); }\n",
        )
        .unwrap();
        let changed = scan_native_inventory(&root).unwrap();
        assert_eq!(changed.hashed_files, 1);
        assert_eq!(changed.reused_files, 1);
        assert_ne!(changed.source_fingerprint, first.source_fingerprint);

        fs::remove_file(root.join("src/nested/feature.ts")).unwrap();
        let removed = scan_native_inventory(&root).unwrap();
        assert_eq!(removed.candidate_files, 1);
        assert_eq!(removed.removed_files, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_uses_configured_identity_and_scope_contract() {
        let root = temporary_root();
        fs::create_dir_all(root.join(".flopeek")).unwrap();
        fs::write(
            root.join(".flopeek/config.json"),
            r#"{
              "schemaVersion": 1,
              "projectId": "project:native-scope-test",
              "sourceRoots": ["app"],
              "testRoots": ["verification"],
              "fixtureRoots": ["samples"],
              "exclude": ["legacy/**"]
            }"#,
        )
        .unwrap();
        for (path, contents) in [
            ("app/live.ts", "export const live = true;\n"),
            (
                "app/generated/api.generated.ts",
                "export const api = true;\n",
            ),
            ("verification/live.test.ts", "test('live', () => {});\n"),
            ("samples/example.ts", "export const sample = true;\n"),
            ("legacy/old.ts", "export const old = true;\n"),
            ("outside/ignored.ts", "export const ignored = true;\n"),
        ] {
            let target = root.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, contents).unwrap();
        }

        let status = scan_native_inventory_with_paths(&root).unwrap();
        assert_eq!(
            status.project_identity.project_id,
            "project:native-scope-test"
        );
        assert_eq!(status.project_identity.source, "configured");
        assert_eq!(status.scope_source, "config");
        assert_eq!(status.source_scope_counts.get("application"), Some(&1));
        assert_eq!(status.source_scope_counts.get("generated"), Some(&1));
        assert_eq!(status.source_scope_counts.get("test"), Some(&1));
        assert_eq!(status.source_scope_counts.get("fixture"), Some(&1));
        assert_eq!(status.source_scope_counts.get("excluded"), Some(&2));
        assert_eq!(
            status.candidate_paths.unwrap(),
            vec![
                "app/generated/api.generated.ts",
                "app/live.ts",
                "samples/example.ts",
                "verification/live.test.ts",
            ]
        );
        assert!(!root.join(".flopeek/project.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inventory_creates_a_portable_generated_identity_once() {
        let root = temporary_root();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();

        let first = scan_native_inventory(&root).unwrap();
        let second = scan_native_inventory(&root).unwrap();
        assert_eq!(first.project_identity.source, "generated");
        assert_eq!(first.project_identity.status, "created");
        assert_eq!(second.project_identity.status, "persistent");
        assert_eq!(
            first.project_identity.project_id,
            second.project_identity.project_id
        );
        assert!(root.join(".flopeek/project.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
