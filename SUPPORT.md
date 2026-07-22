# Flowpeek support matrix

> **Open this when a flow looks incomplete.** `parsed` means Flowpeek extracted declared structural facts; it never means the path executed or the business behavior is verified.

## Document authority

This document is the canonical human-readable statement of **what Flowpeek currently analyzes and what each result means**.

It describes current implementation, not roadmap intent. Planned behavior belongs in [ROADMAP.md](ROADMAP.md). Product trust rules belong in [PRODUCT.md](PRODUCT.md).

<!-- GENERATED:ADAPTER-CAPABILITIES:START -->

## Generated adapter capability registry

Registry schema: `flowpeek-adapter-capabilities/v1`. This table is generated from `src/adapter-registry.js`; repository parse coverage remains separate in graph analysis.

| Adapter | Languages/extensions | Parser | Availability | Structure | Imports | Direct calls | Required toolchain |
| --- | --- | --- | --- | --- | --- | --- | --- |
| csharp | csharp / .cs | csharp-roslyn | toolchain-conditional | exact-static | exact-static | unsupported | .NET SDK with Roslyn assemblies |
| go | go / .go | go-parser | toolchain-conditional | exact-static | exact-static | supported-subset | Go toolchain |
| inventory | astro, c, cpp, headers, kotlin, ruby, scala, shell, swift, vue / .astro .bash .c .cc .cpp .cxx .h .kt .kts .rb .scala .sh .swift .vue .zsh | inventory | inventory-only | inventory-only | unsupported | unsupported | None |
| java | java / .java | tree-sitter-java | bundled | exact-static | exact-static | supported-subset | None |
| php | php / .php | php-parser | bundled | exact-static | exact-static | supported-subset | None |
| python | python / .py | python-lezer | bundled | exact-static | supported-subset | supported-subset | None |
| rust | rust / .rs | tree-sitter-rust | bundled | exact-static | supported-subset | supported-subset | None |
| svelte | svelte / .svelte | svelte-compiler | bundled | exact-static | supported-subset | supported-subset | None |
| typescript | javascript, jsx, tsx, typescript / .cjs .js .jsx .mjs .ts .tsx | typescript-ast | bundled | exact-static | exact-static | supported-subset | None |

The registry describes proven static parser capabilities, not runtime execution, relationship recall outside audited slices, dynamic dispatch, dependency injection, reflection, or target configuration execution.

<!-- GENERATED:ADAPTER-CAPABILITIES:END -->

## Capability levels

| Level | Meaning |
| --- | --- |
| `exact-static` | Deterministically extracted or resolved from the supported static syntax/configuration subset. |
| `likely-static` | Statically detected, but framework/runtime identity is not fully proven. |
| `structure-only` | Declarations/import-like structure may be extracted; meaningful call/runtime flow is not. |
| `inventory-only` | File is known and classified, but no structural parser facts are produced. |
| `toolchain-conditional` | Capability exists only when a documented local toolchain is available. |
| `unsupported` | Flowpeek deliberately emits no relationship for this behavior. |

`exact-static` does not mean runtime-observed. It means exact within the documented static pattern.

## General source policy

Flowpeek:

- reads files no larger than 1 MB;
- ignores known generated/vendor directories such as `.git`, `.flowpeek`, `node_modules`, `dist`, `build`, `coverage`, `target`, and `vendor`;
- ignores hidden directories by default;
- parses source without executing the target application;
- records inventory-only status instead of inventing relationships;
- exposes coverage and diagnostics through graph analysis, the local viewer, and MCP agent context.

Repository scope is configured by an optional versioned `.flowpeek/config.json`. It supports source, test, fixture, and excluded roots plus explicit test/fixture flow-entry policy. Without configuration, deterministic defaults recognize `test`, `tests`, `__tests__`, `test/fixtures`, `tests/fixtures`, and `__fixtures__`; generated paths remain diagnostic-only.

## Language matrix

