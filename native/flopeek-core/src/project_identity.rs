use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub const PROJECT_IDENTITY_RELATIVE_PATH: &str = ".flopeek/project.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectIdentity {
    pub project_id: String,
    pub canonical_project_id: Option<String>,
    pub source: String,
    pub status: String,
    pub origin_remote: Option<String>,
    pub limitation: String,
}

fn git_directory(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let marker = current.join(".git");
        if marker.is_dir() {
            return Some(marker);
        }
        if marker.is_file() {
            let declaration = fs::read_to_string(marker).ok()?;
            let declared = declaration.trim().strip_prefix("gitdir:")?.trim();
            return Some(current.join(declared));
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

fn read_origin_remote(root: &Path) -> Option<String> {
    let mut directory = git_directory(root)?;
    let common = directory.join("commondir");
    if common.exists() {
        let declared = fs::read_to_string(common).ok()?;
        directory = directory.join(declared.trim());
    }
    let config = fs::read_to_string(directory.join("config")).ok()?;
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_origin = line.eq_ignore_ascii_case("[remote \"origin\"]");
            continue;
        }
        if !in_origin {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            return Some(value.trim().trim_matches('"').to_string())
                .filter(|value| !value.is_empty());
        }
    }
    None
}

fn atomic_write_json(path: &Path, payload: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Project identity has no metadata parent directory.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create Flopeek metadata directory: {error}"))?;
    let temporary = parent.join(format!(".project.json.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Unable to write project identity: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Unable to persist project identity: {error}"))
}

pub fn resolve_project_identity(
    root: &Path,
    configured_id: Option<&str>,
) -> Result<ProjectIdentity, String> {
    let origin_remote = read_origin_remote(root);
    if let Some(project_id) = configured_id {
        return Ok(ProjectIdentity {
            project_id: project_id.to_string(),
            canonical_project_id: None,
            source: "configured".to_string(),
            status: "configured".to_string(),
            origin_remote,
            limitation: "An explicit projectId takes precedence. Copy and fork relationships are not inferred from source code or Git history.".to_string(),
        });
    }
    let path = root.join(PROJECT_IDENTITY_RELATIVE_PATH);
    if !path.exists() {
        let project_id = format!("project:{}", Uuid::new_v4());
        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| error.to_string())?;
        atomic_write_json(
            &path,
            &json!({
                "schemaVersion": 1,
                "projectId": project_id,
                "source": "generated",
                "createdAt": created_at,
                "originRemote": origin_remote,
            }),
        )?;
        return Ok(ProjectIdentity {
            project_id,
            canonical_project_id: None,
            source: "generated".to_string(),
            status: "created".to_string(),
            origin_remote,
            limitation: "The generated ID persists with .flopeek/project.json. A copied directory can retain the same ID and is not automatically distinguished without an explicit projectId.".to_string(),
        });
    }
    let record: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read project identity: {error}"))?,
    )
    .map_err(|error| {
        format!(
            "Invalid Flopeek project identity metadata: project.json is not valid JSON ({error})."
        )
    })?;
    let Some(object) = record.as_object() else {
        return Err(
            "Invalid Flopeek project identity metadata: project.json must contain an object."
                .to_string(),
        );
    };
    if object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        != Some(1)
        || object.get("source").and_then(serde_json::Value::as_str) != Some("generated")
    {
        return Err(
            "Invalid Flopeek project identity metadata: unsupported schema or source.".to_string(),
        );
    }
    let project_id = object
        .get("projectId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(
            "Invalid Flopeek project identity metadata: projectId must be a non-empty string.",
        )?;
    let recorded_remote =
        match object.get("originRemote") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(value)) => Some(value.clone()),
            Some(_) => return Err(
                "Invalid Flopeek project identity metadata: originRemote must be a string or null."
                    .to_string(),
            ),
        };
    let remote_mismatch =
        recorded_remote.is_some() && origin_remote.is_some() && recorded_remote != origin_remote;
    Ok(ProjectIdentity {
        project_id: project_id.to_string(),
        canonical_project_id: None,
        source: "generated".to_string(),
        status: if remote_mismatch {
            "remote-mismatch"
        } else {
            "persistent"
        }
        .to_string(),
        origin_remote,
        limitation: if remote_mismatch {
            "The persisted ID was created with a different origin remote. Treat this repository as a copy-or-fork candidate until a person confirms or configures projectId.".to_string()
        } else {
            "A copied directory can retain the same generated ID and is not automatically distinguished without an explicit projectId.".to_string()
        },
    })
}

// Ephemeral scans must never create `.flopeek/project.json`.  The caller owns
// the session identifier, which keeps one JSONL process on one stable graph
// lineage without making that identity durable in the source repository.
pub fn resolve_ephemeral_project_identity(
    configured_id: Option<&str>,
    session_project_id: Option<&str>,
) -> Result<ProjectIdentity, String> {
    let project_id = session_project_id
        .filter(|value| !value.trim().is_empty())
        .ok_or("Ephemeral native scanning requires a session project identity.")?;
    Ok(ProjectIdentity {
        project_id: project_id.to_string(),
        canonical_project_id: configured_id.map(str::to_string),
        source: "session".to_string(),
        status: "session-only".to_string(),
        origin_remote: None,
        limitation: "This identity exists only for the current native JSONL session and is never written to the source repository. canonicalProjectId, when present, records the configured durable identity without making this session Context Ref durable.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{resolve_ephemeral_project_identity, resolve_project_identity};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_root() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "flopeek-native-project-identity-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn generated_identity_persists_and_reports_changed_origin() {
        let root = temporary_root();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://example.test/original.git\n",
        )
        .unwrap();

        let created = resolve_project_identity(&root, None).unwrap();
        let persistent = resolve_project_identity(&root, None).unwrap();
        assert_eq!(created.status, "created");
        assert_eq!(persistent.status, "persistent");
        assert_eq!(created.project_id, persistent.project_id);
        assert_eq!(
            persistent.origin_remote.as_deref(),
            Some("https://example.test/original.git")
        );

        fs::write(
            root.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://example.test/fork.git\n",
        )
        .unwrap();
        let fork_candidate = resolve_project_identity(&root, None).unwrap();
        assert_eq!(fork_candidate.status, "remote-mismatch");
        assert_eq!(fork_candidate.project_id, created.project_id);

        let configured =
            resolve_project_identity(&root, Some("project:explicit-identity")).unwrap();
        assert_eq!(configured.source, "configured");
        assert_eq!(configured.status, "configured");
        assert_eq!(configured.project_id, "project:explicit-identity");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ephemeral_identity_is_always_session_scoped_even_with_configured_identity() {
        let identity = resolve_ephemeral_project_identity(
            Some("project:configured"),
            Some("session:ephemeral"),
        )
        .unwrap();
        assert_eq!(identity.project_id, "session:ephemeral");
        assert_eq!(
            identity.canonical_project_id.as_deref(),
            Some("project:configured")
        );
        assert_eq!(identity.source, "session");
        assert_eq!(identity.status, "session-only");
    }
}
