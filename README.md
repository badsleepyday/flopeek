# Flowpeek

> Versioned change context for developers and coding agents.

**Flowpeek is local-first code intelligence for developers and coding agents.**
It parses supported repository structure into a deterministic local graph, then
turns that graph into small, evidence-backed views: where a technical flow
enters, which symbols and static relationships it touches, which tests are
directly related, what changed, and what context another person or agent can
reuse.

Large repositories make both people and coding agents repeatedly search,
reconstruct call paths, and carry oversized source excerpts between tasks.
Flowpeek keeps one versioned graph on the machine and lets every supported
surface ask bounded questions of that same state.

The public product identity and its explicit pre-release brand boundary are in
[the product identity note](docs/product-identity.md).

## The five-minute change-context loop

Flowpeek is most useful when a change forces you to reconstruct a technical
path before you edit it. The first experience is deliberately one loop, not a
feature tour:

1. **See one bounded static flow** in the local Flow Lens.
2. **Copy its versioned Context Ref** before the source changes.
3. **Apply one declared source change** in a disposable checkout.
4. **Compare before/current evidence** after the graph refreshes.
5. **Inspect related tests and the old Context Ref** instead of assuming either
   remains current.

The included checkout showcase runs that loop without executing its target
application. It is the fastest way to decide whether Flowpeek is useful for a
repository you need to change.

## How it works

1. **Scan locally.** Supported parsers extract repository facts without running
   the target application.
2. **Build a versioned graph.** Nodes, relationships, parser coverage, and
   freshness are stored as reproducible local evidence.
3. **Focus the question.** Flow Lens, impact, comparison, and Context Packets
   return bounded views instead of the entire codebase.
4. **Reuse the evidence.** People and agents resolve the same Context Refs from
   the same graph version across Viewer, HTTP, CLI, and MCP.

![Repository to shared Flowpeek context](docs/assets/shared-context-workflow.svg)

The design is deliberately evidence-aware: static parser facts, deterministic
inference, human verification, agent declarations, and opt-in runtime
observations remain separate. A static relationship is not a claim about
runtime order, business intent, or successful behavior.

## See the product

### Focus one technical flow

Flow Lens reduces a repository graph to one bounded static path, with technical
steps, source locations, parser coverage, and a versioned Context Ref.

![Flowpeek Viewer showing a bounded POST checkout Flow Lens](docs/assets/screenshots/flow-lens.png)

### Understand what changed

Before/current comparison identifies added, removed, and changed static
relationships between adjacent graph versions. It is change-orientation
evidence, not runtime history.

![Flowpeek before and current static flow comparison](docs/assets/screenshots/flow-comparison.png)

### Inspect proof together with its limits

The proof panel shows pinned benchmark evidence and current-repository facts
alongside the exact scope and limitations of each result.

![Flowpeek product proof panel with bounded evidence](docs/assets/screenshots/product-proof.png)

<details>
<summary>Historical beta-candidate verification snapshot (not a public npm release)</summary>

This snapshot describes the candidate validated on July 25, 2026 before public
Core became authoritative in tagged commits on public `main`. These are
repository and test facts for that revision—not live telemetry, runtime
coverage, or universal accuracy claims.

| Metric | Validated result |
| --- | ---: |
| Full repository test suite | **318 passed / 0 failed** |
| Source files scanned | **196** |
| Structurally parsed files | **196** |
| Parse failures | **0** |
| Static graph nodes | **1,787** |
| Static graph edges | **6,479** |
| Tests represented in the graph | **84** |
| MCP tools exposed by clean-room install | **62** |
| Package audit | **Passed — 178 files** |
| GitHub Actions | **Node 20 passed · Node 22 passed** |

### Development included in this beta channel

| Product area | Current capability |
| --- | --- |
| Repository orientation | Bounded repository discovery, package-scoped scans, explicit resource limits, and typed inventory anchors |
| Technical flows | Supported HTTP/request, package-script, `node-cron`, Django, Click, Typer, and Flask CLI entry evidence |
| Change understanding | Graph deltas, affected contexts, before/current Flow Lens comparison, and Git Context Ref continuity |
| Human/agent handoff | Versioned Context Refs, Context Packets, and relevance-ranked bounded MCP context |
| Delivery context | Work records, evidence-gated workflows, timelines, immutable checkpoints, planned overlays, and reconciliation |
| Viewer | Semantic zoom, keyboard Flow Lens navigation, narrow layouts, Canvas default, and experimental bounded WebGL preview |
| Stability | Last-complete-graph fallback, scan cancellation, cache freshness, helper cleanup, and deterministic cancellation coverage |
| Packaging | Strict allowlist, clean-room installation verification, and tagged public-Core release checks |