| Language/files | Parser | Structure | Imports/modules | Direct calls | Framework/runtime facts | Important limits |
| --- | --- | --- | --- | --- | --- | --- |
| JavaScript, JSX, CommonJS | TypeScript compiler AST | `exact-static` top-level functions/classes | Static ES imports and literal CommonJS require | Direct unshadowed local identifiers and supported named imports | Express/Fastify patterns; static runtime integrations | Dynamic require/import, callbacks, method dispatch, namespace/default-import calls unsupported. |
| TypeScript, TSX | TypeScript compiler AST | `exact-static` top-level functions/classes | Static imports plus supported TS/project aliases | Direct unshadowed local identifiers and supported named imports | Express, Fastify, NestJS, Next.js, Prisma, TypeORM, Drizzle, BullMQ, and narrow `node-cron` subsets | Decorator/config values must match supported static patterns; dynamic DI and method dispatch unsupported. |
| Svelte | Svelte compiler AST plus JS/TS handling | `exact-static` component/script facts | Supported script imports | Same supported JS/TS direct-call subset inside analyzed script | SvelteKit file-system routes | Reactive/runtime component behavior and dynamic dispatch are not traced. |
| Python | Lezer syntax tree | `exact-static` functions/classes | Internal relative/package and supported named imports | Direct local and supported named-import identifier calls | Literal HTTP decorators; Flask/Blueprint static `route` method lists | Decorator endpoints may be `likely-static`; attribute/method calls and dynamic dispatch unsupported. |
| PHP | Bundled `php-parser` AST | `exact-static` classes/interfaces/traits/enums/functions/methods | Static `use` facts | Direct local function identifiers | No framework-container resolution | Composer autoloading, dynamic include, method/static dispatch, and container calls unsupported. |
| Java | Bundled Tree-sitter grammar | `exact-static` classes/interfaces/enums/records/methods | Static import facts | Unique unqualified local static method calls | No framework wiring | Instance, qualified, overloaded, reflection, and DI/container dispatch unsupported. |
| Rust | Bundled Tree-sitter grammar | `exact-static` structs/enums/traits/unions/impl methods/functions | Static `use`; conventional `crate`/`self`/`super` modules | Direct local and supported named-import functions | Conventional Cargo `src/` module resolution | Macros, traits, function values, qualified module calls, custom targets, and `#[path]` unsupported. |
| Go | Official Go parser through local helper | `toolchain-conditional`, otherwise inventory-only | Static imports and local module packages | Unshadowed local functions and unique resolved package selectors | `go.mod` local module resolution | Requires local Go; build tags, function values, method dispatch, ambiguous package functions, and name mismatches unsupported. |
| C# | Roslyn through local helper | `toolchain-conditional` classes/interfaces/methods | `using` facts | `unsupported` | No framework facts | Requires local .NET SDK; call graph and runtime dispatch are not implemented. |
| Vue, Astro | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | File remains visible only as inventory. |
| C, C++, headers | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | Preprocessor/build semantics are not analyzed. |
| Ruby | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | No Ruby AST adapter. |
| Kotlin/Kotlin script | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | No Kotlin compiler/AST adapter. |
| Swift | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | No Swift AST adapter. |
| Scala | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | No Scala AST adapter. |
| Shell (`sh`, `bash`, `zsh`) | No registered structural adapter | `inventory-only` | `unsupported` | `unsupported` | `unsupported` | Shell execution and expansion are never evaluated. |

## JavaScript and TypeScript module resolution

### Current supported resolution

- relative paths;
- recognized JS/TS/Svelte/JSON extensions and index files;
- SvelteKit `$lib`;
- `@/` source-root convention;
- nearest `tsconfig`/`jsconfig` `baseUrl` and `paths`;
- inherited `extends` settings in supported static configs;
- literal and safe static Vite/Webpack aliases from exported configuration objects;
- `package.json#imports` literal and single-wildcard entries;
- declared npm workspaces;
- static pnpm workspace block/inline package lists with `!` exclusions;
- in-repository Yarn `.pnp.data.json` package locations;
- literal or single-wildcard package exports;
- supported static `import`, `node`, `default`, `require`, and `types` condition trees.

### Current unsupported resolution

- arbitrary computed aliases;
- executable `.pnp.cjs` discovery;
- unsupported pnpm YAML constructs;
- custom package conditions;
- runtime plugin resolution;
- non-literal dynamic imports or require;
- configuration that requires executing repository code.

Flowpeek must not execute Vite, Webpack, package-manager, or application configuration merely to improve a static edge.

## Framework and integration matrix

| Framework/integration | Current support | Confidence boundary |
| --- | --- | --- |
| Express-style routes | Static handler patterns | Exact only for recognized literal/static registration form. |
| Fastify | Factory and recognized static route registration patterns | Exact within recognized form. |
| NestJS | Literal `@Controller` and HTTP-method decorators | Exact for supported literal decorator values; DI dispatch remains unsupported. |
| Next.js App Router | File-system `route` handlers, static fetch request facts, exact HTTP-handler binding, and narrow inline request/response literal contracts | Contract fields are exact only for one handler's inline request type literal and returned literal `Response.json`/`NextResponse.json` with explicit numeric status; dynamic values, type references, spreads, and unsupported forms remain unavailable. |
| SvelteKit | File-system page/layout/server route classification | Exact path convention; runtime hooks/dispatch not traced. |
| Python HTTP decorators | Literal recognized decorator methods | Often `likely-static` when framework instance identity is not proven. |
| Flask/Blueprint | Literal `route` and static method list | `likely-static`; dynamic method/config unsupported. |
| Django management commands | Non-private `management/commands/<name>.py`, one top-level `Command` class directly extending imported `django.core.management.base.BaseCommand`, and one direct `handle` method | Exact syntax subset only; settings/app registration, indirect bases, command invocation, and execution are unsupported. |
| Prisma | Statically imported client construction and recognized operations | Exact static instance/operation subset. |
| TypeORM | Statically imported DataSource/connection patterns and recognized operations | Exact static subset; repository method dispatch is incomplete. |
| Drizzle | Statically imported factory and recognized operations | Exact static subset. |
| BullMQ | Statically imported Queue/Worker/FlowProducer construction and recognized operations | Exact static instance subset; runtime processors/callback behavior not traced. |
| node-cron | Module-scope default-import `cron.schedule()` with a safe literal five/six-field cron expression and one unshadowed local top-level function identifier | Exact syntax subset only; scheduler initialization, non-module registration, callback/inline task, imported task, dynamic expression, named/namespace/CommonJS import, and other scheduler APIs are unsupported. |

## Relationship matrix

