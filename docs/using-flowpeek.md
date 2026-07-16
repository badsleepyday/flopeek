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

### 2. Select an HTTP flow

Open a detected HTTP/request endpoint to see its Flow Lens:

- bounded static steps;
- direct transition evidence;
- supported persistence, queue, and external boundaries;
- related tests;
- parser coverage and truncation;
- a versioned Flow Context Ref.

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
Locate      find_nodes / get_request_flows
Understand  get_flow_projection / get_context_card
Plan        get_change_impact / get_related_tests
Refresh     refresh_graph
Review      get_changed_contexts / resolve_context_ref
```

The agent still reads and edits source through its own workspace tools. Flowpeek MCP does not expose source bodies or arbitrary command execution.

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
