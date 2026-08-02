# Flopeek architecture

> **For contributors extending Flopeek.** Users normally need the [user guide](docs/using-flopeek.md), [support matrix](SUPPORT.md), and [evidence report](BENCHMARKS.md) instead.

## Document authority

This document describes **how Flopeek currently works, which technical invariants it must preserve, and the target architecture required by the product contract**.

- [PRODUCT.md](PRODUCT.md) is authoritative for product scope and trust rules.
- [ROADMAP.md](ROADMAP.md) is authoritative for delivery order and status.
- [SUPPORT.md](SUPPORT.md) is authoritative for supported parser behavior.

Sections are labeled `current`, `target`, or `decision required`. A target design is not an implemented capability.

## Architecture goals

Flopeek must remain:

- local-first;
- deterministic at the evidence layer;
- useful without an LLM;
- explicit about uncertainty and unsupported behavior;
- bounded for large repositories;
- consumable by both a lightweight viewer and MCP clients;
- safe to run against an existing repository without executing its application code;
- extensible across language and framework adapters;
- capable of preserving human knowledge across graph refreshes.

## System context

```text
                         optional external evidence
                    Git hosting / CI / deploy / telemetry
                                   |
                                   v
Developer or agent --> Flopeek local process --> target repository
       |                    |                         |
       |                    |                         +-- source/config/Git
       |                    |
       |                    +-- scanner + resolvers
       |                    +-- graph/cache/history
       |                    +-- projection/context services
       |                    +-- workflow/evidence services (current foundation)
       |                    +-- continuation/plan/reconciliation services (target)
       |
       +-- CLI
       +-- local viewer on 127.0.0.1
       +-- MCP over stdio
```

Source analysis does not modify source code. Normal cache-enabled commands write only Flopeek cache and metadata under `.flopeek/`; `scan --no-cache` and `impact --no-cache` do not create cache or project-identity metadata. A `--package <relative/path>` scan is also session-only: it cannot read or replace the repository-wide cache because a static package subtree is not a repository-wide graph. No target application code is executed unless a separately configured external integration explicitly does so.

## Current implementation

Status: `current`

### Runtime and packaging

<!-- GENERATED:PRODUCT-CONTRACT:START -->

#### Generated product contract

- Source candidate: `flopeek@0.2.1-beta.4` on npm channel `beta`.
- Last verified preview artifact: `flopeek@0.2.1-beta.3` (`passed`).
- Runtime: Node.js 22 or later (`>=22`).
- Public default core: `js` / javascript.
- Experimental native core: `native-experimental`; rollout is `incomplete` and native-default eligibility is `false`.
- Release approvals: npm `not-approved`; GitHub Release `not-approved`.

This block is generated from repository contracts; edit the source contracts and run `npm run generate:product-contract`.

<!-- GENERATED:PRODUCT-CONTRACT:END -->

- CommonJS modules.
- CLI binary name: `flopeek`.
- Source is currently distributed directly; there is no build step.
- `package.json#files` and `packaging/package-policy.json` bound the candidate tarball to runtime modules, Viewer assets, the Flopeek integration skill, showcase, and public benchmark data. Repository governance, tests, CI, caches, credentials, logs, and source maps are rejected by the package audit.
- `scripts/verify-clean-room.js` packs and installs the exact source tarball into an operating-system temporary consumer with lifecycle scripts disabled, then checks the installed binary, bounded static scan, MCP bootstrap, fixture immutability, and cleanup.
- The source repository is public. npm registry publishing remains intentionally separate from a source tag or GitHub Release; packaging evidence does not decide registry permission or release stage.
- `main` is the only long-lived public source branch. CI validates short-lived
  `<type>/<change-name>` SDLC branch names and rejects tool, vendor, account, or
  agent identity prefixes before running the remaining source and package gates.
- Public Core releases are created from immutable tags on `main` only after the
  source-owned GitHub release approval validates the SHA-256 digest of an exact
  release manifest. That manifest binds the main tarball, rollout-evidence
  bytes, every native platform tarball, and every native binary digest to the
  tag/package/source identity. Outside alpha, the published npm dist-tag is
  validated as well. The approval record is an owner attestation with evidence
  references, not an
  automated proof of human/provider independence. A separate private overlay
  consumes those tagged Core versions and must not copy Core source or become a
  second Core source of truth.

### Main modules