| Relationship | Current availability | Interpretation |
| --- | --- | --- |
| `declares` / `contains` | Registered structural adapters | Source containment fact. |
| `imports` / `uses` | Adapter- and resolver-specific | Static module relationship. |
| `calls` | Supported direct-identifier subsets | Static direct call, not full language call graph. |
| endpoint-to-handler | Supported framework patterns | Static registration/file convention. |
| `declares-command-target` | Literal `package.json` direct runner + one scanned source-file target, or narrow Django command declaration + exact `Command` class | Static declaration; not shell invocation, Django registration, or execution proof. |
| data/queue use | Supported JS/TS runtime integrations | Recognized static instance and operation. |
| request/fetch | Supported static request patterns | Static target when literal/resolvable. |
| test relationship | Direct stored graph relationships | Missing relationship does not prove missing behavioral coverage. |
| impact | Traversal of stored edges | Static potential impact, not runtime blast radius. |
| flow | Bounded traversal from an extracted HTTP/request endpoint, supported literal package script, narrow Django management-command declaration, or narrow literal node-cron schedule registration | Technical projection, not command invocation, Django registration, scheduler initialization/task execution, runtime sequence, or business process. Route/controller nodes and unsupported forms remain technical-map nodes or machine-readable unsupported inventory. |

## Analysis layers

Nodes are classified into layers used by the viewer and agent context:

- `application` — project code considered part of the application map;
- `test` — recognized test files;
- `runtime` — runtime integration/dependency nodes;
- `framework` — framework internals/dependencies;
- `devtool` — configuration, build, lint, and development tooling;
- inventory/other — known files or dependencies outside focused application views.

Source scope precedence is `excluded`, `fixture`, `test`, `generated`, then `application`. Test, fixture, and generated nodes remain available for direct relationships, impact evidence, and diagnostic/all views. Application HTTP endpoints, supported literal package-script declarations, narrow Django management-command declarations, and supported literal node-cron schedule registrations are default flow entries; test and fixture entries need explicit `flowEntries` opt-in. Scope is path-based and does not execute repository configuration.

## Flow support

### Current

- Entry points: extracted HTTP/request endpoints; literal `package.json` scripts with exactly one supported runner and one repository-local scanned source-file target; non-private Django `management/commands/<name>.py` modules with one top-level `Command` class directly extending imported `BaseCommand` plus one direct `handle` method; and module-scope default-import `node-cron` `schedule()` calls with a safe literal five/six-field cron expression and one exact local top-level function target. Route/controller nodes plus unsupported forms remain available through overview, search, and direct dependencies or the machine-readable unsupported-entry inventory.
- Unsupported package-script inventory retains only manifest path, script name, classification reason, and a safe target path when one was resolved; it never retains raw shell command text.
- Unsupported Django-command inventory retains only source path, command name, and classification reason; it never executes settings, imports, or the command.
- Unsupported node-cron inventory retains only source path and classification reason; it never retains a raw unsupported schedule expression or callback body.
- Traversal: outgoing stored static graph edges.
- Bounds: no silent entry-count cap, 24 steps per flow, depth 6. A future paginated surface must expose returned and omitted entry IDs.
- Default entries: application HTTP endpoints, supported literal package scripts, narrow Django management commands, and supported literal node-cron schedules; test and fixture entries require explicit policy.
- Test, fixture, and generated steps: omitted from default application flows.
- Output: node ID, label, type, and depth.
- Flow Lens: a separate `flowpeek-flow-lens/v1` projection for one supported static entry. HTTP/request entries retain their handler evidence. A literal package script begins with an exact `declares-command-target` edge and exposes manifest, script, runner, and target declaration fields. A narrow Django command begins with the same edge and exposes adapter, command name, and `Command` target declaration fields. A literal node-cron schedule begins with an exact `schedules` edge and exposes adapter, expression, local task name, and target declaration fields. It defaults to 12 displayed steps and accepts a strict integer limit from 1 through 24, with derived technical role, per-step Context Ref, deterministic parser-edge evidence reference, bounded fan-out, supported static database/queue/external boundaries, and explicit truncation/ambiguity.
- Flow Context Card: a `flowpeek-context/v1` card with `kind: flow`, a versioned local flow ref, the same requested bounded Flow Lens projection, direct related-test evidence, JSON/Markdown packets, and explicit limits. Viewer, HTTP, and MCP reject invalid limits rather than silently clamping them.
- Semantic flow suggestion: `flowpeek-semantic-flow-suggestion/v1` deterministically proposes a title, technical purpose, request role, and route grouping only from literal HTTP entry, step roles, direct transition evidence, and static boundaries. Literal package scripts, narrow Django commands, and literal node-cron schedules explicitly abstain; Flowpeek does not infer their purpose from a name or expression. Every result includes evidence, confidence, reasons, and either `suggested` or explicit `abstained` status.
- Semantic suggestion feedback: `flowpeek-semantic-suggestion-feedback/v1` appends accepted, edited, rejected, or abstained human labels for one exact suggestion snapshot. It may link an agent trace only when both records carry the same Context Ref; it never verifies the flow or evaluates business correctness.
- Flow verification: immutable local human verification records with current, compatible, stale, detached, indeterminate, unverified, or unavailable resolution. Verification is separate from parser facts and is not proof of a business process.

### Not current

- general command, CLI, framework-command, queue, scheduler, or event entry discovery; only the narrow literal package-script, Django declaration, and node-cron scheduler contracts above are current;
- control-flow branches or exception paths;
- runtime order, frequency, or timing;
- control-flow condition or business-process meaning;
- side-effect success, ownership, or external behavior;
- verified business process.

## Search support

Current `find_nodes` and viewer search perform case-normalized plain-text matching over:

- label;
- path;
- feature;
- domain;
- node type.

