# Flowpeek product contract

> **Use this document to judge scope and product decisions.** For installation and daily use, start with the [user guide](docs/using-flowpeek.md). For exact parser coverage, use [SUPPORT.md](SUPPORT.md).

## Document authority

This document is the canonical definition of **what Flowpeek is, who it serves, which problems it solves, and which product rules must remain true while it evolves**.

It is intentionally separate from the delivery roadmap:

- [PRODUCT.md](PRODUCT.md) defines the stable product contract.
- [ROADMAP.md](ROADMAP.md) is the single prioritized Agile delivery roadmap.
- [ARCHITECTURE.md](ARCHITECTURE.md) describes the current implementation and target technical design.
- [SUPPORT.md](SUPPORT.md) states exactly which languages, frameworks, and relationships are supported.
- [BENCHMARKS.md](BENCHMARKS.md) records reproducible performance and audited relationship evidence.

If another document conflicts with this product contract, resolve the conflict explicitly. Do not silently change the product through an implementation detail.

## Status vocabulary

Every capability named in this document must use one of these states in delivery documentation:

| State | Meaning |
| --- | --- |
| `current` | Implemented, tested, and documented in the repository. |
| `partial` | A useful subset exists, with explicit missing behavior. |
| `planned` | Accepted product direction, not yet implemented. |
| `exploratory` | A hypothesis requiring validation before it becomes a commitment. |
| `non-goal` | Deliberately excluded from the product boundary. |

Product prose must not make a `planned` or `exploratory` capability sound current.

## Product definition

### One sentence

**Flowpeek turns an existing repository into small, evidence-backed, locally scoped technical-flow contexts that people can understand and coding agents can use through the same local cache.**

### Short description

Flowpeek is a local-first code-intelligence and delivery-context tool. It scans supported source code without executing the target application, builds a technical evidence graph, projects bounded application flows, and exposes the result through a CLI, a lightweight local viewer, and an MCP server that is read-only for repository source.

The long-term product connects that technical evidence to requirements, decisions, implementation work, tests, review, release, and observation through configurable SDLC methods.

### What makes it distinct

The differentiator is not merely owning a graph, another canvas, or a large list of MCP tools. The differentiator is a consistent local context lifecycle:

```text
repository changes
  -> parser facts are refreshed
  -> technical graph state receives a version
  -> affected flows and contexts are identified
  -> captured affected flows can be compared before/current
  -> the open viewer explains the change to a person
  -> MCP resolves the same context for an agent
  -> delivery records reference the same evidence
```

### Development vision lock

The following statements are the product-direction lock used during implementation,
dogfooding, stress testing, and review:

1. Flowpeek humanizes existing projects as bounded technical flows; it does not
   replace the repository, IDE, project tracker, test runner, or coding agent.
2. Deterministic repository evidence remains the foundation. AI, ML, generated
   wording, reviewer opinion, and workflow status may enrich or assess evidence,
   but cannot silently become parser fact or human verification.
3. People and agents resolve the same project identity, graph version, Context
   Ref, limitations, and freshness state through the local cache.
4. Static topology is never presented as runtime order, successful behavior,
   complete coverage, business intent, or original rationale.
5. Large repositories are handled through discovery, scope, budgets, bounded
   projections, progressive disclosure, and explicit omissions—not an
   unbounded canvas or a misleading partial result.
6. SDLC methods remain templates over evidence-linked delivery records. Changing
   a task or checkpoint cannot fabricate implementation, verification, release,
   or runtime evidence.
7. Flowpeek stays local-first and permission-bounded. It may coordinate approved
   evidence workflows later, but it does not become an unrestricted autonomous
   shell, source writer, deployment agent, or production control plane.

A proposal that conflicts with this lock requires an explicit product-contract
change and an ADR before implementation. A dogfooding observation may reveal a
defect or a missing capability; it does not change the vision by itself.

## Problem statement

Existing and legacy repositories are difficult to enter safely because their behavior is distributed across routes, functions, modules, data access, queues, tests, configuration, external services, and historical decisions.

People commonly face these problems:

- A new developer does not know where a use case begins or ends.
- A maintainer sees files and symbols but not the focused flow that connects them.
- A reviewer receives a diff without an understandable application-impact narrative.
- A coding agent repeatedly searches the repository and may use stale or incomplete context.
- A project records tasks and releases without preserving which code-flow evidence supported them.
- Documentation drifts because generated technical facts and human explanations are not distinguished.

Flowpeek addresses these problems by making technical evidence navigable, shareable, versioned, and reusable across human and agent workflows.

## Target users

### Primary users

| Persona | Need | Successful outcome |
| --- | --- | --- |
| New developer | Understand an unfamiliar repository quickly. | Can explain and navigate a critical flow with direct code links. |
| Maintainer | Assess the effect of a change. | Sees affected contexts, dependencies, entry points, and related tests. |
| Reviewer or technical lead | Review intent and evidence, not only a raw diff. | Can inspect what changed in a flow and which claims are verified. |
| Coding agent | Obtain minimum, current, structured context. | Uses a resolvable graph version and detects stale context after edits. |

### Secondary users

| Persona | Need | Successful outcome |
| --- | --- | --- |
| Architect | Keep application-flow documentation connected to code. | Verified flows survive rescans and expose unsupported areas. |
| QA engineer | Connect behavior and change impact to verification. | Required tests and recorded outcomes attach to the affected context. |
| Product or delivery lead | Follow work from goal to release evidence. | SDLC checkpoints reference technical Context Cards rather than unsupported claims. |

## Jobs to be done

### Repository orientation

When entering a repository, help me find its important entry points and focused technical flows so that I can start useful work without reading every file.

### Change understanding

When source code changes, show me which known technical context changed and what remains uncertain so that I can review impact without assuming runtime behavior.

### Context handoff

When I need another person or agent to inspect a component, let me copy a compact, resolvable Context Packet so that the recipient sees the same evidence and graph state.

### Agent grounding

When a coding agent plans or verifies a change, provide bounded graph context, parser coverage, source references, related tests, and staleness information so that it does not reconstruct the repository blindly.

### Delivery traceability

When a team moves work through an SDLC method, connect requirements, decisions, implementation, verification, review, and release checkpoints to the technical flows they affect.

## Product principles

### Evidence before prose

Technical claims must originate in supported parser or repository evidence. Friendly descriptions may summarize that evidence, but cannot replace it.

### Static analysis is not runtime truth

Flowpeek must never describe a stored static edge as proof that a call occurred in production. Runtime evidence may be integrated later, but it must remain a separate evidence type.

### Generated technical flow is not verified business flow

Flowpeek can derive a technical path. It cannot infer an unwritten approval rule, original business reason, or operational exception as fact. Such knowledge remains `inferred`, `verified`, or `unknown`.

### Local-first by default

Repository scanning, cache storage, graph construction, flow projection, and the local viewer run on the user's machine. Source code is not uploaded to an AI provider by default.

### Parser-first source interpretation

Source facts come from syntax trees, compiler APIs, or explicit toolchain adapters. Regex may be used for safe text formats or formatting, but must not be the foundation for interpreting general source-code semantics.

### Uncertainty must be machine-readable

Parser coverage, confidence, knowledge class, unsupported behavior, and projection limits must be available to both the viewer and MCP clients.

### Human and agent context must agree

The viewer and MCP server consume the same graph state. A graph version and Context reference identify what each party used. When a retained adjacent delta captured a Flow Lens comparison, both surfaces receive the same bounded before/current static snapshots.

### Large repositories require focus, not a larger canvas

Default views remain bounded. Search, filtering, scope, semantic zoom, and focused projections are core behavior.

### Workflow state and source evidence remain separate

An SDLC checkpoint can reference a technical flow, but changing a task status cannot alter parser facts. A graph refresh cannot silently approve a task.

### Developer governance remains outside the product runtime

Portable reviewer roles and provider-diverse review runs govern how Flowpeek is designed, tested, and released. They are an external developer ecosystem, not Flowpeek graph nodes, runtime personas, evidence authorities, or customer-facing product dependencies. Flowpeek may consume a review outcome as release evidence only when its provenance and scope are explicit; a role name alone never proves independence or correctness.

