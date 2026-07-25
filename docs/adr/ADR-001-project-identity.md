# ADR-001: Local project identity and copy/fork behavior

Status: Accepted

Date: 2026-07-14

## Context

Flowpeek must allow its local viewer, CLI, cache, and MCP server to describe the same repository context across process restarts and directory moves. A filesystem path alone is not stable. A Git remote is useful evidence but does not prove that a clone, fork, or copied directory is the same project for Flowpeek's future Context Cards and delivery records.

This decision intentionally precedes monotonic graph versions. A project identity answers **which local project context** a graph belongs to; it does not identify a material graph state.

## Decision

Flowpeek resolves identity in this order:

1. An explicit `.flowpeek/config.json` `projectId` wins. It must be a stable safe identifier and is reported with `source: "configured"`.
2. Otherwise Flowpeek creates a UUID-based `project:<uuid>` identity in `.flowpeek/project.json` on the first scan and reuses it on later scans. It is reported with `source: "generated"`.
3. A deliberately read-only scan, such as `benchmark`, generates an in-memory ephemeral UUID rather than creating `.flowpeek/project.json`. It cannot be used as durable context.
4. The currently configured Git `origin` remote is recorded as contextual evidence for a generated identity. It is not itself the identity.

`project.json` is local Flowpeek metadata, never source analysis input. It has its own schema version and is written with the same safe temporary-file persistence used for graph cache state.

## Behavior matrix

| Situation | Result | Required disclosure |
| --- | --- | --- |
| Normal repository restart | Reuse `project.json` ID. | `status: persistent`. |
| Directory move | Reuse moved `project.json` ID. | The ID remains the same. |
| Non-Git repository | Generate/reuse local ID. | `originRemote: null`; no Git identity is claimed. |
| Read-only benchmark scan | Generate an in-memory ID only. | `status: ephemeral`; it is not durable context. |
| Copy of a directory | Copy retains the generated ID. | Flowpeek states that copy/fork relationship is not automatically resolved. |
| Different current Git origin than recorded origin | Reuse ID but flag candidate. | `status: remote-mismatch`; person must confirm or configure an explicit ID. |
| Intentional fork or new product | Set a new explicit `projectId` in config. | The configured ID supersedes the generated local ID for all responses. |

Flowpeek does not scan all Git history, compare source similarity, or infer organizational ownership to solve copy/fork identity. Those mechanisms would create unsupported certainty.

## Consequences

- CLI JSON, local API/viewer agent context, and MCP contexts include `project.projectId` and identity metadata.
- Graph-cache validation uses the resolved local root to prevent a cache from a different current project directory being reused.
- A `projectId` is not a `graphVersion`. It must not be used for stale-context checks until ADR-002 introduces a monotonic graph-state version.
- Users who require stable cross-copy identity must explicitly configure `projectId` and manage that policy outside Flowpeek.

## Alternatives considered

### Path-derived identity

Rejected because a directory move would create unrelated context.

### Git remote as the sole identity

Rejected because non-Git repositories exist, remotes can change, and a fork can intentionally share or differ from source history.

### Automatic copy/fork detection

Rejected for the current reliability foundation. It would require heuristics or external data and could silently link unrelated work.