| Module | Current responsibility |
| --- | --- |
| `src/cli.js` | Argument parsing, command dispatch, terminal output, optional browser launch. |
| `src/repository-discovery.js` | Read-only candidate-source, manifest, scope, adapter-demand, resource-bound, and inventory-fingerprint preflight. It can select one validated local package path as a static subtree while retaining ancestor resolver controls. |
| `src/bounded-scan.js` and `src/bounded-scan-worker.js` | Shared bounded analysis envelope for CLI, Viewer/HTTP/SSE, workspace, and MCP surfaces: worker isolation, discovery-plan binding, post-analysis inventory verification, cancellation outcome, complete-result-only graph delivery, and explicit package-scope evidence. |
| `src/scan-coordinator.js` | Shared scan lifecycle, terminal outcome, concurrency guard, last-complete fallback, session freshness, and complete-result-only cache promotion across product surfaces. Package scope forces an ephemeral bounded session. |
| `src/scanner.js` | Repository walk, language parsing, configuration resolution, graph construction, incremental fact cache, Mermaid export, and human descriptions. |
| `src/adapter-registry.js` | Versioned declarative adapter capability contract, validated independently from repository parse coverage. |
| `src/graph-schema.js` | Graph schema v5 validation, compatible-v4 migration harness, and cache contract diagnostics. |
| `src/graph-cache.js` | Validated cache read/write, Windows-safe temporary-file replacement, and cache-state summaries. |
| `src/project-identity.js` | Explicit/generated project identity resolution and persisted local identity metadata. |
| `src/graph-state.js` | Monotonic static graph versioning, material fingerprints, bounded adjacent deltas, and durable state metadata. |
| `src/context-card.js` | Local node/flow Context Ref parsing, JSON/Markdown packet rendering, and explicit resolution states. |
| `src/durable-brief.js` | Versioned Project/Feature/Flow/Node Briefs, evidence-class separation, portable provenance, immutable minimal manifests, and explicit current/stale/expired/unavailable resolution. |
| `src/handoff-context.js` | Deterministic relevance ranking and progressive task Context Packets constrained by an explicitly disclosed character-based token estimator. |
| `src/handoff-workspace.js` | Immutable local handoff versions, append-only attributed notes, portable hashed JSON/Markdown export, and isolated foreign read-only imports. |
| `src/artifact-cache.js` | Separate immutable derived artifacts, exact-version hit checks, bounded access audit, dependency-path/topology invalidation, and explicit stale/expired/unavailable states. |
| `src/project-home.js` | Human-first project orientation, application-scoped deterministic concept index with portable human-tag reasons and ambiguous-alias abstention, evidence-linked starting points, documentation-readiness projection, and explicit bounded catalogs. |
| `src/handoff-quality.js` | Versioned legacy-fixture quality evaluation for bounded retrieval, composition timing, token size, stale detection, evidence traceability, and separately classified agent outcomes. |
| `src/runtime-evidence.js` | Opt-in, sanitized, Context Ref-bound runtime-observation store with separate retention and immutable expired manifests; it never mutates the static graph. |
| `src/serve-workspace.js` | Machine-local serve-instance registry and deterministic workspace identity derived from project identity. |
| `src/workspace-server.js` | One user-facing multi-project hub port, project activation/selection, explicit current-context cross-project contract references, persistent machine-local project tree, and proxying to isolated per-project graph services. |
| `src/workspace-contract-reference.js` | Strict machine-local append-only store for explicit human cross-project Flow Context Ref snapshots and current/stale/unavailable resolution. |
| `src/flow-entry.js` | Versioned static entry contracts for extracted HTTP requests, narrow literal package scripts, narrow Python framework-command declarations, and narrow literal `node-cron` schedule registrations. |
| `src/flow-lens.js` | Bounded Flow Lens projection for supported static entries with derived roles, deterministic edge evidence references, static boundaries, branches, and limits. |
| `src/flow-interface.js` | Honest per-flow boundary projection: method, route, exact handler, related tests, and one handler-bound Next.js literal-contract pilot; dynamic/unsupported payload-response forms remain explicit unavailable. |
| `src/flow-comparison.js` | Retained bounded before/current Flow Lens snapshots and deterministic adjacent-delta comparison. |
| `src/flow-context-card.js` | Portable flow Context Card construction from one bounded Flow Lens and direct related-test evidence. |
| `src/semantic-flow-suggestion.js` | Versioned deterministic semantic candidates, confidence, evidence references, and abstention policy. |
| `src/agent-semantic-proposal.js` | Immutable current-Context-Ref provider/agent proposal overlays that remain unverified until a person acts. |
| `src/agent-evidence-trace.js` | Append-only agent-declared Context Ref, action, changed-path, and verification audit metadata. |
| `src/test-run-journal.js` | Append-only sanitized runner-adapter progress events with validated Flow Lens step transitions and explicit terminal state. |
| `src/delivery-graph.js` | Local, atomically persisted work-record plans and append-only actual delivery events, each scoped to one project and optional Context Refs. |
| `src/workflow-engine.js` | Versioned Agile, Waterfall, and validated custom workflow definitions; derives local work state and bounded declared dependency readiness from append-only events, rejects transitions missing declared evidence kinds, and blocks only built-in implementation entry when dependencies are not locally ready. |
| `src/trust-analytics.js` | Read-only aggregation of independent evidence availability, provenance, denominators, and freshness with explicit non-claims and no composite score. |
| `src/product-proof.js` | Validates pinned public benchmark evidence, combines it with current-repository facts and an optional explicit local benchmark, and preserves public claim boundaries. |
| `src/agent-bootstrap.js` | Builds the provider-independent bootstrap contract that names graph identity, readiness, parser coverage, safe workflow, and evidence limits without source bodies or machine paths. |
| `src/agent-integration-registry.js` | Versioned registry of supported local agent hosts, project-local skill/config paths, stdio capability, and explicit remote-only boundaries. |
| `src/agent-integration.js` | Non-destructive install, uninstall, dry-run, host detection, ownership manifest, and integration diagnostics for the generated Flopeek skill and MCP entries. |
| `src/orientation-benchmark.js` | Source-pinned direct-repository versus Flopeek deterministic orientation evaluator with separate evidence classes, bounded metrics, stale probes in temporary copies, and no provider or target execution. |
| `src/agent-comparison.js` | Provider-neutral validator and scorer for explicitly supplied paired agent outcomes; provider execution, target execution, source bodies, and machine-local paths remain outside the tool. |
| `src/git-metadata.js` | One-command Git branch/revision/dirty metadata plus static Git directory, shallow-state, and origin-remote reads used to reduce cold scan overhead. |
| `src/package-policy.js` | Strict npm pack inventory validation, runtime allowlist, denied cache/credential/governance content, size bounds, package identity, and prepared-publication/explicit-approval boundary. |
| `src/clean-room-package.js` | Isolated tarball pack/install verification, installed CLI and MCP smoke contracts, copied-fixture fingerprinting, host-specific phase observations, and mandatory temporary-state cleanup. |
| `src/showcase.js` | Validated temporary-workspace checkout demonstration with bounded apply/reset/status mutations, viewer deep linking, automatic cleanup, and no target-application execution. |
| `src/framework-route.js` | Isolated deterministic Next.js and SvelteKit file-system route derivation used by scanner classification and analysis. |
| `src/source-classification.js` | Isolated deterministic source type, layer, label, domain, and feature derivation used by the scanner. |
| `src/structural-fact-adapter.js` | Normalizes Go and C# parser facts plus explicit inventory-only fallback into scanner analysis facts. |
| `src/go-adapter.js` and `src/go-facts.go` | Optional Go compiler-parser bridge. |
| `src/csharp-adapter.js` and `src/csharp-facts.cs` | Optional .NET/Roslyn structure bridge. |
| `src/graph-service.js` | Viewer projections, search, node details, Context Cards, related tests, graph delta, impact analysis, and agent context. |
| `src/server.js` | Loopback HTTP API, SSE, recursive source watcher, dedicated cross-platform repository-config stat watcher, refresh coordination, static viewer assets. |
| `src/mcp.js` | Source-read-only MCP graph/context tools over stdio plus bounded idempotent metadata appends for traces, semantic review/proposals, and explicit runner events; no shell or source-write surface. |

### Guided checkout showcase

Status: `current`

- `flopeek showcase` validates `examples/commerce-showcase/flopeek-showcase.json`, copies the example to a uniquely marked operating-system temporary directory, starts the ordinary local server with port fallback, and deep-links the viewer to the declared primary Flow Lens.
- The original example is never scanned in place. The generated workspace is removed when the server closes unless `--keep-workspace` is explicit.
- `showcase apply`, `reset`, and `status` operate only on the manifest-declared source inside a valid marked workspace. Hash checks make baseline/changed operations idempotent and reject unexpected local divergence.
- The deliberate source change is owned by the showcase CLI. Viewer, HTTP, and MCP remain graph/context surfaces and expose no general repository-source write or arbitrary shell operation.
- The target application, its dependencies, and its tests are not executed. The viewer describes static parser evidence, bounded projections, unsupported constructs, and related-test candidates without converting the demonstration into benchmark, runtime, or release evidence.
- Viewer, HTTP, and real stdio MCP integration tests require one project ID, graph version, primary flow ID, displayed step set, and Context Ref for the same graph state.

### Public product proof

Status: `current`

- `benchmarks/public-proof.json` is the reviewed public evidence packet; its totals must match `benchmarks/real-repository-corpus.json`.
- `flopeek proof` runs an explicit local benchmark and combines it with the pinned public evidence.
- `GET /api/product-proof` and MCP `get_product_proof` return the report without starting repository work beyond the graph already being served.
- `POST /api/product-proof` is a trusted-loopback, explicit action that runs the local comparison before returning the same schema.
- The local viewer is a renderer of this contract, not a separate analytics authority.
- Published precision/recall remains scoped to declared audited relationships. Published timings remain host- and revision-specific.
- Product proof never becomes a live-repository accuracy score, a release gate, or a replacement for Trust Analytics evidence classes.
| `src/history.js` | Static Git archive snapshots and topology/flow comparison. |
| `src/active-branch-git-evidence.js` | Bounded read-only active-branch path-touch Git evidence for a resolved current/stale Context Ref. |
| `src/git-context-continuity.js` | Read-only two-snapshot Context Ref continuity projection with exact static identities and bounded same-path candidates. |
| `src/benchmark.js` | Full-versus-incremental local benchmark. |
| `src/real-repository-corpus.js` | Pinned external-repository audit runner with per-repository process bounds, progress, and structured partial results. |
| `public/` | Framework-free browser viewer using Cytoscape.js and Dagre. |

### Current Viewer rendering

The Viewer renders bounded server projections; it does not query or reconstruct the repository independently. Semantic zoom derives Domain, Feature, Component, and Symbol summaries from the same factual graph. Its derived hierarchy ids retain every selected ancestor, so a drill-down cannot broaden into a same-named peer in another domain; summary nodes remain explicitly derived rather than source or runtime facts. Cytoscape's Canvas renderer handles supported interaction and Dagre provides the initial layout. A local explicit WebGL preview can render the same bounded projection with Bezier edges; it remains an experimental evaluation path and automatically falls back to Canvas if unavailable. A focused node applies directional classes to incoming edges, the selected node, and outgoing edges. Shape, border, text, and a persistent legend repeat the meaning so color is never the only signal. Unrelated edges are dimmed and relationship labels appear only in focused context to keep dense maps readable. The graph stage continues to label the map as static evidence.

WebGL is available only as a local preview option for dense projections; Canvas remains the supported backend. A default-renderer change must first demonstrate better interaction latency and memory behavior on pinned dense graphs while preserving label readability, semantic zoom, directional focus, keyboard-accessible navigation outside the canvas, screenshots, and evidence selection parity. Renderer throughput cannot justify sending or displaying an unbounded repository graph. See [ADR-018](docs/adr/ADR-018-bounded-webgl-preview.md).

### Current scan pipeline