### Trust is evidence observability, not a score

Flowpeek may summarize evidence availability, provenance, coverage denominators, and freshness. It must not collapse parser coverage, human verification, agent declarations, test events, runtime observations, or benchmark results into one project truth score. The active repository has no precision or recall value unless independently labeled ground truth for that repository is supplied.

## Capability ladder

Flowpeek evolves through four capability levels. Each level depends on the trustworthiness of the levels below it.

### Level 1 — Observe

Status: `current`

- Discover candidate source, workspace manifests, adapter demand, and declared scan bounds before parsing.
- Run an optional CLI bounded scan that promotes only a complete, inventory-verified graph.
- Scan supported source code.
- Build technical nodes and relationships.
- Show parser coverage and limitations.
- Query direct dependencies, supported static entry flows, impact, and related tests.
- Compare static Git snapshots.
- Retrieve bounded active-branch, path-touch Git evidence for a current or stale Context Ref without checking out or changing the repository.
- Compare one current or stale Context Ref against two pinned static Git snapshots, preserving exact static identity separately from same-path candidates.

### Level 2 — Explain

Status: `partial`

- Project focused human-readable technical flows through a bounded Flow Lens for extracted HTTP/request entries, literal package scripts that directly target one scanned source file, a narrow Django management-command declaration subset bound to one direct `Command` class, and the narrow module-scope `node-cron` literal schedule subset bound to one local top-level function.
- Produce Context Cards and Context Packets.
- Track graph versions and stale references.
- Preserve local node descriptions and immutable attributed flow verification records.
- Preserve append-only agent evidence traces that request only concise declared outcomes and explicitly prohibit prompts, hidden state, source contents, credentials, raw logs, or chain-of-thought.
- Preserve immutable local feedback labels for one exact deterministic suggestion, optionally linked to a same-context agent trace, without treating a label as human verification.
- Accept an unverified provider/agent semantic proposal only for a current Flow Context Ref; let a person revise it or use it as a draft, and reject verification when the reviewed graph state changed.
- Expose reusable semantic memory only from current/compatible human verification metadata; `.flowpeek` is not an embedded-model or model-weight directory.
- Preserve immutable Handoff Workspace versions and append-only attributed notes; export/import them portably while keeping every imported packet foreign, read-only, and unverified.
- Group multiple independently identified projects behind one optional local workspace hub/web port without merging their graphs or inferring cross-project edges; allow only explicit current-Context-Ref human contract declarations between them.
- Show interface-contract availability—including the narrow exact-Next.js literal-contract pilot—and explicit runner-adapter progress/failure evidence without turning MCP into a shell or Flowpeek into a second test framework.
- Keep graph, history, derived projections, semantic suggestions, Context Packets, and handoff metadata as separately auditable artifact classes with visible freshness and invalidation reasons.
- Expose one shared Trust Analytics contract to people and agents, preserving independent evidence classes and returning unavailable instead of inventing repository accuracy.
- Expose one validated public Product Proof contract that shows bounded audited accuracy, pinned incremental performance, current-repository facts, differentiating capabilities, reproduction commands, and explicit non-claims to people and agents.
- Explain live flow changes in the local viewer.
- Provide a safe one-command checkout showcase that copies committed source into a marked temporary workspace, focuses one supported static flow, demonstrates live before/current context and Viewer/HTTP/MCP parity, never executes the target application, and remains explicitly separate from independent benchmark or outcome evidence.

### Level 3 — Guide

Status: `partial`

- Suggest technical roles and flow groupings with evidence (`current` for bounded HTTP/request flows; supported package-script, framework-command, and scheduler entries explicitly abstain until their own deterministic wording contract exists).
- Accept bounded agent/provider draft proposals while keeping human review and verification authoritative (`current`).
- Recommend inspection, testing, review, and documentation actions (`partial`).
- Track explicit runner-adapter progress and failure at displayed static steps through a tested fixture (`partial`; Flowpeek does not execute tests or claim real-CI integration).
- Attach Context Cards to requirements and SDLC checkpoints.
- Enforce evidence requirements for local workflow transitions (`current` for built-in Agile/Waterfall and validated custom definitions; external evidence authority remains out of scope).
- Preserve local Work records, planned windows, append-only actual events, owner/dependency metadata, and current/stale Context Ref status (`current`; the Viewer ledger is read-only).