The historical beta candidate does not mean the npm package was published as a
public beta release.

</details>

## Run the change-context loop

Flowpeek is **not available from npm yet**. Its package metadata is prepared
for a future beta, but the standard publication path remains owner-gated. The
default `main` branch is the current public Flowpeek Core, so start from a
source checkout:

```powershell
git clone https://github.com/badsleepyday/flowpeek.git
cd flowpeek
npm install
npm run showcase
```

The showcase opens a safe temporary checkout flow. It does not execute the
target application or change the committed example.

Public preview and stable versions are immutable Git tags on `main`, not long-
lived `alpha` or `beta` branches. See [RELEASING.md](RELEASING.md) for the
release contract.
Follow one live change:

1. Inspect the opening **Flow Lens** and copy its **Flow Context Card**.
2. Copy the **apply** command shown by the Viewer and run it in another
   terminal.
3. Open **Compare before/current** to inspect added static steps and changed
   relationships.
4. Inspect the directly related test candidate and resolve the earlier Context
   Ref; it should be explicitly marked stale.

[Open the five-minute walkthrough](docs/showcase-walkthrough.md). It records
the exact expected evidence, safe workspace boundary, reset path, and the
limits of this demonstration.

### Bring the same context to an agent

An agent starts with `get_agent_bootstrap`, resolves a flow or node, reads only the source it needs with its normal workspace tools, refreshes Flowpeek after edits, and checks changed or stale context.

```text
get_agent_bootstrap
  → get_scan_status
  → get_entry_flows
  → get_flow_projection
  → get_related_tests
  → edit with existing workspace tools
  → refresh_graph
  → get_changed_contexts
```

Flowpeek MCP exposes no arbitrary shell, deployment, credential, or repository-source write operation.

## Use it on a repository

Start with a TypeScript/Node repository if you want the closest fit to the
checkout showcase and the shortest local setup. Flowpeek also has explicitly
bounded parser support beyond that starting point; check the
[support matrix](SUPPORT.md) before treating a missing relationship as absent.

From the Flowpeek checkout:

```powershell
npm exec -- flowpeek discover D:\path\to\repository --max-files 5000 --budget-ms 10000
npm exec -- flowpeek scan D:\path\to\repository
npm exec -- flowpeek scan D:\path\to\repository --max-files 5000 --max-bytes 250000000 --budget-ms 60000
npm exec -- flowpeek scan D:\path\to\repository --package apps\api
npm exec -- flowpeek scan D:\path\to\repository --no-cache
npm exec -- flowpeek view D:\path\to\repository --level domain --format json
npm exec -- flowpeek serve D:\path\to\repository --max-files 5000 --max-bytes 250000000 --budget-ms 60000
npm exec -- flowpeek doctor D:\path\to\repository --platform all
```

The local Viewer and MCP expose the same scan freshness. If a bounded refresh
does not complete, Flowpeek keeps the last complete graph and labels it
`stale-unverified` instead of serving a partial reconstruction.

### Focus one package first

For a large monorepo, select a concrete package directory before asking for a
technical map:

```powershell
npm exec -- flowpeek discover D:\path\to\repository --package apps\api --format json
npm exec -- flowpeek serve D:\path\to\repository --package apps\api
npm exec -- flowpeek mcp D:\path\to\repository --package apps\api
```

The path must be inside the repository and contain its own regular
`package.json`. Flowpeek labels the map as **Package: apps/api** for both people
and agents. It is a static source subtree, not proof of workspace membership,
dependency ownership, build activation, or runtime topology. To keep that
boundary safe, package scans are ephemeral sessions: they do not overwrite the
repository-wide cache and cannot join `serve --global` yet.

The selected subtree still obeys the repository's `.flowpeek/config.json`
source, test, fixture, and exclusion rules; `--package` does not silently
override them.

Install project-local MCP configuration for a supported host:

```powershell
npm exec -- flowpeek install D:\path\to\repository --platform codex
npm exec -- flowpeek install D:\path\to\repository --platform claude
npm exec -- flowpeek install D:\path\to\repository --platform cursor
npm exec -- flowpeek install D:\path\to\repository --platform gemini
```