Cold scans load Python, PHP, Java, and Rust parsers only when a participating file requires that adapter. Git metadata uses one `status --porcelain=v2 --branch` process; Git directory, worktree common directory, shallow state, and direct origin remote are read statically. Scanner profiling is an opt-in callback with `scope-and-identity`, `source-analysis`, `resolver-context`, and `graph-assembly` phases. Timings are not serialized into graph evidence or material fingerprints.

```text
repository root
  -> recursive file discovery
  -> ignore known generated/vendor directories
  -> classify recognized source extension
  -> parse with registered adapter or retain as inventory-only
  -> create file, symbol, endpoint, runtime, and external facts
  -> resolve supported internal imports and direct calls
  -> build nodes and evidence edges
  -> build bounded supported static-entry flows
  -> summarize repository parse coverage and registry capabilities
  -> optionally write .flopeek/graph.json
```

The target repository's code and configuration are not executed. Some optional language adapters compile and run a local helper against source text, not the target application.

An optional bounded CLI path adds a read-only discovery contract before parsing:

```text
flopeek discover
  -> inventory candidate source and static manifests
  -> classify scope and adapter demand
  -> calculate an opaque source-plan and resolver-control fingerprint
  -> report whether declared time/file/byte bounds permit analysis

flopeek scan --budget-ms/--max-files/--max-bytes
  -> run the exact discovered source plan in a worker
  -> verify the same immutable plan after analysis
  -> re-read only planned directories plus source/resolver-control candidates
  -> return a complete graph only when the inventory still matches
  -> never promote a bounded, cancelled, invalidated, or failed graph
```

The shared scan coordinator now wraps CLI bounded scans, local-server startup and
watcher refresh, Viewer/HTTP/SSE status, and MCP refresh:

```text
scan request
  -> publish one flopeek-scan-outcome/v1 operation
  -> expose running phase and declared bounds
  -> activate a complete current graph only after successful analysis
  -> otherwise retain the last complete graph as stale-unverified
  -> never promote incomplete evidence
  -> permit explicit cancellation only while bounded worker analysis is active
```

Cache-disabled coordinator sessions use a process-local project identity and
monotonic graph versions. Their adjacent deltas can detect stale Context Refs
inside that session, but are not durable or interchangeable with another
process. Bounded mode still performs full planned analysis per refresh; parser
fact reuse remains available only in the unbounded in-process scanner.
Worker termination prevents graph result promotion, but cleanup of optional
adapter child processes has not yet been demonstrated across operating systems.
Discovery creates one immutable plan. Analysis consumes its exact source paths;
verification re-reads the plan's directories and relevant source/control entries
to reject added directories or changed source inventory without repeating
workspace, adapter, manifest, scope-report, or limit discovery.
Its fingerprint records path, size, and modification-time metadata, not source
content. A rewrite that deliberately preserves both size and timestamp is
outside this mutation detector's evidence boundary.
A candidate repository switch is scanned transactionally: it publishes no
active-project progress unless accepted. Cache-disabled sessions use their own
process-local graph identity and may resolve only their matching in-memory
adjacent delta; they never fall back to durable delta storage from the same path.

### Current incremental pipeline

`createRepositoryScanner()` retains per-file parser records and fingerprints in process.

```text
filesystem event
  -> batch for a short debounce period
  -> identify changed paths or request reconciliation
  -> parse changed source records
  -> reuse unchanged records
  -> invalidate resolver context when topology/configuration changes
  -> rebuild graph-wide relationships from retained facts
  -> write the complete current graph cache
  -> emit an SSE graph update
```

This is incremental parsing, not fully incremental graph materialization. Global relationships and projections are rebuilt from retained facts.

### Current graph envelope

The serialized graph uses schema version 5:

```json
{
  "schemaVersion": 5,
  "generatedAt": "ISO-8601 timestamp",
  "project": {
    "root": "absolute local path",
    "name": "repository directory name",
    "projectId": "configured or generated local identity",
    "identity": { "source": "configured or generated", "status": "configured, created, persistent, or remote-mismatch" },
    "git": {
      "branch": "branch or not-a-git-repository",
      "revision": "short revision or null",
      "shallow": false
    }
  },
  "state": {
    "graphVersion": 42,
    "materialFingerprint": "sha256:...",
    "sourceFingerprint": "sha256:...",
    "sourceRevision": "git revision or null",
    "updatedAt": "ISO-8601 timestamp",
    "status": "advanced or current"
  },
  "analysis": {},
  "stats": {},
  "nodes": [],
  "edges": [],
  "flows": [],
  "diagnosticFlows": []
}
```

`analysis.adapterCapabilities` contains the versioned
`flopeek-adapter-capabilities/v2` compatibility registry. It is deterministic
product-level metadata and does not vary with the scanned repository.
`analysis.executionAdapterCapabilities` reports the implementation actually
executing that graph. For example, JavaScript C# execution requires the .NET
Roslyn helper while the native C# parser is bundled; the compatibility registry
does not change, so compatibility digests remain stable. `analysis.coverage`
remains separate: it reports what happened while parsing this repository and is
not runtime coverage. Agent context and capability surfaces expose both
registries.

`schemaVersion` identifies the file format. `projectId` identifies the local project context. `state.graphVersion` identifies one material static graph state within that project, while `generatedAt` only records a scan time. The material fingerprint includes the deterministic graph payload and source content/revision evidence, excluding transient refresh/cache fields. Thus a source-only edit can advance the graph version while its delta correctly reports no topology change. See [ADR-002](docs/adr/ADR-002-graph-version.md).

### Current node model

Common fields include:

```json
{
  "id": "symbol:src/example.ts:function:run",
  "kind": "symbol",
  "type": "function",
  "label": "run",
  "path": "src/example.ts",
  "domain": "Example",
  "feature": "example",
  "layer": "application",
  "analysis": {
    "parser": "typescript-ast",
    "status": "extracted",
    "confidence": "exact"
  },
  "manualDescription": ""
}
```

IDs are deterministic for a current path/type/name combination. They are not guaranteed to survive file moves, symbol renames, splits, or merges.

### Current edge model

Edges represent supported static relationships and include evidence/confidence fields where the adapter provides them.

Common relationship families include:

- declaration/containment;
- import/use;
- direct supported calls;
- endpoint handler connection;
- runtime integration initialization/use;
- data or queue usage;
- test relationships;
- derived aggregate projection edges.

The exact set varies by adapter. Absence of an edge does not prove absence of runtime behavior.

### Current flow model

`buildFlows()` selects supported static entries: extracted HTTP endpoints, literal `package.json` scripts with exactly one supported runner and one repository-local scanned source target, narrow Python framework command declarations (Django `management/commands/<name>.py` modules with one top-level `Command` class directly extending the imported `django.core.management.base.BaseCommand` binding and one direct `handle` method; Click direct module decorators; Typer decorators on a direct top-level `typer.Typer()` receiver; or Flask CLI decorators on a direct top-level imported `Flask` receiver) with one exact target, and module-scope default-import `node-cron` `schedule()` calls with one safe literal cron expression and one exact local top-level function target. Route/controller nodes plus unsupported scripts, framework command forms, or scheduler registrations remain technical nodes or machine-readable unsupported-entry inventory; they do not become Flow Lenses by fallback. Each entry traversal is bounded:

- no silent entry-count cap; a surface that paginates must expose returned and omitted entry IDs;
- at most 24 steps per flow;
- maximum depth 6;
- test-layer steps are omitted.

The stored flow remains a compact scanner traversal containing node ID, label, type, depth, and a `flopeek-static-flow-entry/v1` entry contract. `src/flow-entry.js` defines the contract. `src/flow-lens.js` projects one stored flow into `flopeek-flow-lens/v1` without changing parser facts. HTTP entries retain handler evidence; package scripts begin with an exact `declares-command-target` transition and retain only manifest, script, runner, and target declaration fields; the Python framework-command subsets begin with the same exact declaration edge to their direct class or function target and retain only adapter, command name, and target declaration fields; the narrow `node-cron` subset begins with an exact `schedules` transition and retains only adapter, literal schedule expression, local task name, and target declaration fields. The projection adds a graph-versioned entry, derived role per displayed step, Context Ref, deterministic edge evidence reference, bounded fan-out, supported static persistence/queue/external boundaries, ambiguity, and truncation metadata. `src/flow-lens-options.js` owns the shared strict display contract: 12 steps by default, an integer range of 1 through 24, and no silent clamping.