Search does not:

- use regex source-code interpretation;
- search arbitrary source contents;
- perform embeddings or semantic vector search;
- infer business intent.

This is deliberate: source structure comes from parser facts. Current semantic flow suggestions are a separate deterministic, confidence-labelled derived layer and do not perform source-content search or infer business intent.

## Incremental support

### Current

- persistent in-process file facts;
- file size and mtime fingerprint;
- changed-file reparse;
- unchanged fact reuse;
- resolver-cache invalidation for relevant topology/config changes;
- graph-wide relationship rebuild;
- directory/metadata-free reconciliation fallback;
- SSE notification to an open viewer.
- durable monotonic graph versions and bounded persisted adjacent deltas.

### Limits

- watcher reliability depends on OS filesystem events;
- manual scan remains the reconciliation fallback;
- current graph JSON is fully rewritten;
- only the 40 newest adjacent deltas are retained; older or non-adjacent history is unavailable unless Git snapshots exist;
- a versioned delta is static evidence, not runtime or source-diff proof;
- node IDs remain path/symbol based and can change after moves or renames.

## Repository discovery and bounded scan support

### Current

- `flowpeek discover` reports recognized candidate source, bytes, scope counts,
  static workspace/build manifests, package names, adapter demand, diagnostics,
  and an opaque source/resolver-control inventory fingerprint without parsing
  source.
- `--package <relative/path>` selects one existing non-symbolic-link directory
  containing a regular `package.json`. It limits discovery and bounded analysis
  to that static source subtree while retaining root and ancestor resolver
  controls in the immutable plan. It still intersects the repository-owned
  source/test/fixture/exclude scope rather than overriding it. The selected path is shown in discovery,
  scan status, Viewer, HTTP/SSE progress, MCP bootstrap, and agent context.
- A package-scoped graph uses a process-local session identity and never reads
  from or replaces the repository-wide graph cache, even when `--no-cache` was
  not supplied. This prevents a selected subtree from being presented later as
  the full repository map.
- `--budget-ms`, `--max-files`, and `--max-bytes` can block a full scan before
  analysis; a bounded discovery exits with code `2` and writes no Flowpeek state.
- the same limits on `flowpeek scan` use the exact discovered file plan, run
  analysis in a worker, verify the same immutable plan after analysis, and allow
  cache promotion only for a complete matching result. Verification re-reads
  planned directories and source/resolver-control candidates; it does not repeat
  workspace, adapter, manifest, scope-report, or bound discovery.
- local `serve` and `mcp` instances accept the same bounds and expose one
  `flowpeek-scan-outcome/v1` status across Viewer, HTTP/SSE, and MCP.
- an incomplete bounded refresh retains the last complete graph as
  `stale-unverified`; it never activates or promotes a partial graph.
- active bounded cancellation uses the same terminal outcome in HTTP/SSE and
  MCP; a cancellation retains the last complete graph as `stale-unverified`.
- a filesystem event observed during manual bounded analysis is queued for a
  later reconciliation; a discarded source plan never becomes a partial graph.
- a candidate repository switch remains isolated from the active graph and SSE
  stream until accepted; the Viewer keeps the active map explicit while that
  candidate is checked and does not offer cancellation for the isolated check.
- cache-disabled sessions use a process-local identity, monotonic in-session
  graph versions, and non-durable adjacent delta evidence. They never read a
  persisted delta belonging to a durable project or another session.
- bounded, cancelled, invalidated, and failed results contain no partial graph.

### Limits

- the time budget covers the Flowpeek host operation but cross-platform cleanup
  of optional Go/.NET helper child processes after worker termination is not
  yet proven;
- bounded scans still re-read every planned directory and source/control
  candidate for mutation detection; this avoids a second broad discovery report
  but is not a zero-I/O verification step;
- the shared-plan fingerprint records path, size, and modification-time metadata,
  not source content. An adversarial rewrite preserving both size and timestamp
  is outside this mutation detector's evidence boundary;
- bounded server/MCP refresh performs a full planned analysis rather than
  reusing parser facts; unbounded in-process refresh remains incremental;
- a global workspace hub restores projects without persisting per-session scan
  bounds; each backend still exposes its own scan outcome;
- static manifest presence is inventory evidence, not proof that a workspace,
  package, module, or runtime integration is active;
- package selection is a literal local path boundary, not workspace-package
  discovery, dependency ownership, build activation, or runtime topology;
- package-scoped `serve` and `mcp` are per-project sessions only. They cannot
  join the global workspace hub yet;
- cache-disabled Context Ref freshness is valid only inside one scanner session;
  independent sessions intentionally have different project identities.

## Git history support

### Current

- resolve a requested Git ref;
- create static graph from `git archive` in temporary storage;
- persist snapshot under `.flowpeek/history/<full-sha>.json`;
- compare node/edge topology and static flows;
- include changed Git paths.
- resolve a current or stale Context Ref to its current repository-relative paths;
- list a bounded set of local commits reachable from the current attached branch
  `HEAD` that touched each such path, without source checkout or ref mutation.
- resolve one current or stale Context Ref against two selected static Git
  snapshots; report exact static identity presence separately from bounded
  same-path node candidates.

### Limits

- uncommitted working-tree changes are excluded;
- unreachable or missing history cannot be recovered;
- rewritten/squashed/imported history may omit original intent;
- snapshot comparison is not a source semantic diff;
- historical rationale requires external evidence and remains planned.
- active-branch path history does not follow rename or move history, and a
  listed commit does not prove a symbol introduction, original rationale,
  runtime behavior, review, test success, or release state;