### Level 4 — Coordinate

Status: `planned`

- Maintain human and agent ownership, dependencies, checkpoints, and approvals.
- Integrate evidence from Git hosting, CI, deployment, and observability systems.
- Support permissioned actions only through explicit integrations and approval policies.

Flowpeek does not become an unrestricted autonomous coding or deployment agent at Level 4.

## Core product loops

### Human repository loop

```text
Open repository
  -> scan or reuse cache
  -> search/select entry point or component
  -> view focused flow
  -> inspect evidence and limitations
  -> add or approve human description
  -> copy Context Packet when needed
```

### Live development loop

```text
Keep local viewer open
  -> edit source
  -> incremental scanner refreshes facts
  -> graph version advances
  -> affected contexts are highlighted
  -> current focus remains stable
  -> inspect impact and tests
```

### Agent loop

```text
get_agent_context
  -> find or resolve Context Card
  -> inspect flow/dependencies/tests
  -> read selected source with workspace tools
  -> edit source with workspace tools
  -> refresh_graph
  -> inspect graph delta and stale contexts
  -> run and record relevant verification
```

### Agent proposal and human verification loop

```text
agent/provider resolves current Flow Context Ref
  -> appends an unverified bounded semantic proposal
  -> human compares deterministic suggestion and proposal
  -> human accepts, revises, or rejects the draft
  -> verification request names the reviewed graph version and Context Ref
  -> stale state is rejected
  -> current/compatible human verification becomes reusable semantic memory
```

### Multi-project workspace loop

```text
start one global workspace hub
  -> activate independently identified project/service roots
  -> select one active project in the viewer
  -> preserve each project's graph, cache, watcher, and version
  -> record only explicit current-context human contract references; never infer edges or compose flows automatically
```

### SDLC loop

```text
Goal or requirement
  -> affected Context Cards
  -> decision and acceptance evidence
  -> implementation graph state
  -> verification evidence
  -> review approval
  -> release and observation evidence
```

## Conceptual model

Flowpeek uses three connected graph domains rather than mixing every relationship into one meaning.

### Evidence Graph

Represents source and repository facts.

Typical nodes:

- file;
- endpoint;
- function or method;
- class, interface, trait, struct, or module;
- database or queue integration;
- external dependency;
- test;
- Git snapshot.

Typical edges:

- `declares`;
- `imports`;
- `calls`;
- `uses`;
- `reads`;
- `writes`;
- `publishes`;
- `subscribes`;
- `tested_by`.

### Context Graph

Represents human-readable projections and knowledge over evidence.

Typical nodes:

- Flow Projection;
- Context Card;
- verified description;
- semantic role suggestion;
- continuity candidate;
- limitation or unresolved question.

Typical edges:

- `projects`;
- `supported_by`;
- `describes`;
- `verified_by`;
- `supersedes`;
- `possible_successor`;
- `affected_by`.

### Delivery Graph

Represents the lifecycle of planned and completed work.

Typical nodes:

- objective;
- requirement or story;
- decision;
- task;
- checkpoint;
- approval;
- test result;
- review;
- release;
- observation or incident.

Typical edges:

- `requires`;
- `implements`;
- `blocked_by`;
- `owned_by`;
- `verified_by`;
- `approved_by`;
- `released_as`;
- `observed_by`.

Graph domains may reference one another, but retain distinct schemas and trust rules.

## Product artifacts

### Technical node

A Technical node is an extracted Evidence Graph entity with:

- deterministic current identity;
- type and layer;
- repository-relative source path;
- source range when available;
- parser and adapter identity;
- confidence and analysis status;
- direct relationships;
- limitations relevant to interpretation.

### Flow Projection

A Flow Projection is a bounded technical traversal from an entry point or selected node. It contains:

- projection ID and graph version;
- entry context;
- ordered or branched technical steps;
- role per step when derivable;
- exact evidence edges supporting each transition;
- side effects and external boundaries;
- truncation and ambiguity information;
- knowledge class and confidence.

A Flow Projection is not a runtime trace.

### Context Card

A Context Card is the principal human-agent handoff artifact. It contains:

- `contextRef`;
- project and graph identity;
- selected Technical node or Flow Projection;
- concise responsibility or purpose statement;
- knowledge class and confidence;
- source evidence;
- incoming and outgoing relationships;
- related flows and tests;
- current limitations and unresolved questions;
- human verification metadata;
- safe next actions.

### Context Packet

A Context Packet is a portable bounded representation of a Context Card, durable Brief, or task-specific handoff composition. Agent-facing packets declare their budget estimator, included and omitted evidence, truncation reasons, graph version, confidence, and resolvable Context Refs. They do not contain unbounded source code, credentials, shell access, machine-specific paths, or unqualified runtime claims.

### Work record

A Work record connects a delivery goal to technical context. It contains:

- workflow template and state;
- goal or requirement;
- linked Context Cards;
- owner and dependencies;
- decisions;
- required evidence;
- actual evidence;
- approvals;
- timestamps and graph versions.

## Knowledge and trust model

| Class | Definition | May be presented as fact? |
| --- | --- | --- |
| `extracted` | Directly produced by a supported parser or repository adapter. | Yes, inside the documented support boundary. |
| `derived` | Deterministically projected from extracted facts. | Yes, as a technical projection. |
| `inferred` | Suggested by a heuristic, classifier, or model. | No; confidence and correction are required. |
| `verified` | Explicitly approved or supplied by a person. | Yes, with verifier and graph-version metadata. |
| `superseded` | Previously valid human knowledge replaced by newer verified knowledge. | Historical only. |
| `unknown` | Evidence is absent, ambiguous, or unsupported. | Yes: the unknown state itself is factual. |

Confidence and knowledge class are different. An `extracted` relationship can have `likely` confidence when framework identity is not fully proven. A human may verify a description even when some implementation relationships remain unknown.

## Current capability boundary

Status: `current` unless marked otherwise.