The Flow Lens does not infer command invocation, Django app registration or settings loading, scheduler initialization, task timing or execution, runtime order, branch conditions, control flow, business process, successful side effects, or flow-level human verification. `src/semantic-flow-suggestion.js` adds `flopeek-semantic-flow-suggestion/v1` as a deterministic derived layer over literal HTTP entry, displayed roles, direct transitions, and static boundaries. It explicitly abstains for package-script, framework-command, and scheduler entries and never creates human verification. Raw node Context Cards remain the step-level evidence drill-down. `src/flow-context-card.js` packages the same suggestion with one current bounded Flow Lens as `kind: flow` in `flopeek-context/v1`. Viewer, HTTP, MCP, JSON packets, and Markdown packets propagate the same requested limit and report requested, displayed, source, and truncation-reason metadata. Derived-cache keys include `flowId`, scope, and validated limit, so compact and expanded projections cannot alias.

When an adjacent persisted delta affects a flow, `src/flow-comparison.js` retains only that flow's bounded Flow Lens snapshots (up to 12 affected flows and the Flow Lens step bound). `flopeek-flow-comparison/v1` compares the retained before/current snapshots by step membership, depth, parser-edge transition IDs, displayed node metadata, and known changed source steps. It can distinguish a source-only change from a bounded static-structure change, but it cannot reconstruct an uncaptured historical flow, source contents, runtime history, or a historical Context Card.

### Current projection service

The viewer/API offers three map modes:

- feature overview;
- entry map (legacy `requests` mode);
- direct dependencies.

Scopes separate application, runtime, framework, devtool, and broader inventory views. Aggregate nodes and edges are explicitly marked as derived.

Search is deterministic metadata lookup over label, path, feature, domain, and type. It does not search source contents or infer intent.

### Current local server

The server binds to `127.0.0.1` and provides:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Process health. |
| GET | `/api/serve-workspace` | Per-project serve registry membership or central-hub workspace/project tree. |
| GET | `/api/events` | SSE stream for graph refresh and error events. |
| GET | `/api/graph` | Complete current graph. |
| GET | `/api/capabilities` | Versioned general adapter capabilities, repository coverage, and interpretation limits. |
| GET | `/api/cache-artifacts` | Derived artifact manifests, freshness, hit/miss counts, invalidation events/reasons, and stale-reuse policy. |
| GET | `/api/trust-analytics` | Shared evidence-observability report for viewer and agents; no composite truth score or live-repository accuracy claim. |
| GET | `/api/project-home` | Human-first current project orientation and optional deterministic concept search with Context Ref evidence. |
| GET | `/api/view` | Bounded viewer projection. |
| GET | `/api/agent-context` | Projection interpretation for agents. |
| POST | `/api/handoff-context` | Read-only task composition with explicit approximate token budget, confidence, omissions, risks, deltas, tests, and evidence refs. |
| POST | `/api/handoff-quality` | Evaluate explicit handoff benchmark cases and optional consented privacy-minimized human time-to-locate observations without executing source or promoting retrieval success to an agent task outcome. |
| GET/POST | `/api/runtime-evidence` | Read or append a trusted-local, sanitized runtime observation; it is separate from static graph facts and uses its own retention/manifests. |
| GET/POST | `/api/test-runs`, `/api/test-run-events` | Read grouped runner progress or append one sanitized current-context adapter event; no command execution. |
| GET/POST | `/api/handoff-workspaces` | List immutable local versions or append a new version that supersedes the current workspace. |
| GET | `/api/handoff-workspace` | Read one local workspace with its note lifecycle. |
| POST | `/api/handoff-notes` | Append an attributed note or same-subject successor without overwriting history. |
| GET | `/api/handoff-export` | Export one local workspace as hashed JSON or human-readable Markdown with an embedded exact packet. |
| GET/POST | `/api/handoff-imports` | List isolated foreign artifacts or import a packet as read-only and foreign-unverified. |
| GET | `/api/search` | Deterministic node search. |
| GET | `/api/project` | Project metadata. |
| GET | `/api/flows` | Current detected flows. |
| GET | `/api/entry-flows` | Supported current entry flows, grouped by static entry family. |
| GET | `/api/flow-lens` | One bounded evidence-rich static flow from a supported entry. |
| GET | `/api/flow-suggestion` | The same deterministic semantic suggestion or abstention exposed by the selected Flow Lens. |
| GET | `/api/semantic-suggestion-feedback` | Current immutable feedback resolution for one Flow Lens suggestion. |
| GET/POST | `/api/agent-semantic-proposal`, `/api/agent-semantic-proposals` | Read or append an unverified provider/agent draft bound to the current Flow Context Ref. |
| GET | `/api/semantic-memory` | Verification-backed current/compatible semantic metadata; not model weights or automatic verification. |
| GET | `/api/semantic-suggestion-feedbacks` | Bounded local feedback history filtered by flow, Context Ref, decision, or linked trace operation. |
| POST | `/api/semantic-suggestion-feedbacks` | Trusted-local idempotent append of a human label for the server-calculated current suggestion. |
| GET | `/api/agent-evidence-traces` | Bounded agent-declared audit records, optionally filtered by Context Ref or operation ID. |
| POST | `/api/agent-evidence-traces` | Trusted-local idempotent append to the agent evidence trace store. |
| GET | `/api/flow-context-card` | Current bounded flow Context Packet in JSON or Markdown. |
| GET | `/api/flow-comparison` | One retained adjacent before/current Flow Lens comparison, when captured. |
| GET | `/api/changed-contexts` | Bounded node and Flow Lens contexts affected by one retained adjacent delta. |
| GET | `/api/history` | Static Git graph comparison. |
| GET | `/api/active-branch-git-evidence` | Bounded read-only active-branch commits touching current Context Card paths. |
| GET | `/api/git-context-continuity` | One current/stale Context Ref compared across two static Git snapshots. |
| GET | `/api/impact` | Static impact traversal. |
| GET | `/api/export/mermaid` | Mermaid representation. |
| GET | `/api/node` | Raw node evidence and direct relationships. |
| GET | `/api/context-card` | Raw-node Context Packet in JSON or Markdown. |
| GET | `/api/context/resolve` | Explicit local Context Ref resolution state. |
| POST | `/api/benchmark` | Local scan benchmark. |
| POST | `/api/scan` | Manual reconciliation. |
| POST | `/api/snapshots` | Create static Git snapshot. |
| POST | `/api/descriptions` | Save human description. |

`get_trust_analytics` exposes the same report over MCP. The report is calculated at read time instead of being cached as one artifact because verification, semantic feedback, agent traces, test-run events, and runtime observations can change without advancing the static graph version. A report evaluates at most 200 application Flow Lenses and exposes its total/evaluated/omitted catalog rather than hiding a sample. Each Flow Lens remains step-bounded, and the report never includes source bodies.

Mutation endpoints require a trusted loopback-origin request. Per-project serve advances past occupied or OS-reserved loopback ports unless `--strict-port` is set. Global mode (`-g`) exposes one user-facing hub port; later commands activate projects on that hub instead of replacing it. A machine-local live registration lets the same workspace ID find that hub if it had to use a fallback port. Each hub member keeps an isolated graph/cache/watcher behind an ephemeral loopback backend. The hub never merges graphs or infers cross-project edges. At the hub boundary, `POST /api/scan` may only refresh the configured root of the active project; a root switch must use `/api/workspace/projects` so workspace identity cannot drift from the backend graph.

### Current central workspace hub

The machine-local workspace definition is stored outside every scanned repository under the user Flopeek serve registry. It may contain absolute project roots because it is explicitly non-portable operational state. It is never included in Handoff Workspace exports.

```text
flopeek serve service-a -g --workspace commerce
  -> start hub on requested/next free port
  -> scan service-a into its own project graph

flopeek serve service-b -g --workspace commerce
  -> detect the existing hub on that port
  -> activate service-b in the same project tree
  -> keep service-a graph/cache intact
```