- detached `HEAD`, non-Git directories, missing Context Card paths, and
  unresolved/historical Context Refs return unavailable rather than guessed
  evidence.
- Git Context continuity does not reconstruct a historical Context Card, follow
  renames, infer a successor, or treat a same-path candidate as an
  implementation/semantic/rationale/runtime match.

## MCP support

| Tool | Current guarantee | Important limit |
| --- | --- | --- |
| `get_agent_bootstrap` | Provider-independent graph identity, readiness, parser coverage, safe tool sequence, and evidence policy | Does not read source bodies, execute the target, grant source-write authority, or make runtime/business claims. |
| `get_scan_status` | Shared scan status, declared bounds, active complete-graph source, freshness, and cache-promotion outcome | A `stale-unverified` graph is the last complete baseline, not current-source evidence or a partial reconstruction. |
| `cancel_scan` | Idempotently request cancellation of the active bounded scan without changing source or promoting incomplete evidence | Cannot interrupt the unbounded synchronous scanner and cannot cancel a scan that is not running. |
| `get_agent_context` | Parser coverage, interpretation rules, projection meaning, and bounded deterministic semantic suggestions | Suggestions do not provide verified business intent. |
| `get_agent_evidence_traces` | Bounded agent-declared action records filtered by Context Ref or operation ID | Not private reasoning, human verification, source diff, command output, or runtime proof. |
| `record_agent_evidence_trace` | Idempotently append Context Ref, graph versions, declared action, repository-relative changed paths, and verification outcome to local metadata | Writes only `.flowpeek/agent-evidence-traces.json`; cannot write source or human verification. |
| `get_semantic_suggestion_feedback` | Current immutable feedback resolution and history for one deterministic Flow Lens suggestion | Not model calibration, human verification, business-purpose truth, or a source read. |
| `record_semantic_suggestion_feedback` | Idempotently append accepted, edited, rejected, or abstained feedback for the server-calculated suggestion | Writes only `.flowpeek/semantic-suggestion-feedback.json`; cannot write source or human verification. |
| `get_project_overview` | Small aggregate technical map | Aggregate nodes are not source entities. |
| `find_nodes` | Deterministic metadata lookup | No source/semantic search. |
| `get_node` | Raw node, direct evidence, human description | Current ID may become stale after rename/move. |
| `get_direct_dependencies` | Immediate graph neighborhood | Not full runtime dependency graph. |
| `get_entry_flows` | Supported bounded static entry traversals | Current families are HTTP/request, literal package scripts with one direct scanned source target, and narrow node-cron schedules with one exact local function target; not command invocation, scheduler execution, business, or runtime flow. |
| `get_request_flows` | Compatibility alias for `get_entry_flows` | New integrations use `get_entry_flows`; neither tool proves command invocation, scheduler execution, runtime order, or business behavior. |
| `get_flow_projection` | Bounded Flow Lens with entry contract, roles, parser-edge evidence, boundaries, branches, limits, deterministic semantic suggestion or abstention, and optional integer `maxSteps` from 1 through 24 | Derived static projection, not command execution, runtime/control-flow/business proof. Semantic wording currently abstains outside literal HTTP entries. |
| `get_flow_context_card` | Bounded current supported-entry Flow Context Packet as JSON or Markdown with the same optional `maxSteps` contract | Static selected evidence only; no source body, command execution, runtime history, business rationale, or verified-card lifecycle. |
| `get_change_impact` | Static dependents/dependencies, endpoints, tests | Potential impact only. |
| `get_related_tests` | Directly connected test nodes | Missing result does not prove missing tests. |
| `get_context_card` | Bounded raw-node Context Packet as JSON or Markdown | Static parser evidence only; no source-file body, runtime proof, or verified-card lifecycle. |
| `resolve_context_ref` | Current/stale/historical/unresolved node or flow ref state, plus conservative node-only successor candidates | Historical state relies only on retained adjacent deltas; candidates are never auto-redirected and flow successors are not inferred. |
| `get_active_branch_git_evidence` | Bounded read-only local commits reachable from the current attached branch that touched the current paths in a current/stale Context Card | Path-touch evidence only; no rename-following, source body, author identity, original-rationale claim, runtime proof, checkout, fetch, or ref mutation. |
| `get_git_context_continuity` | Exact static node/flow identity and bounded same-path candidates for a current/stale Context Ref across two selected Git snapshots | Snapshot-only; no historical card reconstruction, rename/successor inference, semantic equivalence, runtime proof, source body, checkout, fetch, or ref mutation. |
| `create_git_snapshot` | Static graph for a commit | No checkout and no runtime behavior. |
| `compare_git_snapshots` | Static topology/flow comparison | No uncommitted source changes. |
| `get_graph_delta` | Read the current-session or matching durable-project adjacent delta by version or current latest version | Bounded to adjacent versions; cache-disabled sessions expose only their in-memory adjacent delta and never read a durable delta from another identity. |
| `get_changed_contexts` | Bounded current/historical technical nodes and Flow Lens entries affected by one retained adjacent delta | Static delta evidence only; a historical item is not a reconstructed Context Card. |
| `get_flow_comparison` | Retained bounded before/current Flow Lens snapshots for one captured affected flow | Adjacent static snapshot comparison only; no source contents, full history, or runtime behavior. |
| `refresh_graph` | Reconcile graph, return the shared scan outcome, and retain an adjacent delta for a complete refresh | Static delta only; cache-enabled refreshes persist it, while cache-disabled sessions retain it only in memory. Agent must pass changed paths when known. A non-complete bounded refresh retains the last complete graph as `stale-unverified`. |

