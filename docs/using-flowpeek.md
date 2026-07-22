# Use Flowpeek

Flowpeek helps you answer four questions before changing an unfamiliar repository:

1. Where does this request or feature start?
2. Which static path connects it to code and integrations?
3. Which tests and neighboring components are directly related?
4. Is the context I copied earlier still current?

## Start locally

Flowpeek is currently used from its source checkout:

```powershell
git clone https://github.com/badsleepyday/flowpeek.git
cd flowpeek
npm install
npm exec -- flowpeek serve D:\work\my-project
```

The Viewer opens on loopback. If the preferred port is occupied, Flowpeek advances to an available port without stopping the existing service. Use `--strict-port` when a fixed port is required.

```powershell
npm exec -- flowpeek serve D:\work\my-project --port 4780
npm exec -- flowpeek serve D:\work\my-project --port 4780 --strict-port
```

## Read the Viewer

### 1. Start with Feature overview

The overview groups application nodes into a small map. A summary node represents source nodes; it is not automatically a runtime service or execution step.

### 2. Select a static entry flow

Open a detected HTTP/request endpoint, a supported literal package script, a narrow Django management-command declaration, or a supported literal node-cron schedule registration to see its Flow Lens:

- bounded static steps;
- direct transition evidence;
- supported persistence, queue, and external boundaries;
- related tests;
- parser coverage and truncation;
- a versioned Flow Context Ref.

A package-script entry is intentionally narrow: the manifest must declare one
supported runner followed by one repository-local scanned source-file target,
for example `node src/main.ts`. Flowpeek records the declaration and its exact
target edge; it does not run the script, validate the runner, or infer its
purpose. Shell composition, flags, quoted values, package-manager indirection,
and unsupported framework command forms remain visible only as unsupported entry inventory.

A Django management-command entry is intentionally narrow: Flowpeek requires a
non-private `management/commands/<name>.py` module, one top-level `Command`
class directly extending an imported `django.core.management.base.BaseCommand`
binding, and one direct `handle` method. It records the declaration and exact
edge to that class; it does not load Django settings, prove app registration,
invoke the command, or infer its purpose. Indirect base classes, dynamic
registration, and alternate command forms remain unsupported entry inventory.

A node-cron schedule entry is intentionally narrower still: Flowpeek requires a
module-scope default `cron` import from `node-cron`, a literal five- or six-field cron
expression, and one unshadowed local top-level function identifier, for example
`cron.schedule("0 * * * *", refreshSnapshot)`. It records the static
registration and exact task edge; it does not initialize a scheduler, wait for
a schedule, run the task, validate timing, or infer purpose. Non-module registrations,
inline callbacks, imported tasks, dynamic expressions, and other scheduler APIs remain unsupported
entry inventory.

### 3. Drill into a node

Select a step to inspect its source path, parser evidence, incoming and outgoing relationships, tests, and human-authored description.

### 4. Copy context, not a screenshot

Use **Copy reference**, **Copy JSON**, or **Copy Markdown**. A reference such as:

```text
fp://local/<project-id>/flow/<flow-id>@<graph-version>
```

can resolve as `current`, `stale`, `historical`, or `unresolved`. Flowpeek never silently redirects an old reference.

## Keep the Viewer open while coding

The watcher reparses changed source files, advances the graph version when evidence changes, and publishes affected contexts to the Viewer, HTTP API, and MCP cache.

```text
edit source
  → incremental refresh
  → graph version advances
  → changed flow is highlighted
  → before/current static comparison is available
  → older Context Ref resolves as stale
```

A static comparison explains graph evidence. It does not prove runtime order or successful behavior.

## Inspect the local Work ledger

Flowpeek currently stores evidence-linked delivery metadata separately from the
technical graph. The Viewer **Work** inspector is read-only and shows planned
records, Context Ref freshness, available workflow methods, and recent append-
only actual events.

Use the CLI for compact read-only inventory:

```powershell
npm exec -- flowpeek work list D:\work\my-project
npm exec -- flowpeek work timeline D:\work\my-project --record task-id
npm exec -- flowpeek work workflows D:\work\my-project
npm exec -- flowpeek work dependencies D:\work\my-project --record task-id
```

Trusted local HTTP clients and MCP metadata tools can create Work records,
record events, assign a workflow, and request evidence-gated transitions. These
operations update `.flowpeek/delivery` only. A record, event, or workflow state
does not prove that source changed, a test passed, approval authority exists, a
release occurred, or runtime behavior succeeded.

When a record declares dependencies, `work dependencies` reports whether each
one is locally `ready`, `blocking`, `unresolved`, or `unknown`. Flowpeek blocks
only built-in workflow entry into implementation when a declared dependency is
not ready. The result is a delivery-metadata guard: it does not prove that the
dependency's source implementation, tests, approval, release, runtime behavior,
or external-system state is complete.

Continuation checkpoints, planned technical overlays, explicit ghost nodes,
manual plan-to-actual reconciliation, baseline/plan/current comparison,
read-only divergence, and bounded agent continuation context are current local
metadata capabilities. Viewer workflow and checkpoint creation controls remain
out of scope; the Viewer does not turn planned work into source facts.

When a handoff needs bounded local Git context, resolve the exact Context Ref
first, then inspect only commits reachable from the current attached branch:

```powershell
npm exec -- flowpeek git-evidence D:\work\my-project --context-ref "fp://local/..." --limit 12 --format json
```

This is path-touch evidence for the current Context Card paths. It does not
prove original rationale, runtime behavior, test success, review, or release
state; detached `HEAD`, unavailable history, and unresolved Context Refs remain
explicitly unavailable.

To compare the exact static Context Ref across two pinned commits, use:

```powershell
npm exec -- flowpeek git-continuity D:\work\my-project --context-ref "fp://local/..." --from HEAD~1 --to HEAD --format json
```

The result distinguishes an exact static node/flow identity from nodes found at
the same path. A same-path candidate is not a rename, successor, implementation
match, semantic-equivalence claim, or runtime proof.

## Give the graph to a coding agent

Install the project-local Flowpeek skill and MCP entry:

```powershell
npm exec -- flowpeek install D:\work\my-project --platform codex
npm exec -- flowpeek doctor D:\work\my-project --platform codex
```

Supported installer targets are `codex`, `claude`, `cursor`, and `gemini`. Existing unrelated configuration is preserved; unmanaged conflicts are refused.

Recommended agent sequence:

```text
Orient      get_agent_bootstrap
Freshness   get_scan_status
Locate      find_nodes / get_entry_flows
Understand  get_flow_projection / get_context_card
History     get_active_branch_git_evidence / get_git_context_continuity (only when a handoff needs bounded Git evidence)
Plan        get_change_impact / get_related_tests
Refresh     refresh_graph
Confirm     get_scan_status
Review      get_changed_contexts / resolve_context_ref
```

The agent still reads and edits source through its own workspace tools. Flowpeek MCP does not expose source bodies or arbitrary command execution.

Treat `complete` + `current` as current-source scan evidence. When status is
`stale-unverified`, Flowpeek is deliberately serving the last complete graph
instead of a partial result. A bounded scan can be stopped with `cancel_scan`;
unbounded scans cannot be interrupted.

## Control repository scope

Create `.flowpeek/config.json` when a monorepo needs explicit roots or exclusions. Flowpeek validates the file before updating cache evidence.

```json
{
  "schemaVersion": 1,
  "sourceRoots": ["apps/api", "packages/domain"],
  "exclude": ["**/generated/**", "**/fixtures/**"]
}
```

Scope controls what is treated as application evidence. It does not make unsupported syntax analyzable.

### Inspect size before a full scan

Use discovery first when the repository is large or unfamiliar:

```powershell
npm exec -- flowpeek discover D:\work\my-project --max-files 5000 --max-bytes 250000000 --budget-ms 10000
```

Discovery reads static inventory and configuration only. It does not parse
source or create a graph. A bounded result exits with code `2` and explains
which declared limit was exceeded.