The viewer selector changes the hub's active project. Ordinary viewer/API/SSE routes are proxied to that active project. A person may declare a machine-local cross-project `http-contract` reference only by supplying the current Flow Context Ref and graph version of both Flow Lenses. The hub resolves each side as `current`, `stale`, or `unavailable`; this declaration remains separate metadata and never merges graphs, forms an automatic composed flow, or claims runtime behavior. Equal route, symbol, feature, or service names never create a reference.

Hub-only endpoints are `GET /api/workspace/contracts`, `GET /api/workspace/contracts/catalog?projectId=...&limit=...&offset=...`, and trusted-local `POST /api/workspace/contracts`. The catalog has deterministic offset pagination with total/returned/omitted IDs, previous/next offsets, and a visible warning; creation rejects a stale source or target snapshot.

### Current SSE contract

The `scan-status` event exposes the same operation ID, running phase, declared
bounds, terminal result, active complete-graph source, freshness, and
cache-promotion state returned by HTTP and MCP. The `ready` event includes the
current terminal outcome. A non-complete event never carries a partial graph.

The graph event contains:

- `generatedAt`;
- refresh reason;
- graph stats;
- a bounded list of newly added file nodes;
- an added/removed node-and-edge summary;
- retained adjacent-delta identity when a material graph version advanced;
- the matching bounded `flopeek-changed-contexts/v1` projection when available.
- server-side `refreshToAffectedContextMs` and `changedContextProjectionMs` timing, measured after watcher debounce and before SSE transport.

The browser reloads its current projection after the event and preserves a selected Flow Lens when it still exists. Its live tray opens current affected nodes or flows, marks displayed Flow Lens steps whose IDs appear in `changedStepIds`, and can open a retained before/current Flow Lens comparison for a captured affected flow. Historical comparison steps are read-only; current steps drill into current raw-node evidence. The SSE envelope is not itself persisted; its delta identity and changed-context evidence are read from the durable retained adjacent delta.

### Current MCP contract

MCP is read-only with respect to repository source. Current tools:

The stdio transport completes the MCP `initialized` handshake before the initial repository scan is scheduled, so host tool discovery is not gated on graph construction. Before a complete graph exists, `get_scan_status` returns its explicit `idle` or `running` outcome and `get_agent_bootstrap` returns no graph identity or parser inventory. Graph-dependent tools must not treat that state as missing behavior; they require a complete/current graph or direct source fallback.

- `get_agent_bootstrap`;
- `get_scan_status`;
- `cancel_scan`;
- `get_project_overview`;
- `find_nodes`;
- `get_node`;
- `get_direct_dependencies`;
- `get_entry_flows`;
- `get_request_flows`;
- `get_flow_projection`;
- `get_semantic_suggestion_feedback`;
- `get_agent_semantic_proposal`;
- `record_agent_semantic_proposal`;
- `record_semantic_suggestion_feedback`;
- `get_flow_context_card`;
- `get_flow_verification`;
- `get_verified_semantic_memory`;
- `get_test_runs`;
- `record_test_run_event`;
- `get_change_impact`;
- `get_related_tests`;
- `get_agent_context`;
- `get_handoff_context`;
- `get_context_card`;
- `resolve_context_ref`;
- `get_agent_evidence_traces`;
- `record_agent_evidence_trace`;
- `get_graph_delta`;
- `get_changed_contexts`;
- `get_flow_comparison`;
- `create_git_snapshot`;
- `compare_git_snapshots`;
- `refresh_graph`.

An agent reads and edits a returned source path with its existing workspace tools. Flopeek does not expose source contents, a shell, source-write actions, deployment, or credentials. Metadata-write tools are non-destructive, idempotent, schema-bounded appends limited to local `.flopeek` JSON. Agent proposals and runner events cannot create human verification; runner events report an external adapter's progress and never execute a command. All remaining agent evidence tools are read-only.

### Current agent-host integration

`flopeek install` reads a versioned platform registry and writes only project-local host configuration plus a canonical generated tool-usage skill. JSON adapters preserve unrelated keys under `.mcp.json`, `.cursor/mcp.json`, or `.gemini/settings.json`. Codex uses an explicitly delimited managed block in `.codex/config.toml`; an unmanaged or modified Flopeek entry is a conflict, never an overwrite. Skill targets are `.claude/skills/flopeek`, `.agents/skills/flopeek`, `.cursor/skills/flopeek`, or `.gemini/skills/flopeek`.

The installer preflights all selected platform changes before writing, supports dry-run, records ownership in `.flopeek/agent-integrations.json`, and copies only the canonical `integrations/skills/flopeek` tree. Reinstall is idempotent. Uninstall removes a skill only when its content hash still matches the canonical managed skill and removes an MCP entry only when it still matches the managed value. `doctor` inspects files and PATH without starting an AI host. ChatGPT web remains explicitly `remote-only` because it cannot consume project-local stdio configuration.

The generated skill is an adapter for using Flopeek, not a developer persona team and not a source of parser facts. Providers consume `flopeek-agent-bootstrap/v1`; they may inspect source and propose changes through their own authorized tools, but they cannot promote a proposal into extracted graph evidence or human verification.

### Current cache layout

```text
.flopeek/
├── project.json
├── graph.json
├── state.json
├── descriptions.json
├── flow-verifications.json
├── agent-semantic-proposals.json
├── semantic-suggestion-feedback.json
├── agent-evidence-traces.json
├── test-runs/
│   └── events.json
├── runtime-evidence/
│   └── records.json
├── delivery/
│   ├── workflows.json
│   └── work-records.json
├── deltas/
│   └── <from>-<to>.json
└── history/
    └── <full-git-sha>.json
```

`graph.json` is schema-v5 validated before persistence and whenever Flopeek attempts to reuse it. Invalid JSON, unsupported versions, malformed envelopes, a different resolved project root, or a different project ID return machine-readable diagnostics and no reusable graph. The migration harness accepts compatible v4 graph evidence and preserves current v5 state separately.

Writes use a temporary file beside the destination, flush and close it when supported, then replace the cache through bounded retry for transient Windows lock errors. On a failure, Flopeek removes the temporary file and preserves the prior destination. `project.json` records a generated local UUID when config does not provide an explicit `projectId`; see [ADR-001](docs/adr/ADR-001-project-identity.md).

`project.json`, `state.json`, bounded adjacent `deltas/`, immutable `flow-verifications.json`, append-only `agent-evidence-traces.json`, append-only `semantic-suggestion-feedback.json`, durable Brief manifests, the `handoff/` workspace/note/import stores, the `delivery/` work-record/workflow stores, and the `cache/` derived-artifact registry belong beside `graph.json` and `descriptions.json` in this current layout. Heavy Briefs, imported handoffs, and derived values live in their own artifact directories; their minimal manifests remain auditable if an artifact expires. `config.json`, when present, remains the versionable scope/identity policy file; generated graph and project metadata remain local cache state.

### Current static history

Git snapshots are produced through `git archive` in a temporary directory. Flopeek does not check out or modify the working tree. Comparisons include:

- commit metadata;
- changed Git paths;
- added/removed graph nodes and edges;
- added/removed/changed static flows.

This history excludes uncommitted changes and is not runtime history.

### Current Git Context continuity

`src/git-context-continuity.js` resolves only a current or stale Context Card,
then creates or reuses two static `git archive` snapshots. It reports exact
static node or flow identity presence separately from bounded nodes found at
the same current repository-relative paths. Same-path results are candidates
only: Flopeek does not follow renames, infer successors, reconstruct a
historical Context Card, or claim implementation/rationale/runtime equivalence.
The projection is available through local HTTP, MCP, and CLI; it never checks
out, fetches, merges, rebases, mutates refs, executes code, or returns source
bodies or author identity.

### Current active-branch Context evidence

`src/active-branch-git-evidence.js` resolves only a current or stale Context
Card, collects its current repository-relative paths, and reads at most 50
commits per path from the current attached branch `HEAD`. It never follows
renames, checks out source, fetches, merges, rebases, mutates refs, or returns
source bodies or author identity. A commit indicates only that it touched a
path. It is not evidence of a symbol introduction, original rationale, runtime
behavior, review, test success, or release state. Detached `HEAD`, non-Git
targets, missing paths, and unresolved/historical Context Refs return an
explicit unavailable result.

## Current quality architecture

### Test layers currently present

