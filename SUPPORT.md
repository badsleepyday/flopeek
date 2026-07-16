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
| TypeScript, TSX | TypeScript compiler AST | `exact-static` top-level functions/classes | Static imports plus supported TS/project aliases | Direct unshadowed local identifiers and supported named imports | Express, Fastify, NestJS, Next.js, Prisma, TypeORM, Drizzle, BullMQ subsets | Decorator/config values must match supported static patterns; dynamic DI and method dispatch unsupported. |
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
| Prisma | Statically imported client construction and recognized operations | Exact static instance/operation subset. |
| TypeORM | Statically imported DataSource/connection patterns and recognized operations | Exact static subset; repository method dispatch is incomplete. |
| Drizzle | Statically imported factory and recognized operations | Exact static subset. |
| BullMQ | Statically imported Queue/Worker/FlowProducer construction and recognized operations | Exact static instance subset; runtime processors/callback behavior not traced. |

## Relationship matrix

| Relationship | Current availability | Interpretation |
| --- | --- | --- |
| `declares` / `contains` | Registered structural adapters | Source containment fact. |
| `imports` / `uses` | Adapter- and resolver-specific | Static module relationship. |
| `calls` | Supported direct-identifier subsets | Static direct call, not full language call graph. |
| endpoint-to-handler | Supported framework patterns | Static registration/file convention. |
| data/queue use | Supported JS/TS runtime integrations | Recognized static instance and operation. |
| request/fetch | Supported static request patterns | Static target when literal/resolvable. |
| test relationship | Direct stored graph relationships | Missing relationship does not prove missing behavioral coverage. |
| impact | Traversal of stored edges | Static potential impact, not runtime blast radius. |
| flow | Bounded traversal from an extracted HTTP/request endpoint | Technical projection, not runtime sequence or business process. Route/controller nodes without endpoint evidence remain technical-map nodes. |

## Analysis layers

Nodes are classified into layers used by the viewer and agent context:

- `application` — project code considered part of the application map;
- `test` — recognized test files;
- `runtime` — runtime integration/dependency nodes;
- `framework` — framework internals/dependencies;
- `devtool` — configuration, build, lint, and development tooling;
- inventory/other — known files or dependencies outside focused application views.

Source scope precedence is `excluded`, `fixture`, `test`, `generated`, then `application`. Test, fixture, and generated nodes remain available for direct relationships, impact evidence, and diagnostic/all views. Only application endpoints are default flow entries; tests and fixtures need explicit `flowEntries` opt-in. Scope is path-based and does not execute repository configuration.

## Flow support

### Current

- Entry points: extracted HTTP/request endpoints only. Route/controller nodes without endpoint evidence remain available through overview, search, and direct dependencies.
- Traversal: outgoing stored static graph edges.
- Bounds: 50 entries, 24 steps, depth 6.
- Default entries: application endpoints only; test and fixture entries require explicit policy.
- Test, fixture, and generated steps: omitted from default application flows.
- Output: node ID, label, type, and depth.
- Flow Lens: a separate `flowpeek-flow-lens/v1` projection for one extracted HTTP/request endpoint. It defaults to 12 displayed steps and accepts a strict integer limit from 1 through 24, with derived technical role, per-step Context Ref, deterministic parser-edge evidence reference, bounded fan-out, supported static database/queue/external boundaries, and explicit truncation/ambiguity. A controller or route-like node without endpoint evidence remains available as a technical node; it never becomes an HTTP/request Flow Lens by fallback.
- Flow Context Card: a `flowpeek-context/v1` card with `kind: flow`, a versioned local flow ref, the same requested bounded Flow Lens projection, direct related-test evidence, JSON/Markdown packets, and explicit limits. Viewer, HTTP, and MCP reject invalid limits rather than silently clamping them.
- Semantic flow suggestion: `flowpeek-semantic-flow-suggestion/v1` deterministically proposes a title, technical purpose, request role, and route grouping from literal HTTP entry, step roles, direct transition evidence, and static boundaries. Every result includes evidence, confidence, reasons, and either `suggested` or explicit `abstained` status.
- Semantic suggestion feedback: `flowpeek-semantic-suggestion-feedback/v1` appends accepted, edited, rejected, or abstained human labels for one exact suggestion snapshot. It may link an agent trace only when both records carry the same Context Ref; it never verifies the flow or evaluates business correctness.
- Flow verification: immutable local human verification records with current, compatible, stale, detached, indeterminate, unverified, or unavailable resolution. Verification is separate from parser facts and is not proof of a business process.

### Not current

- command, CLI, queue, scheduler, or event entry discovery as general flow families;
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

## Git history support

### Current

- resolve a requested Git ref;
- create static graph from `git archive` in temporary storage;
- persist snapshot under `.flowpeek/history/<full-sha>.json`;
- compare node/edge topology and static flows;
- include changed Git paths.

### Limits

- uncommitted working-tree changes are excluded;
- unreachable or missing history cannot be recovered;
- rewritten/squashed/imported history may omit original intent;
- snapshot comparison is not a source semantic diff;
- historical rationale requires external evidence and remains planned.

## MCP support