Run a complete-result-only bounded scan with the same controls:

```powershell
npm exec -- flowpeek scan D:\work\my-project --max-files 5000 --max-bytes 250000000 --budget-ms 60000
```

Flowpeek writes the canonical graph cache only after the discovered source plan
was analyzed completely and its inventory fingerprint still matches. A bounded,
cancelled, invalidated, or failed result is diagnostic output, not a partial
technical graph. The same complete-result-only contract applies to the CLI,
local Viewer/HTTP/SSE, and MCP. During bounded analysis, the Viewer exposes
**Cancel** and MCP exposes `cancel_scan`; cancellation retains the last complete
graph as `stale-unverified` rather than promoting a partial result.

### Focus one package in a monorepo

When the repository is large, select a concrete package directory rather than
asking the first graph to cover every package:

```powershell
npm exec -- flowpeek discover D:\work\my-project --package apps\api --format json
npm exec -- flowpeek scan D:\work\my-project --package apps\api
npm exec -- flowpeek serve D:\work\my-project --package apps\api
npm exec -- flowpeek mcp D:\work\my-project --package apps\api
```

`--package` accepts only a repository-relative directory with its own regular
`package.json`; symbolic-link paths and parent-directory traversal are refused.
The Viewer, `get_scan_status`, `get_agent_bootstrap`, and `get_agent_context`
identify the selected path. Treat that graph as a **static package subtree**:
it does not establish workspace membership, package ownership, build activation,
or runtime topology outside the selected source set.

Package selection still intersects the repository-owned `.flowpeek/config.json`
source, test, fixture, and exclusion rules. It does not override a configured
source boundary just because the selected directory contains `package.json`.

Package scans use an ephemeral session identity and never replace the
repository-wide `.flowpeek` cache. This prevents a focused map from becoming a
misleading whole-repository baseline. Package-scoped Viewer and MCP sessions
are per-project only; `serve --global --package ...` is intentionally refused.

## Use one Viewer for multiple projects

```powershell
npm exec -- flowpeek serve D:\work\orders -g --workspace commerce
npm exec -- flowpeek serve D:\work\payments -g --workspace commerce
```

The hub keeps each project ID, graph, cache, watcher, and Context Ref isolated. Matching names do not create cross-project edges. A person may add an explicit version-bound contract reference between current flows.

## Choose the right tool

| Situation | Start with |
| --- | --- |
| Exact identifier already known | Editor search or `rg` |
| Need a request-to-dependency path | Flow Lens |
| Need immediate neighborhood | Direct dependencies |
| Need test candidates and potential impact | Related tests + impact |
| Need to hand context to another person or agent | Context Ref / Context Packet |
| Need proof that code executed | Runtime/test evidence outside the static graph |

## Common checks

```powershell
npm exec -- flowpeek discover D:\work\my-project --max-files 5000 --budget-ms 10000
npm exec -- flowpeek scan D:\work\my-project --format json
npm exec -- flowpeek scan D:\work\my-project --format json --no-cache
npm exec -- flowpeek proof D:\work\my-project --iterations 3
npm exec -- flowpeek benchmark D:\work\my-project --iterations 5 --format json
npm exec -- flowpeek doctor D:\work\my-project --platform all --format json
```

Use `--no-cache` for an inspection that must not create Flowpeek cache or project-identity metadata in the target repository. It still reads supported source and any existing Flowpeek configuration; it does not execute the target application.

Benchmark timing is host-specific. Run it when you need local evidence, not on every scan.

## If a flow looks incomplete

1. Open **Parser coverage**.
2. Check whether participating files are `parsed`, `partial`, or `inventory-only`.
3. Inspect the raw source paths returned by the Context Card.
4. Check [SUPPORT.md](../SUPPORT.md) for dispatch, framework, and resolver limits.
5. Treat missing static evidence as unknown—not proof that behavior is absent.

## Remove an integration

```powershell
npm exec -- flowpeek uninstall D:\work\my-project --platform codex
```

Flowpeek removes only its managed entry and generated skill. It preserves unrelated project configuration.