- parser and integration behavior in `test/scanner.test.js`;
- the `flopeek-core-compatibility/v1` JavaScript oracle and committed audited-fixture baseline, which exclude session-local state while pinning stable static facts;
- agent evidence trace contracts in `test/unit/agent-evidence-trace.test.js`;
- relationship precision/recall fixture gate in `test/fixture-corpus.test.js`;
- pinned external-repository audit through `src/real-repository-corpus.js`;
- GitHub Actions for Node 22/24 pull-request tests;
- scheduled and manual external corpus workflow.

The scanner integration suite is large and should be split into faster feedback lanes as the architecture is modularized.

### Native-core strangler boundary

The current `flopeek-core-client/v6` facade gives an unbounded scan coordinator
one explicit `scan`/`refresh`/`getLastCompleteGraph`/`materializeGraph`/`close`
lifecycle. Native
mode uses Rust+SQLite as its sole graph and core-query authority; it cannot
construct or accept `JsCoreClient`. On the strict source path, Rust owns
inventory, parsing for every rollout-required adapter (including bundled Go),
import resolution, source hashes, and
structural-record ordering, batch envelope, entry metadata, and graph assembly;
bounded Project Overview selection and its static agent-context evidence are
also assembled by Rust. Node may append only explicitly local runtime evidence,
cache audit, semantic feedback, and trace metadata; it must not rebuild a
native view or silently substitute JavaScript static context.
it rejects unpromoted adapters instead of invoking a JavaScript parser. The
ephemeral path performs the same work in one Rust JSONL session without SQLite
or repository metadata. `native-experimental` is the explicit dogfood request;
the rollout-gated `native` request records a visible JavaScript fallback when
it cannot select native. Normal `native` activation loads an immutable bundled
rollout packet and probes the installed platform package; selection still
requires an eligible five-repository gate and an exact package/protocol/adapter
contract/platform-binary binding. MCP uses handle-only graphs for native-safe
tools and one lazy verified `materializeGraph` snapshot per graph handle for
legacy tools. The broad synchronous HTTP surface deliberately requests a
materialized graph until every route has an async native boundary; its native
cache/capability/delta routes do not read `graph.json`. MCP and HTTP share the
same client instance with their coordinator. Legacy delivery and extension
calls remain separate adapters. `native/flopeek-core --native-serve` exposes the persistent
`flopeek-native-protocol/v1` JSONL bootstrap with request IDs and typed errors.
`StructuralFactBatch/v1` has no source-body transport. A separate bounded
manifest-only `sourceBatch` may transfer current changed UTF-8 text once to the
JavaScript parser, then is discarded. It is accepted only when the inventory
size and nanosecond modification stamp still match the file; otherwise the
parser rereads disk. It is not accepted by StructuralFactBatch, SQLite, or the
record cache. The native incremental coordinator uses one such
session for its manifest, JavaScript-record load, and record-store requests;
it does not turn that per-scan session into a cross-command daemon. Its
`StructuralFactBatch/v1` receipt is shadow-only:
it neither emits public IDs nor promotes a public graph. After an exact native
structural shadow comparison, an explicit dogfood option may persist that
non-public projection through the native SQLite building/complete lifecycle;
the persisted SHA-256 projection digest and structural-facts fingerprint are
cache evidence only. Native shadow queries now cover related tests, current and
retained change impact, Flow Lens, node/flow Context Cards, Context Ref
resolution, adjacent public deltas, and changed contexts. Their exact corpus
fixtures are compatibility gates, not a public cutover: CLI, HTTP, MCP, and
Viewer still receive the JavaScript CoreClient result. SQLite delta retention is
manual and dry-run-first; it deletes neither a graph version nor the latest
adjacent delta. Native historical impact may read only a complete SQLite version
whose persisted projection digest still verifies; it is cache evidence, not a
public cache cutover. The native queries remain opt-in until their async
protocol boundary, exact corpus parity, prior graph/delta behavior from SQLite
where applicable, and explicit fallback behavior are promoted through the
CoreClient contract. See
[ADR-024](docs/adr/ADR-024-native-core-strangler-contract.md) for the required
parity, authority, and rollback gates before native graph assembly or SQLite
promotion can become observable.

### Evidence boundaries

- Fixture precision/recall applies only to declared expected relationships.
- External audit applies only to pinned manually inspected source scopes.
- Parser coverage counts parsed/inventory/failed files; it is not behavior coverage.
- Benchmark speed is local CPU-time evidence; it is not a universal performance guarantee.

## Current architecture risks

### Monolithic scanner

`src/scanner.js` currently combines discovery, classification, parsers, resolvers, graph assembly, incremental cache, descriptions, and export. This makes adapter growth and isolated testing increasingly difficult.

### Repository scope configuration

Iteration 1 adds a versioned, optional `.flopeek/config.json` read before discovery. It controls `sourceRoots`, `testRoots`, `fixtureRoots`, `exclude`, optional `projectId`, and `flowEntries.tests`/`flowEntries.fixtures`. Classification precedence is `excluded`, `fixture`, `test`, `generated`, then `application`. No target configuration is executed.

The scanner retains test, fixture, and generated records in the graph as static diagnostic evidence. Only application endpoints are default flow entries; test or fixture entries require explicit policy. Scope changes invalidate retained source records and force a reconciled graph build. Invalid configuration throws before scan output or cache writing, preserving any previous valid graph cache.

### Versioned graph identity

Flopeek has a project identity and a monotonic static graph-state identity. `projectId` identifies the local project; `state.graphVersion` identifies its material static graph state. `generatedAt` remains scan timing only. A retained adjacent delta can explain one version advance. `getChangedContexts` exposes bounded current or historical technical contexts from that adjacent delta, while Context reference continuity across refactors remains limited to the explicit resolver states.

### Context Cards and path-based identity

Raw node Context Cards identify `{ projectId, nodeId, graphVersion }`; flow Context Cards identify `{ projectId, flowId, graphVersion }`. Both use local `fp://local/...` references and bounded static evidence. Node refs resolve as current, stale, historical, successor-candidate, or unresolved. Flow refs resolve as current, stale, historical, or unresolved; they never infer successor continuity. Neither kind creates a durable full historical card or silently maps removed evidence to a successor.

Current IDs are excellent deterministic current-state keys but insufficient as long-term Context references across refactors.

Repository-local reviewer skills are a development and validation layer, not part of the scanner graph. `AGENTS.md` routes explicitly requested reviews to role-specific skills under `.agents/skills/`; `docs/schemas/flopeek-independent-review.schema.json` defines their portable output. These artifacts record provider/model/run provenance and current graph identity but remain advisory evidence. They cannot modify parser facts, establish provider independence by persona name, or create human verification.

### Full graph JSON rewrite

Each refresh writes the complete graph. This is simple and correct for the current scale, but will become expensive for large version histories and delivery records.

### Product schema ahead of implementation

Deterministic HTTP/request semantic suggestions and the local `flopeek-delivery-work-records/v1` store now have current runtime schemas. Delivery storage currently supports editable plan metadata and append-only actual events; workflow methods, transition gates, and user-facing delivery surfaces remain product commitments until their own contracts are implemented. Node and flow Context Cards/packets are implemented by ADR-003; immutable flow verification is implemented by ADR-004 and never modifies parser facts. `flopeek-changed-contexts/v1` is an ephemeral service projection of retained adjacent-delta evidence, not a historical Context Card reconstruction. `flopeek-flow-comparison/v1` is a retained bounded snapshot comparison for captured adjacent-delta flows, not full graph history or runtime reconstruction.

## Target architecture

Status: `target`

### Target module boundaries

