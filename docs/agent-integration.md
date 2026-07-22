# Agent host integration

Flowpeek integrates with local coding-agent hosts by installing two project-local artifacts:

1. an MCP stdio entry that starts `flowpeek mcp .` in the repository context;
2. a tool-usage skill that tells the provider how to use Flowpeek evidence safely.

The provider does not generate Flowpeek's parser graph. Flowpeek's deterministic scanner remains the authority for extracted static facts. A provider can query those facts, inspect source with its own authorized workspace tools, propose or apply a source change, refresh Flowpeek, and verify the resulting static delta. Provider proposals remain separate from parser facts and human verification.

## Commands

```powershell
flowpeek install D:\path\to\repository
flowpeek install D:\path\to\repository --platform codex --dry-run --format json
flowpeek doctor D:\path\to\repository --platform codex
flowpeek uninstall D:\path\to\repository
```

With no `--platform`, install detects supported executables on PATH. Explicit values are `codex`, `claude`, `cursor`, `gemini`, and `all`. Explicit selection is allowed before the host executable is installed; doctor reports that executable as a warning. `--strict` makes doctor warnings fail readiness.

## Ownership and safety

- All integration targets are inside the selected repository.
- Install preflights every selected target before writing any target.
- A missing target is created; an exact managed target is unchanged; a different target is a conflict.
- JSON host configuration is parsed and rewritten while preserving unrelated keys and MCP servers.
- Codex configuration uses a delimited Flowpeek managed block. An unmanaged or edited Flowpeek block is never replaced.
- The canonical skill is copied from `integrations/skills/flowpeek` and compared by deterministic directory hash.
- `.flowpeek/agent-integrations.json` records installed platforms and owned paths.
- Uninstall removes only exact managed MCP values and exact canonical skill content. User-modified content is reported as a conflict and retained.
- Detection and doctor inspect PATH and local files only. They never start a provider or execute a target repository.

## Platform matrix

| Host | Skill | MCP configuration |
| --- | --- | --- |
| Codex | `.agents/skills/flowpeek` | `.codex/config.toml` |
| Claude Code | `.claude/skills/flowpeek` | `.mcp.json` |
| Cursor | `.cursor/skills/flowpeek` | `.cursor/mcp.json` |
| Gemini CLI | `.gemini/skills/flowpeek` | `.gemini/settings.json` |

ChatGPT web is not a local stdio host and is intentionally excluded. A future remote integration must define its own authentication, deployment, privacy, and resource-isolation contract; it must not reuse the local installer label as if support already existed.

## Agent bootstrap contract

`flowpeek-agent-bootstrap/v1` is available from:

- `flowpeek bootstrap <repository> --format json`;
- `GET /api/agent-bootstrap` on the loopback server;
- MCP `get_agent_bootstrap`.

It reports project and graph identity, static inventory, cache state, application-flow availability, parser coverage, a recommended tool sequence, evidence policy, and explicit limitations. It contains no source body or machine-specific repository root.

The expected provider workflow is:

```text
get_agent_bootstrap
  -> get_scan_status
  -> get_handoff_context or focused discovery
  -> raw node / Flow Lens evidence
  -> source fallback where coverage is incomplete
  -> edit with host workspace tools
  -> refresh_graph
  -> get_scan_status
  -> changed contexts / before-current comparison / impact
  -> repository-owned tests and checks
  -> evidence-backed report
```

Static graph evidence does not prove runtime order, dynamic dispatch, successful side effects, business intent, or complete test coverage. Missing evidence is a reason to inspect source or gather another evidence class, not proof that behavior is absent.

`get_scan_status` must report `complete` and `current` before a refreshed graph is
treated as current-source evidence. A `stale-unverified` result is only the last
complete baseline. `cancel_scan` can stop active bounded analysis without
promoting an incomplete graph; unbounded scanning is not interruptible.

## Troubleshooting

- **No host detected:** pass `--platform <id>` explicitly or install a supported host and ensure its executable is on PATH.
- **Malformed JSON:** repair the host configuration manually; Flowpeek will not replace it.
- **Existing Flowpeek entry:** remove or reconcile the unmanaged entry manually. Flowpeek does not claim ownership of it.
- **Modified installed skill:** keep the customization and resolve it manually, or restore the canonical content before uninstalling.
- **MCP command not found:** install or link Flowpeek so `flowpeek` is on PATH, then rerun doctor.
- **Graph evidence appears incomplete:** read bootstrap coverage, inspect source directly, and retain the limitation in the result.