- Local repository scan, validated graph cache, and generated/configured project identity.
- AST/compiler-based adapters with documented language-specific limits.
- Technical nodes, relationships, extracted HTTP entry flows, literal direct package-script entry flows, narrow Django management-command declaration flows, narrow literal `node-cron` schedule entry flows, and bounded Domain/Feature/Component/Symbol aggregate projections. Derived hierarchy ids retain their selected ancestors and never turn summaries into source or runtime facts.
- Parser coverage and machine-readable agent interpretation rules.
- CLI summary, JSON, Mermaid, impact, benchmark, snapshot, history, Git-evidence, and Git-continuity commands.
- Lightweight local viewer with search, bounded views, an Entry map, Flow Lens for supported static entries, captured before/current Flow Lens comparison, node/flow Context Card copy/resolve, immutable local flow verification, inspector, human descriptions, benchmark panel, live SSE refresh with affected-context/flow highlighting, and a read-only local Work ledger inspector.
- Human-first Project Home with explicit human-authored/unavailable purpose and architecture, feature/domain map, critical and recently changed flows, trust boundaries, documentation completeness, unresolved questions, evidence-linked starting points, and deterministic application-scoped concept search.
- Portable human concept tags in immutable Handoff Workspace versions; concept search shows whether a match came from a human tag, route/path metadata, feature/domain, or parser label, and abstains on ambiguous aliases.
- Versioned handoff quality reports over explicit legacy-style fixture cases, including bounded retrieval stages, observed composition time, token size, stale-context detection, evidence traceability, and separately classified agent outcomes without runtime claims.
- Explicit opt-in runtime-observation metadata bound to Context Refs, with source/log/credential/path sanitization, separate local retention, and expired manifests; it never creates static graph edges or upgrades another evidence class.
- Source-read-only MCP tools for overview, node search, evidence, node/flow Context Cards, flow verification, dependencies, static entry flows, Flow Lens, captured adjacent Flow Lens comparison, impact, tests, capabilities, graph delta, changed contexts, refresh, Git snapshots, bounded active-branch path-touch Git evidence, and exact Context Ref continuity across two static Git snapshots, plus bounded local agent-trace, semantic-feedback, Delivery Work-record, workflow-assignment, transition, actual-event, immutable continuation-checkpoint, and immutable planned-overlay/Plan Ref metadata tools. Flow Lens and Flow Context Card requests share one strict bounded-depth contract across MCP, HTTP, viewer copy actions, JSON, Markdown, and derived caching.
- A provider-independent `flowpeek-agent-bootstrap/v1` contract plus project-local, non-destructive integration for Codex, Claude Code, Cursor, and Gemini CLI. The generated skill standardizes graph-first orientation, source fallback, post-edit refresh, and evidence limits without embedding provider personas or giving Flowpeek source-write authority.
- A source-pinned repository-orientation retrieval benchmark that compares literal direct-repository retrieval with Flowpeek static context while keeping deterministic results, human observations, and provider outcomes separate. Missing baseline flow/stale capabilities remain unavailable rather than fabricated as failures.
- A provider-neutral paired agent-comparison evaluator for explicitly supplied sessions with and without Flowpeek. It validates condition isolation, consent, graph identity, Context Refs, outcomes, separately reviewed claims, verification, and optional cost without invoking a provider or treating agent output as graph truth.
- An explicit npm package allowlist and clean-room tarball verifier that installs the exact private artifact into an isolated temporary consumer, checks bounded CLI/scan/MCP contracts with lifecycle scripts disabled, fingerprints the copied fixture before and after, and cleans all temporary state. This is packaging evidence, not publication permission or release readiness.
- Optional repository-local reviewer skills and a portable `flowpeek-independent-review/v1` artifact contract for UI/UX, implementation, system-flow, documentation, and release-readiness review. Reviewer output remains advisory evidence and never changes parser facts or creates human verification.
- Incremental parser-fact reuse and global relationship rebuilding.
- Static Git commit snapshots, flow/topology comparison, and Context Ref continuity projection across two snapshots.
- Deterministic HTTP/request semantic suggestions with versioned candidate fields, reasons, evidence references, confidence, and explicit abstention.

Current limitations include:

- generated Flow Lenses begin only at extracted HTTP/request endpoints, literal package scripts with one direct scanned source-file target, a narrow Django `management/commands` declaration subset with one direct `Command`/`BaseCommand`/`handle` form, or the narrow module-scope `node-cron` default-import literal-schedule subset with one exact local top-level function target; route/controller nodes, unsupported scripts, unsupported framework command forms, and unsupported scheduler registrations remain technical-map nodes or unsupported-entry inventory rather than synthetic flows;
- Flow Lens and Flow Context Cards support those narrow static entry families and derive roles/boundaries from static node and edge facts; they are not command invocation, Django app registration or settings loading, scheduler initialization or task execution, runtime order, control-flow, or business intent;
- graph state has a durable monotonic version and bounded adjacent delta history; changed-context projections connect one retained adjacent delta to current/historical technical nodes and Flow Lens entries, but remain static evidence rather than a runtime trace, full source history, or historical Context Card reconstruction;
- Git Context continuity compares only exact static IDs and bounded same-path candidates in two chosen snapshots; it neither follows rename/move history nor automatically declares a successor, implementation match, or preserved behavior;
- node identity is path/symbol based and does not survive every move or rename;
- node and bounded supported-entry flow Context Cards/Packets exist; bounded supported-entry flows also have immutable local human-verification lifecycle, while full historical card reconstruction does not;
- repository scope configuration is path-based; it does not infer semantic ownership or execute project configuration;
- deterministic route-oriented semantic suggestions and local immutable feedback capture are implemented, while trained models and business-purpose inference are not; the local SDLC workflow foundation, immutable continuation checkpoints, immutable planned overlays/Plan Refs with CLI/HTTP/MCP parity, an opt-in Viewer Continue mode, append-only human reconciliation records, deterministic baseline/plan/current comparison, read-only local checkpoint divergence, and bounded agent continuation packets exist, but checkpoint editing and external evidence authority are not current;
- dynamic/runtime-only relationships remain outside static proof.
- Runtime observations are caller-supplied metadata only; Flowpeek does not run probes, collect logs, or infer runtime behavior from them.