MCP currently exposes no source write, file content, shell, deployment, credential, or production operation. Agent-facing mutations are limited to schema-bounded local metadata appends and cancellation of an active bounded Flowpeek scan.

## Agent host integration support

| Host | Project-local skill | Project-local MCP config | Status |
| --- | --- | --- | --- |
| Codex | `.agents/skills/flowpeek` | `.codex/config.toml` managed block | Supported |
| Claude Code | `.claude/skills/flowpeek` | `.mcp.json` | Supported |
| Cursor | `.cursor/skills/flowpeek` | `.cursor/mcp.json` | Supported |
| Gemini CLI | `.gemini/skills/flowpeek` | `.gemini/settings.json` | Supported |
| ChatGPT web | Not installed | Local stdio unavailable | Remote-only; unsupported by the project-local installer |

`flowpeek install`, `uninstall`, and `doctor` do not start an AI provider. Auto-detection only inspects PATH. Explicit platform selection can prepare a supported host before its executable is installed; doctor then reports the missing executable as a warning. Existing different Flowpeek entries, modified skills, incomplete managed markers, and malformed JSON are conflicts and are never overwritten or removed.

## Package and clean-room support

- Node.js 20 and later is the declared runtime. CI is configured for Node 20 and 22; a configured job is not evidence of a passing remote run until the check completes.
- `flowpeek --version`, `flowpeek version`, and `flowpeek -v` return the installed package version without scanning a repository.
- `npm run audit:package` validates the npm dry-run inventory against `packaging/package-policy.json`.
- `npm run verify:clean-room` packs and installs the exact tarball into a temporary private consumer with lifecycle scripts disabled, then exercises the local binary, help, doctor, one copied-fixture static scan, and MCP bootstrap.
- The current package remains `private: true`. No npm publication, license approval, package-name availability, alpha/beta/stable classification, upgrade path, or universal operating-system result is supported by this iteration.
- Clean-room scan and MCP startup may write Flowpeek cache metadata only inside the disposable fixture copy. They do not execute the target application or its tests and must leave non-cache fixture content unchanged.

## Public repository export support

- The checked-out Flowpeek repository remains the private development source of truth.
- `npm run audit:public-repository` validates the allowlisted public source-tree projection without copying or publishing it.
- `npm run export:public-repository -- --output <new-directory>` requires a clean committed source, copies only tracked approved files, and creates no `.git` directory or network operation.
- `.agents`, `.agent-team`, `AGENTS.md`, private Git history, cache, credentials, logs, and keys are excluded.
- Approved public `.github` workflows and the portable `.flowpeek/config.json` dogfooding scope are retained. The npm package still excludes both repository metadata directories.
- Structural safety is separate from release readiness. The current public release remains blocked by the missing license, active package-private boundary, and absent owner approval.

## Viewer support

### Current views

- Bounded Domain, Feature, Component, and Symbol projections. Each deeper
  projection retains the selected ancestor in its derived hierarchy id; summary
  nodes remain derived static aggregates rather than source files or runtime
  services.
- Feature overview.
- Entry map (legacy `requests` API mode): supported HTTP/request, literal package-script, and literal node-cron schedule entry context.
- Direct dependencies.
- Flow Lens from a selected supported static entry, with raw-node drill-down.
- Flow Context Ref and JSON/Markdown packet copy from the open Flow Lens.
- Deterministic semantic suggestion or explicit abstention, with a draft-only action that never saves human verification automatically.
- Node inspector with responsibility, methods, connections, tests, human description, and parser evidence.
- Raw-node Context Card copy and pasted Context Ref resolution.
- Persistent graph-version badge and bounded live change tray, including affected technical nodes/flows, changed current Flow Lens steps, captured before/current Flow Lens comparison, and server-side refresh-to-context timing.
- Shared scan-freshness badge, bounded phase updates, last-complete `stale-unverified` warning, and an explicit bounded-scan cancellation control.
- Candidate repository-check state that keeps the current map explicit, disables duplicate submission, and discloses that cancellation is unavailable until a switch is accepted.
- Parser coverage summary.
- Live new-file list.
- Benchmark comparison.
- Mermaid export.
- Local Work ledger inspector showing planned work records, linked Context Ref freshness, workflow availability, and append-only delivery-event boundaries. Record creation and workflow changes are available through local HTTP and MCP metadata tools; the Viewer is currently read-only for this ledger.
- Declared dependency readiness is available through local HTTP, MCP, and `flowpeek work dependencies`. It distinguishes ready, blocking, unresolved, and unknown local work metadata before built-in implementation entry; it does not prove code, test, approval, release, runtime, or external-system outcomes. The current Viewer ledger continues to show declared dependency counts while detailed readiness remains an API/agent/CLI projection.
- Immutable local continuation checkpoints bind one current Git/source basis and graph version to current Context Refs, optional Handoff Workspace metadata, and existing Work records. They are available through local CLI (`flowpeek continue`), HTTP, and MCP; the Viewer has no checkpoint controls yet. Listing does not create a checkpoint store, and creation remains a local delivery-plan metadata write rather than source or parser-fact mutation.
- Immutable local planned overlays and exact Plan Refs are available through `flowpeek continue plan`, local HTTP, MCP, and one explicit opt-in local Viewer Continue mode. A Plan Ref resolves only to its retained overlay node and exposes current, stale, future, unavailable, or unresolved state without silently redirecting to a technical Context Ref or source node. In Continue mode, planned nodes and edges are visibly marked as delivery-plan metadata and not found in source; they remain outside source scan, Flow Lens, factual search, impact, and parser coverage.
- Append-only local plan reconciliations are available through `flowpeek continue reconcile`, local HTTP, MCP, and the trusted local Viewer. A positive implementation outcome requires a human actor and one or more current same-project technical Context Refs; agent and tool records remain explicit proposals. Reconciliation records never create source nodes, parser facts, Flow Lens steps, impact results, test proof, runtime observations, or approval authority.
- Deterministic baseline/plan/current comparison is available through local HTTP, MCP, and the selected-node Continue-mode Viewer panel. It combines one exact retained checkpoint and overlay with current Context Ref resolution and append-only reconciliation records. It never uses AI/similarity matching, reconstructs unavailable historical state, or treats missing retained evidence as missing implementation.
- Read-only checkpoint divergence is available through local HTTP, MCP, and the selected-node Continue-mode Viewer panel. It compares one retained checkpoint with local Git/source state and bounded changed paths without fetch, checkout, merge, rebase, or ref mutation. A `diverged` status is not a merge-conflict claim.
- A bounded agent continuation packet is available through local HTTP and MCP. It combines one exact checkpoint with current selected Context Ref resolution, divergence, linked Work metadata, an optional exact planned overlay, reconciliations, acceptance criteria, limitations, and explicit omissions. It contains no source body, shell, credential, or target-execution surface; non-current selected refs require source fallback.
- Directional focus for incoming, selected, and outgoing context, reinforced by border, shape, label, and a persistent static-evidence legend.
- Dense-map behavior that dims unrelated relationships and reveals edge labels only around the current focus.