```text
src/
├── core/
│   ├── project-identity.js
│   ├── graph-schema.js
│   ├── graph-builder.js
│   ├── graph-store.js
│   ├── evidence.js
│   └── diagnostics.js
├── discovery/
│   ├── files.js
│   ├── scope.js
│   └── config.js
├── adapters/
│   ├── registry.js
│   ├── javascript-typescript.js
│   ├── svelte.js
│   ├── python.js
│   ├── php.js
│   ├── java.js
│   ├── rust.js
│   ├── go.js
│   └── csharp.js
├── resolvers/
│   ├── relative.js
│   ├── typescript.js
│   ├── bundler.js
│   ├── workspace.js
│   ├── cargo.js
│   └── go-module.js
├── projections/
│   ├── feature-overview.js
│   ├── request-flow.js
│   ├── flow-lens.js
│   ├── dependency.js
│   └── impact.js
├── context/
│   ├── context-card.js
│   ├── context-ref.js
│   ├── verification.js
│   └── continuity.js
├── inference/
│   ├── features.js
│   ├── deterministic.js
│   └── feedback.js
├── delivery/
│   ├── workflow-schema.js
│   ├── workflow-engine.js
│   ├── work-record.js
│   └── evidence-gates.js
├── interfaces/
│   ├── cli.js
│   ├── http.js
│   └── mcp.js
└── integrations/
    ├── git.js
    ├── ci.js
    ├── deployment.js
    └── observability.js
```

This is a target responsibility map, not a requirement to perform one large refactor. Modules should be extracted incrementally behind current tests.

### Adapter contract

Every language/framework adapter should expose structured capability metadata and deterministic facts:

```js
{
  id: "typescript-ast",
  languages: ["js", "jsx", "ts", "tsx"],
  capabilities: {
    structure: "exact",
    imports: "exact-static",
    calls: "direct-identifiers",
    routes: ["express", "fastify", "nestjs", "next"]
  },
  analyze(file, context) {
    return { facts, diagnostics, coverage };
  }
}
```

Adapter metadata should generate [SUPPORT.md](SUPPORT.md) or a machine-readable support artifact, preventing documentation drift.

### Repository scope configuration

Implemented configuration:

```json
{
  "schemaVersion": 1,
  "sourceRoots": ["src", "apps", "packages"],
  "testRoots": ["test", "tests", "__tests__"],
  "fixtureRoots": ["test/fixtures", "tests/fixtures", "__fixtures__"],
  "exclude": ["examples/generated/**"],
  "flowEntries": {
    "tests": false,
    "fixtures": false
  }
}
```

When configuration is absent, Flopeek uses the same test and fixture defaults shown above with unrestricted application roots. Generated directories (`generated`, `__generated__`) and `.generated.` files remain diagnostic-only. `exclude` supports literal repository-relative paths and whole-segment `*`/`**` patterns. The effective rules, counts, precedence, policy, and limits are recorded at `analysis.repositoryScope`; viewer/API/MCP projections carry the same metadata.

### Graph identity

Target graph envelope:

```json
{
  "schemaVersion": 5,
  "project": {
    "projectId": "project:81a4...",
    "root": "absolute local path",
    "name": "flopeek"
  },
  "state": {
    "graphVersion": 43,
    "generatedAt": "ISO-8601 timestamp",
    "gitRevision": "2df8cb3",
    "workingTreeFingerprint": "sha256:..."
  },
  "analysis": {},
  "stats": {},
  "nodes": [],
  "edges": [],
  "flows": []
}
```

Requirements:

- `schemaVersion` changes only when serialized schema compatibility changes.
- `graphVersion` increases monotonically for a project cache whenever the materialized graph state changes.
- A no-op refresh does not need to create a new material version.
- State writes are atomic.
- MCP and viewer responses include graph identity.
- Old references report `stale`, `historical`, `unresolved`, or `successor-candidate`; they never silently point to unrelated context.

### Project identity

Decision required.

Potential inputs, in priority order:

1. explicit configured project ID;
2. normalized Git remote identity plus repository-relative root;
3. generated local UUID persisted under `.flopeek/`;
4. path-derived temporary identity only for ephemeral scans.

Forks and copied directories must not be silently treated as the same project without policy.

### Context reference

Target syntax:

```text
fp://local/<project-id>/<kind>/<context-id>@<graph-version>
```

Examples:

```text
fp://local/81a4/node/payment-authorize@43
fp://local/81a4/flow/checkout@43
fp://local/81a4/work/partial-payment@57
```

The URI is a local identifier, not a public network URL.

### Context Card schema

```json
{
  "schemaVersion": "flopeek-context/v1",
  "contextRef": "fp://local/project%3A81a4/flow/flow%3Aendpoint%3Acheckout@43",
  "project": { "projectId": "project:81a4", "graphVersion": 43, "sourceRevision": "abc123" },
  "kind": "flow",
  "title": "POST /checkout",
  "knowledgeClass": "derived",
  "confidence": "exact-static-evidence",
  "flow": { "id": "flow:endpoint:checkout", "entryId": "endpoint:checkout" },
  "technicalSummary": { "text": "...", "knowledgeClass": "derived" },
  "projection": { "schemaVersion": "flopeek-flow-lens/v1", "steps": [], "staticBoundaries": [], "truncation": {} },
  "relatedTests": [],
  "limitations": [],
  "verification": null,
  "safeActions": []
}
```

Context actions are navigation or recommendations. They do not grant source-write, shell, deployment, or credential access.

### Delta event schema

```json
{
  "schemaVersion": "flopeek-delta/v1",
  "projectId": "project:81a4",
  "fromGraphVersion": 42,
  "toGraphVersion": 43,
  "reason": "filesystem",
  "changedPaths": ["src/payment.ts"],
  "refresh": {
    "analyzedFiles": 1,
    "reusedFiles": 420,
    "removedFiles": 0
  },
  "nodes": {
    "added": [],
    "removed": [],
    "changed": []
  },
  "edges": {
    "added": [],
    "removed": []
  },
  "affectedContexts": {
    "nodes": [
      { "status": "source-changed", "node": { "id": "function:src/payment.ts:charge", "path": "src/payment.ts" } }
    ],
    "flows": [
      { "status": "affected", "flow": { "id": "flow:endpoint:src/payment.routes.ts:POST:/pay" }, "changedStepIds": ["function:src/payment.ts:charge"] }
    ],
    "truncated": false
  },
  "coverageChanged": false,
  "truncated": false
}
```

Adjacent deltas persist until an explicit dry-run-first history prune. Its default preview retains the newest eight validated deltas within a 16 MiB history budget and always protects the latest adjacent delta; malformed and unknown files are protected. `getChangedContexts` decorates this bounded evidence with current node/flow Context Refs, Flow Lens IDs, availability, changed static step IDs, and comparison availability. A captured affected flow also retains bounded before/current Flow Lens snapshots for `getFlowComparison`. Current flow refs resolve to `flopeek-context/v1` cards; stale refs resolve to the current card with explicit stale status. Removed flows resolve as historical only when an adjacent retained delta proves removal; when the requested version predates retained evidence, resolution is explicitly `expired` rather than a fabricated history. A history prune stages candidates behind a recovery journal and never mutates current graph/state. Durable delivery-history retention remains future work.

### Context continuity

Current deterministic technical IDs remain the source identity for a graph version. ADR-003 adds a narrow same-path/type adjacent-delta successor candidate, but a separate continuity service may compare:

- AST fingerprints;
- path moves;
- caller/callee neighborhoods;
- related tests;
- human verification;
- Git rename evidence.

It emits `possible_successor` with reasons and confidence. Only human approval or exact migration policy establishes verified continuity.

### Three graph domains

The current Delivery Graph foundation and all target continuation services preserve:

```text
Evidence Graph  --projects/supports--> Context Graph
Context Graph   --required/affected--> Delivery Graph
```

Evidence Graph rebuilds from repository facts. Context Graph preserves human verification and derivation. Delivery Graph preserves workflow state and evidence references.

### Current workflow engine

Current versioned workflow definition:

```json
{
  "schemaVersion": "flopeek-workflow/v1",
  "id": "agile-default",
  "states": ["backlog", "planned", "implementing", "verifying", "reviewing", "released", "observing"],
  "transitions": [
    {
      "from": "implementing",
      "to": "verifying",
      "requiredEvidence": ["current-context", "implementation-graph", "change-impact"]
    }
  ]
}
```

Agile, Waterfall, and custom methods are templates over this schema. Workflow state cannot fabricate technical evidence. Actual events must link to Flopeek graph states, Git evidence, declared tests, or permissioned integrations.

### Target work-continuation services

ADR-020 defines the next boundary-preserving layer:

```text
current Git/source basis + graph version + selected Context Refs
  -> immutable local continuation checkpoint
  -> planned technical overlay with distinct Plan Refs
  -> explicit Viewer Continue mode
  -> append-only manual reconciliation
  -> bounded baseline/plan/current comparison
  -> read-only divergence analysis
  -> bounded agent continuation packet
```