## Target functional scope

### Repository and scope configuration

- source, test, fixture, generated, and excluded roots;
- application-flow entry eligibility;
- adapter enablement and toolchain preferences;
- maximum projection depth and node limits;
- local cache and history retention;
- privacy and external-enrichment policy.

### Live flow intelligence

- durable graph identity and monotonic versions;
- adjacent graph deltas;
- affected Context Cards and flows;
- stable viewer focus during refresh;
- before/current focused-flow comparison;
- stale-context detection for agents.

### Humanized context

- evidence-rich Flow Lens;
- Context Cards and portable Context Packets;
- verified labels, descriptions, owners, risks, and questions;
- continuity candidates across refactors;
- human approval and supersession history.

### Semantic inference

- deterministic technical-role features and scoring;
- transparent grouping and naming suggestions;
- abstention when evidence is insufficient;
- human feedback capture;
- optional local ML after a verified dataset exists;
- optional LLM wording assistance with explicit opt-in and approval.

### SDLC methods

- generic workflow state-machine schema (`current`);
- Agile, Waterfall, and custom templates (`current` for built-ins and validated local custom definitions);
- evidence requirements per transition (`current` for declared local evidence kinds);
- planned windows and append-only actual timeline metadata (`current`); editable Viewer timeline remains target behavior;
- human and agent ownership/dependencies (`partial`; storage is current, blocking resolution remains target behavior);
- decision, review, release, and observation records;
- checkpoint editing and read-only branch-divergence analysis;
- permissioned integrations with external systems.

## UX requirements

### Viewer requirements

- Open on a useful focused view, not the complete repository graph.
- Keep labels readable at the default zoom.
- Preserve selection and focus across live updates.
- Show exactly what changed and which graph versions are compared.
- Separate application, test, framework, runtime, devtool, and inventory scopes.
- Provide accessible status text and symbols in addition to color.
- Make evidence, confidence, limitations, and verification status visible.
- Permit one-click copy of a Context Packet.
- Make unsupported or empty states explanatory rather than blank.

### CLI requirements

- Remain scriptable and deterministic.
- Offer JSON for every non-interactive result.
- Return meaningful exit codes.
- Provide `--version`, diagnostics, the current agent-integration `doctor`, and a future broader toolchain/cache doctor.
- Avoid launching a browser unless the selected command requests the viewer.

### MCP requirements

- Remain read-only for source code by default.
- Permit only explicit, bounded, append-only local metadata writes with non-destructive tool annotations and idempotent operation IDs.
- Include graph identity and interpretation limits in every context-bearing result.
- Prefer a small set of composable context tools over overlapping tool growth.
- Never expose private model reasoning.
- Report stale references and unsupported analysis explicitly.
- Scope every scanner backend and MCP stdio session to one configured local repository. A workspace hub may route to several isolated project backends but never merges their graphs.

## Semantic inference policy

Semantic inference begins with explainable non-generative features. Function names are supporting evidence, never sufficient evidence.

Useful features include:

- entry-point position;
- graph neighborhood and path role;
- data read/write operations;
- event and queue operations;
- external integration boundaries;
- module and package boundaries;
- related tests;
- symbol-name tokens;
- human corrections from previous graph versions.

The first inference engine is deterministic. A trained model is permitted only after a versioned human-reviewed dataset and held-out evaluation exist. Flowpeek now provides a private cohort contract and recommendation gate, but no real cohort is committed and no model is approved. Every model must support abstention and publish calibration, precision, recall, coverage, and correction rates.

An optional LLM may improve wording for a selected Context Card. It cannot create or modify extracted graph evidence, silently approve a business statement, or mark its own suggestion as verified.

## SDLC method model