The Viewer uses Cytoscape.js Canvas rendering for supported interaction and Dagre for layout. An explicit **WebGL preview** is available for local bounded-map evaluation; it uses Bezier edges and falls back to Canvas if unavailable. It is exploratory, not a supported performance mode. Adoption as the default still requires pinned dense-graph performance and human-readability evidence without weakening bounded projection or accessibility behavior. See [ADR-018](docs/adr/ADR-018-bounded-webgl-preview.md).

### Checkout showcase support

- `flowpeek showcase` and `npm run showcase` create a marked temporary copy of the committed TypeScript checkout example and open its declared primary Flow Lens.
- The viewer guide exposes exact temporary-workspace apply/reset commands. The ordinary watcher, SSE, HTTP API, and MCP cache then report the same refreshed graph state and retained adjacent comparison.
- The demonstration covers supported TypeScript imports and direct calls plus one deliberate unsupported computed dynamic import. That missing edge is disclosed and is never interpreted as absent runtime behavior.
- The showcase does not execute the target application, install its integrations, run repository-owned tests, or provide independent benchmark, human-study, provider-study, runtime, or release evidence.

### Current scaling behavior

- server-side projection/search;
- bounded default graph view;
- no requirement to send/render the complete monorepo graph;
- focus-specific dependency view;
- explicit application/runtime/framework/devtool scope.

### Planned, not current

- arbitrary historical Flow Lens reconstruction beyond captured adjacent comparisons;
- human verification lifecycle beyond a text description;
- editable SDLC timeline and workflow controls in the Viewer;
- checkpoint Viewer controls over immutable local continuation-checkpoint storage;
- checkpoint creation or editing controls in the Viewer;
- automatic planned-node materialization, model-based matching, and external Git/CI/deployment workflow authority.

## Quality evidence

### Fixture corpus

Current deterministic fixtures cover:

- CommonJS direct call flow;
- Next.js request flow;
- Python payment flow;
- TypeScript order route/service/repository/test flow.

The current fixture gate reports 32/32 expected relationships. This is a
regression gate for those fixtures only; it is not a universal parser-accuracy
or runtime-behavior claim.

### External audited slice

The pinned external corpus covers fourteen manually audited scopes across:

- pnpm, including a Rust scope;
- NestJS;
- SvelteKit;
- Vite;
- Symfony, including a PHP scope.

The documented result is 92/92 relationships inside that declared slice. It is not universal precision/recall for all files or boilerplate in those repositories.

### Performance evidence

See [BENCHMARKS.md](BENCHMARKS.md). Performance results must retain repository revision, machine/run context, selected changed path, raw samples, and the distinction between parser reuse and end-to-end refresh time.

### Orientation benchmark evidence

`flowpeek evaluate orientation` currently supports source-pinned deterministic cases with `baseline`, `flowpeek`, or `both` conditions. The direct baseline uses literal substring retrieval and never claims flow order. Flowpeek uses static graph/Flow Lens/test relationships and temporary-copy stale probes. Both report bounded paths, disclosed character-based token estimates, host-specific non-gating preparation and retrieval, separate stale validation, unavailable process startup/module load, and no prose claim accuracy.

`flowpeek evaluate agent-comparison` validates externally collected paired sessions for the same case, provider, and model. It supports direct-repository and Flowpeek conditions, distinct session enforcement, graph/Context Ref/tool declarations, target/flow/test/stale scoring, duration, bounded context estimates, separately reviewed claims, verification, and optional cost. It does not start a provider, execute a target, accept source bodies or machine paths, or claim an independent provider quorum. The checked artifact is `not-run`.