Flowpeek preserves unrelated host settings and refuses conflicting managed entries. ChatGPT web cannot connect to a local stdio MCP server through this installer.

[Read the user guide](docs/using-flowpeek.md) · [Read the agent guide](docs/agent-integration.md) · [Check language/framework support](SUPPORT.md)

## Why use a graph instead of search alone?

Literal search is excellent when you already know the identifier. Flowpeek becomes useful when you also need relationship order, reusable context identity, change impact, or a shared human/agent view.

![Orientation capability comparison](docs/assets/orientation-capabilities.svg)

The checked orientation suite contains three small source-pinned TypeScript/Python fixtures. Both conditions find all 10 targets and 3 tests. Only Flowpeek produces the expected 14 ordered static steps and detects all 3 stale Context Refs. Oracle files are excluded from direct retrieval.

This benchmark does **not** prove developer productivity, AI patch quality, runtime order, or token savings. On these tiny fixtures, literal retrieval is faster and its returned text is smaller. Flowpeek pays a cold graph-build cost to provide capabilities that literal retrieval does not model.

[Inspect the complete benchmark and raw evidence](BENCHMARKS.md)

## Reuse work on large repositories

Flowpeek retains parser facts and reparses changed files. Relationship assembly remains graph-wide, but supported unchanged files do not need a full parser pass.

Before scanning an unfamiliar workspace, `flowpeek discover` can report
candidate source, scope, static manifests, adapter demand, and declared resource
bounds without parsing source. A bounded CLI scan returns no partial graph and
does not replace the last complete cache. CLI, Viewer/HTTP/SSE, and MCP share
the same progress, cancellation, and `stale-unverified` outcome contract.

![Incremental scan evidence](docs/assets/incremental-performance.svg)

The chart reports one host-specific comparison for one supported unchanged file per pinned checkout. It is not a universal speed guarantee.

### Bounded proof snapshot

| Evidence | Checked result | Boundary |
| --- | ---: | --- |
| Real-repository relationship audit | 92/92 | 14 declared scopes in 5 pinned repositories |
| Incremental parser reuse | 1.67×–54.53× | 4 pinned repositories on one benchmark host |
| Orientation graph retrieval | 14/14 ordered steps; 3/3 stale refs | 3 small fixtures; no human or provider study |
| Clean-room package | Strict allowlist; CLI, scan, and MCP bootstrap pass | One Windows/Node observation; no publish |

Run the public proof contract:

```powershell
npm exec -- flowpeek proof D:\path\to\repository --iterations 3
npm run test:real-corpus
npm run evaluate:orientation
```

## What Flowpeek does not claim

- A static edge is not proof that code executed.
- A generated technical flow is not a verified business process.
- Missing evidence is not proof that behavior or tests are absent.
- Inventory-only files do not have inferred relationships.
- The audited 92/92 slice is not universal repository accuracy.
- A tagged release identifies a public preview or stable source snapshot; it
  does not turn static evidence into runtime proof.

Dynamic dispatch, dependency-injection containers, reflection, callbacks, macros, runtime module loading, and unsupported framework wiring may be absent from the static graph. Flowpeek exposes parser coverage and limitations so a developer or agent knows when to inspect source directly.

## Documentation

Start at the [documentation index](docs/README.md).

| Goal | Document |
| --- | --- |
| Use Flowpeek day to day | [User guide](docs/using-flowpeek.md) |
| Run the complete demo | [Showcase walkthrough](docs/showcase-walkthrough.md) |
| Connect a coding agent | [Agent integration](docs/agent-integration.md) |
| Check exact support | [Support matrix](SUPPORT.md) |
| Inspect evidence | [Benchmarks](BENCHMARKS.md) |
| Understand product boundaries | [Product contract](PRODUCT.md) |
| Understand internals | [Architecture](ARCHITECTURE.md) |
| See what comes next | [Roadmap](ROADMAP.md) |
| Implement versioned work continuation | [Continuation execution plan](docs/work-continuation-plan.md) |

## Verification

```powershell
npm test
npm run test:viewer
npm run test:orientation
npm run audit:package
npm run verify:clean-room
```

Flowpeek currently requires Node.js 20 or later. The source repository is
public; npm registry publishing remains a separate release decision.