Flowpeek implements one generic workflow engine. Agile, Waterfall, and team-specific processes are templates over that engine.

Each workflow definition contains:

- states;
- allowed transitions;
- roles permitted to transition;
- required technical and human evidence;
- approval gates;
- entry and exit rules;
- mapping to planned and actual timeline events.

Example evidence gate:

```text
implementing -> verifying
requires:
  - current Context Cards
  - implementation graph version
  - change impact result

verifying -> reviewing
requires:
  - declared test result
  - no unresolved stale-context warning

reviewing -> released
requires:
  - human approval
  - release evidence
```

Flowpeek may integrate with issue trackers, Git hosting, CI, deployments, and observability. External writes or executions require explicit permissions and approval. A workflow status alone never proves that technical work succeeded.

## Success measures

### Product outcomes

- Median time for a new developer to find and explain a critical flow.
- Percentage of displayed flow transitions backed by direct evidence.
- Percentage of critical application flows with verified Context Cards.
- Time from source save to understandable affected-context update.
- Rate of stale agent context detected before planning or verification.
- Agent context size and verified task outcome compared with an unassisted baseline.
- Inference suggestion acceptance, edit, rejection, and abstention rates.
- Percentage of SDLC transitions with complete required evidence.

### Guardrail measures

- Parser failures and inventory-only coverage by language.
- False-positive and false-negative rates in audited scopes.
- Viewer node/edge budget per focused view.
- Local cache corruption and migration failure rate.
- External data sent only after explicit opt-in.
- Unsupported claims reported as facts: target zero.

## Non-goals

- Proving complete runtime behavior from static analysis.
- Automatically discovering the original business reason for every component.
- Treating function names as sufficient semantic truth.
- Displaying every monorepo node on one canvas by default.
- Replacing source control, CI, deployment, or observability systems.
- Providing unrestricted source-write, shell, production, or credential access through MCP.
- Uploading a repository to an AI provider by default.
- Declaring a task complete because a model or workflow state says so without evidence.

## Product decision guardrails

Before accepting a feature, answer:

1. Which primary user and job does it serve?
2. Which graph domain owns the data: Evidence, Context, or Delivery?
3. What evidence and knowledge class support the result?
4. How does a person inspect or correct it?
5. How does an agent consume the same context?
6. What happens when the context becomes stale?
7. What is the local-first and privacy behavior?
8. How is the behavior tested on a real repository?
9. Which unsupported cases remain visible?
10. Does it preserve the product definition or create an unrelated platform?

## Open product decisions

These decisions must be resolved through explicit ADRs before their dependent implementation is considered stable:

- Project identity when a repository is moved, forked, or has no Git remote.
- Context-reference continuity across rename, move, split, and merge refactors.
- Default retention policy for local graph deltas and workflow events.
- Storage backend after JSON cache size becomes a bottleneck.
- Human identity model for local verification metadata.
- Boundary between Flowpeek workflow guidance and permissioned workflow execution.
- Integration authentication and secret-storage policy.
- Licensing and public distribution model.

## Glossary

| Term | Meaning |
| --- | --- |
| Agent context | Structured graph evidence and limits returned to a coding agent. |
| Context Card | Versioned human-readable technical context over a node or flow. |
| Context Packet | Portable bounded representation of a Context Card, Brief, or task-specific handoff composition. |
| Context reference | Resolvable identifier for context at a graph version. |
| Delivery Graph | Requirements, work, decisions, checkpoints, approvals, and release evidence. |
| Evidence Graph | Static code and repository facts. |
| Flow Lens | Focused viewer representation of one technical flow. |
| Flow Projection | Bounded traversal derived from Evidence Graph facts. |
| Graph schema version | Version of the serialized graph format. |
| Graph version | Monotonic identity of a repository graph state. |
| Humanized flow | Technical flow presented in understandable language with evidence and verification status. |
| Inventory-only | File is known but no structural relationship parser is available. |
| Knowledge class | Extracted, derived, inferred, verified, superseded, or unknown status. |
| Technical node | Source-derived graph entity. |
| Work record | SDLC record linked to Context Cards and evidence. |