## Cache and identity reliability

Status: `current` for graph cache schema v5, project identity, graph version, and bounded adjacent delta.

- Graph cache payloads are validated before persistence and when read for reuse.
- Invalid JSON, unsupported schema versions, malformed graph envelopes, and mismatched repository roots are rejected with machine-readable diagnostics.
- The migration harness upgrades compatible v4 graph evidence to v5 with `graphVersion: 0`; earlier serialized schemas are deliberately rejected until an explicit evidence-preserving migration is implemented.
- Cache writes validate first, write a temporary file in the destination directory, flush/close it where the platform exposes those operations, then replace the destination with bounded retry for transient Windows locks. Failed writes clean temporary files and preserve the prior destination.
- Flowpeek records either an explicit config `projectId` or a generated UUID in `.flowpeek/project.json`. A moved directory retains its ID. A copied directory can retain its ID; origin-remote mismatch is disclosed as a copy/fork candidate, never silently resolved.
- A material static graph state receives a monotonic `graphVersion`; no-op refreshes retain it. Source content/revision changes advance it even when no static topology changes, and the resulting delta reports `sourceChanged: true`, `topologyChanged: false`.
- `.flowpeek/deltas/` keeps the 40 newest version-adjacent delta files. Deltas report paths, refresh work, nodes, edges, flows, coverage, affected technical nodes, bounded affected Context Cards/Flow Lens entries, and up to 12 captured before/current Flow Lens comparisons. The context projection does not reconstruct a full historical card or prove runtime behavior.
- `flowpeek cache status` reports local Flowpeek storage, registered derived-artifact counts, stale-record counts, and the explicit retention boundary without reading source bodies. `flowpeek cache prune --dry-run` previews old registered derived artifacts; omitting `--dry-run` removes only those exact files below `.flowpeek/cache/artifacts/`. It never prunes the current graph, state, project identity, deltas, history, verification, delivery, runtime, or unregistered files.
- `GET /api/cache-hygiene` and MCP `get_cache_hygiene` expose the same read-only hygiene projection. Cache-disabled/session-only scans disable derived-artifact writes as well as durable graph-state reuse.
- Compatible Viewer refreshes reconcile Cytoscape elements in place. Viewport and unchanged-node positions are retained; a renderer change or an empty/incompatible graph is the explicit recreation boundary. This is a local interaction guarantee, not a runtime-flow or rendering-performance claim.
- Viewer Detail level and `flowpeek view --level` provide deterministic Domain, Feature, Component, and Symbol projections. These are bounded groupings of current static metadata; summaries are derived display nodes, never source entities, runtime service boundaries, or business-flow proof.
- `/api/scan-status`, `/api/scan/cancel`, `/api/cache`, `/api/capabilities`, `/api/delta`, `/api/changed-contexts`, `/api/flow-context-card`, `/api/flow-comparison`, CLI JSON and `delta`, viewer scan freshness, MCP `get_scan_status`, MCP `cancel_scan`, MCP `get_agent_context`, MCP `get_graph_delta`, MCP `get_changed_contexts`, MCP `get_flow_context_card`, MCP `get_flow_comparison`, and MCP `refresh_graph` expose scan, cache, identity, context, or delta state appropriate to their response.

## Context Card and reference support

Status: `partial`; node and bounded supported-entry flow cards are current, while verified-card lifecycle remains planned.

- Raw graph nodes and bounded supported-entry flows have versioned local Context Cards with `flowpeek-context/v1` and JSON/Markdown Context Packets.
- Context refs use `fp://local/<project-id>/node/<node-id>@<graph-version>` or `fp://local/<project-id>/flow/<flow-id>@<graph-version>`, with URI percent-encoding.
- The viewer can copy node/flow Context Refs and packets, then resolve either pasted ref. MCP provides the same operations through `get_context_card`, `get_flow_context_card`, and `resolve_context_ref`.
- Resolution never silently redirects: `current` and `stale` return current evidence; `historical` reports retained removal evidence; node-only `successor-candidate` requires human confirmation; `unresolved` reports why no safe resolution exists.
- A removed flow can expose the bounded Flow Lens snapshot already captured by its adjacent comparison. Full historical card reconstruction, flow successor inference, broader continuity, and verified-card metadata are not implemented.

## Adding or changing support

A language, framework, resolver, or relationship capability is not complete until:

1. syntax interpretation uses an AST/compiler/toolchain adapter;
2. supported forms and excluded forms are documented;
3. facts include parser identity, source evidence, and confidence;
4. exact and ambiguous cases have fixtures;
5. false positives are tested, not only successful extraction;
6. parser coverage reports failures and inventory-only fallback;
7. incremental invalidation behavior is tested where resolution can change;
8. MCP interpretation limits are updated;
9. this matrix and machine-readable capabilities agree;
10. external evidence is added when a strong product claim depends on real repositories.

## Claims Flowpeek must not make

- “Supports all code” when some files are inventory-only.
- “Understands every framework boilerplate.”
- “This path executed” from a static call/import edge.
- “This is the business flow” from an endpoint traversal.
- “No tests exist” because no direct test edge was found.
- “This change is safe” because impact traversal was empty.
- “Incremental scanning updates only one relationship” when global relationships are rebuilt.
- “100% precision and recall” without naming the exact audited scope.