Planned entities remain Delivery/Context metadata. They do not enter technical
graph storage or factual traversal. A positive reconciliation points to current
technical Context Refs but still does not rewrite parser evidence. Detailed
schema and surface order live in
[`docs/work-continuation-plan.md`](docs/work-continuation-plan.md).

### Semantic inference service

Status: `partially current` for deterministic HTTP/request suggestions and local feedback capture; model training remains target behavior.

The deterministic inference service consumes graph features and returns suggestions separately from extracted facts:

```json
{
  "schemaVersion": "flopeek-semantic-flow-suggestion/v1",
  "status": "suggested",
  "knowledgeClass": "derived-suggestion",
  "candidate": {
    "title": "Create Payment",
    "technicalPurpose": "Handles the statically detected POST /payments request...",
    "role": "create-request",
    "grouping": { "key": "payments", "label": "Payments" }
  },
  "confidence": { "level": "high", "score": 0.9 },
  "evidenceRefs": [{ "kind": "node-context", "ref": "fp://local/..." }],
  "reasons": [{ "code": "literal-http-entry", "message": "...", "evidenceRefs": ["fp://local/..."] }],
  "abstention": null
}
```

Human decisions over suggestions are versioned local feedback with exact current-suggestion fingerprint and optional same-Context-Ref trace binding. `accepted`, `edited`, `rejected`, and `abstained` are immutable labels, never flow verification. ML training is not introduced until real reviewed data can be split into training and held-out evaluation sets.

`src/semantic-suggestion-reviewed-evaluation.js` evaluates a separately supplied `flopeek-semantic-suggestion-reviewed-dataset/v1` cohort. The schema permits only opaque IDs, split assignment, decision, abstention verdict, and optional trace status; it rejects paths/URLs/free-text identifiers and any privacy declaration that allows source content, prompts, credentials, or raw logs. Its recommendation gate requires 20 held-out cases across three repository aliases and two reviewers, plus usefulness, rejection, abstention, and trace thresholds. The evaluator cannot prove reviewer identity or business correctness; no committed template or synthetic data can pass the gate.

### Target MCP additions

Prefer composable tools:

- `get_flow_projection`;
- `get_context_card`;
- `resolve_context_ref`;
- `get_graph_delta`;
- `get_changed_contexts`;
- `get_work_record`;
- `get_workflow_evidence`.

Do not add separate tools when one typed tool can handle the same concept predictably.

### Target viewer behavior

- Flow Lens is the default humanized view for a selected entry point.
- Raw graph remains an evidence drill-down.
- Live update preserves focus and opens a change tray.
- Changed steps and edges are highlighted against explicit graph versions.
- Context Card can be copied as JSON or Markdown.
- Human verification records are visually distinct from inferred descriptions.
- SDLC timeline separates editable planned blocks from immutable actual evidence events.

### Target cache layout

Initial compatible target:

```text
.flopeek/
├── config.json
├── project.json
├── graph.json
├── state.json
├── descriptions.json
├── contexts/
│   ├── cards.json
│   └── verification.json
├── deltas/
│   └── <from>-<to>.json
├── delivery/
│   ├── workflows.json
│   ├── work-records.json
│   ├── continuation-checkpoints.json
│   ├── planned-overlays.json
│   └── reconciliations.json
└── history/
    └── <full-git-sha>.json
```

This layout is a migration step, not a permanent commitment to many JSON files. A storage abstraction must allow a later embedded database without changing CLI/MCP contracts.

### Atomic persistence

All mutable cache writes must use:

```text
serialize and validate
  -> write temporary file in same directory
  -> flush/close
  -> atomic rename over destination
  -> preserve or recover previous valid state on failure
```

Schema migration must never modify target source files and must preserve a backup until the migrated cache validates.

### Target test architecture

```text
test:unit
  Fast pure schema, identity, scoring, and utility tests.

test:contracts
  Graph, Context Card, delta, HTTP, and MCP schemas.

test:adapters
  Language/framework fixtures and toolchain-conditioned behavior.

test:viewer
  Local server, SSE, focus preservation, and browser interaction.

test:integration
  End-to-end CLI/MCP/cache/history scenarios.

test:real-corpus
  Pinned audited repository scopes, scheduled or explicit.
```

Pull requests should receive a fast deterministic lane first. Slow toolchain and corpus gates remain visible but separate.

## Security and trust boundaries

### Current guarantees

- Viewer server binds to loopback.
- Each MCP stdio session and scanner backend uses one configured repository; the optional web hub only routes among isolated backends.
- Repository source files are not modified by Flopeek scan/MCP operations; explicit metadata operations may atomically update `.flopeek/` stores.
- Git snapshots do not check out target revisions.
- Repository configuration is interpreted only through documented static subsets.

### Required future guarantees

- Validate every cache and integration payload against a versioned schema.
- Do not embed credentials or source contents in Context Packets.
- Keep external enrichment opt-in.
- Scope integration permissions by repository, environment, operation, duration, and work record.
- Require explicit approval for external writes or executions.
- Record integration evidence without private agent reasoning.
- Treat repository source and documentation as untrusted input for any future model or renderer.

## Performance model

Performance must be measured separately for:

- discovery;
- changed-file parsing;
- resolver invalidation;
- graph relationship rebuild;
- projection generation;
- cache persistence;
- viewer response size;
- MCP context size.

Do not report incremental parser speed as total end-to-end live-update latency. Large-repository targets should be stated against pinned repositories, machine metadata, raw samples, and configured source scope.

## Migration sequence

1. Add repository scope configuration and prevent fixture flow leakage.
2. Extract graph schema/validation and atomic cache persistence.
3. Add project identity, monotonic graph versions, and versioned adjacent deltas.
4. Introduce Context Card/ref services without changing current scanner behavior.
5. Add stale Context Card resolution and changed-context projections.
6. Add Flow Lens evidence-rich projections.
7. Modularize scanner adapters and generate support metadata.
8. Add deterministic semantic inference and feedback capture.
9. Add Delivery Graph and generic workflow engine (current foundation).
10. Expose planned overlays and Plan Refs through CLI, HTTP, MCP, and an explicit opt-in Viewer Continue mode with exact non-redirecting resolution, append-only manual reconciliation, deterministic bounded comparison, read-only divergence, and a bounded agent continuation packet (current).
11. Complete cross-surface dogfooding and stabilization.
12. Preserve the JavaScript core as the dogfooding and compatibility oracle while a native core matches the pinned static-fact contract.
13. Follow [ADR-024](docs/adr/ADR-024-native-core-strangler-contract.md): keep public JavaScript IDs and Context Ref semantics authoritative, move one bounded responsibility through shadow parity at a time, and promote SQLite only through a complete validated transaction.
14. Evaluate additional storage backend changes and permissioned integrations only after the native-core promotion gates are measured.

## Architecture invariants

The following must remain true through every migration:

1. Unsupported behavior is not invented.
2. Extracted evidence is immutable within a graph version.
3. Human verification is not overwritten by a scan.
4. Workflow state cannot change source evidence.
5. A stale Context reference is reported, not silently redirected.
6. Viewer and MCP can identify the same graph state.
7. Source analysis remains read-only and local by default.
8. Aggregate views remain distinguishable from raw nodes.
9. Tests and fixtures do not become application flows by default once scope configuration ships.
10. Every new adapter documents and tests its exact capability boundary.

## Required architecture decisions

Create ADRs before stabilizing:

- ADR-001: project identity and fork/copy behavior;
- ADR-002: graph version and no-op refresh semantics;
- ADR-003: local node Context reference syntax and conservative continuity candidates;
- ADR-004: cache atomicity, migrations, and retention;
- ADR-005: adapter contract and generated capability metadata;
- ADR-006: Evidence/Context/Delivery Graph separation;
- ADR-007: workflow permission and integration boundary;
- ADR-008: optional model privacy and approval boundary;
- ADR-009: public packaging, licensing, and release channel.

Later accepted decisions refine that sequence, including ADR-019 for the current
evidence-gated local Delivery Graph/workflow foundation and ADR-020 for the
target versioned work-continuation boundary.