| Tool | Current guarantee | Important limit |
| --- | --- | --- |
| `get_agent_bootstrap` | Provider-independent graph identity, readiness, parser coverage, safe tool sequence, and evidence policy | Does not read source bodies, execute the target, grant source-write authority, or make runtime/business claims. |
| `get_agent_context` | Parser coverage, interpretation rules, projection meaning, and bounded deterministic semantic suggestions | Suggestions do not provide verified business intent. |
| `get_agent_evidence_traces` | Bounded agent-declared action records filtered by Context Ref or operation ID | Not private reasoning, human verification, source diff, command output, or runtime proof. |
| `record_agent_evidence_trace` | Idempotently append Context Ref, graph versions, declared action, repository-relative changed paths, and verification outcome to local metadata | Writes only `.flowpeek/agent-evidence-traces.json`; cannot write source or human verification. |
| `get_semantic_suggestion_feedback` | Current immutable feedback resolution and history for one deterministic Flow Lens suggestion | Not model calibration, human verification, business-purpose truth, or a source read. |
| `record_semantic_suggestion_feedback` | Idempotently append accepted, edited, rejected, or abstained feedback for the server-calculated suggestion | Writes only `.flowpeek/semantic-suggestion-feedback.json`; cannot write source or human verification. |
| `get_project_overview` | Small aggregate technical map | Aggregate nodes are not source entities. |
| `find_nodes` | Deterministic metadata lookup | No source/semantic search. |
| `get_node` | Raw node, direct evidence, human description | Current ID may become stale after rename/move. |
| `get_direct_dependencies` | Immediate graph neighborhood | Not full runtime dependency graph. |
| `get_request_flows` | Static bounded request traversals | HTTP/request oriented; not business/runtime flow. |
| `get_flow_projection` | Bounded Flow Lens with roles, parser-edge evidence, boundaries, branches, limits, deterministic semantic suggestion or abstention, and optional integer `maxSteps` from 1 through 24 | HTTP/request entries only; derived static projection, not runtime/control-flow/business proof. |
| `get_flow_context_card` | Bounded current HTTP/request flow Context Packet as JSON or Markdown with the same optional `maxSteps` contract | Static selected evidence only; no source body, runtime history, business rationale, or verified-card lifecycle. |
| `get_change_impact` | Static dependents/dependencies, endpoints, tests | Potential impact only. |
| `get_related_tests` | Directly connected test nodes | Missing result does not prove missing tests. |
| `get_context_card` | Bounded raw-node Context Packet as JSON or Markdown | Static parser evidence only; no source-file body, runtime proof, or verified-card lifecycle. |
| `resolve_context_ref` | Current/stale/historical/unresolved node or flow ref state, plus conservative node-only successor candidates | Historical state relies only on retained adjacent deltas; candidates are never auto-redirected and flow successors are not inferred. |
| `create_git_snapshot` | Static graph for a commit | No checkout and no runtime behavior. |
| `compare_git_snapshots` | Static topology/flow comparison | No uncommitted source changes. |
| `get_graph_delta` | Read retained adjacent delta by version or current latest version | Bounded to adjacent versions; not an arbitrary historical reconstruction. |
| `get_changed_contexts` | Bounded current/historical technical nodes and Flow Lens entries affected by one retained adjacent delta | Static delta evidence only; a historical item is not a reconstructed Context Card. |
| `get_flow_comparison` | Retained bounded before/current Flow Lens snapshots for one captured affected flow | Adjacent static snapshot comparison only; no source contents, full history, or runtime behavior. |
| `refresh_graph` | Reconcile graph and persist an adjacent delta | Static delta only; agent must pass changed paths when known for source-only attribution. |

MCP currently exposes no source write, file content, shell, deployment, credential, or production operation. Its only agent-facing metadata mutations are the non-destructive append-only evidence trace and semantic-feedback tools.

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

- Feature overview.
- Request map.
- Direct dependencies.
- Flow Lens from a selected detected HTTP/request flow, with raw-node drill-down.
- Flow Context Ref and JSON/Markdown packet copy from the open Flow Lens.
- Deterministic semantic suggestion or explicit abstention, with a draft-only action that never saves human verification automatically.
- Node inspector with responsibility, methods, connections, tests, human description, and parser evidence.
- Raw-node Context Card copy and pasted Context Ref resolution.
- Persistent graph-version badge and bounded live change tray, including affected technical nodes/flows, changed current Flow Lens steps, captured before/current Flow Lens comparison, and server-side refresh-to-context timing.
- Parser coverage summary.
- Live new-file list.
- Benchmark comparison.
- Mermaid export.
- Directional focus for incoming, selected, and outgoing context, reinforced by border, shape, label, and a persistent static-evidence legend.
- Dense-map behavior that dims unrelated relationships and reveals edge labels only around the current focus.

The Viewer uses Cytoscape.js for interaction and Dagre for layout. GraphQL is not required or supported as a Viewer renderer; bounded HTTP and MCP contracts remain the supported retrieval surfaces.

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
- SDLC timeline and workflow views.

## Quality evidence

### Fixture corpus

Current deterministic fixtures cover:

- CommonJS direct call flow;
- Next.js request flow;
- Python payment flow;
- TypeScript order route/service/repository/test flow.

The current fixture gate reports 24/24 expected relationships. This is a regression gate for those fixtures only.

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
- `/api/cache`, `/api/capabilities`, `/api/delta`, `/api/changed-contexts`, `/api/flow-context-card`, `/api/flow-comparison`, CLI JSON and `delta`, viewer agent context, MCP `get_agent_context`, MCP `get_graph_delta`, MCP `get_changed_contexts`, MCP `get_flow_context_card`, MCP `get_flow_comparison`, and MCP `refresh_graph` expose cache, identity, context, or delta state appropriate to their response.

## Context Card and reference support

Status: `partial`; node and bounded HTTP/request flow cards are current, while verified-card lifecycle remains planned.

- Raw graph nodes and bounded HTTP/request flows have versioned local Context Cards with `flowpeek-context/v1` and JSON/Markdown Context Packets.
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
