# Flopeek Agile delivery roadmap

> **For contributors choosing the next iteration.** This is not a feature manual or release promise. Current user workflows live in the [user guide](docs/using-flopeek.md); current support lives in [SUPPORT.md](SUPPORT.md).

## Document authority

This is the **single prioritized roadmap for building Flopeek**.

- [PRODUCT.md](PRODUCT.md) defines the product contract.
- [ARCHITECTURE.md](ARCHITECTURE.md) defines current and target technical design.
- [SUPPORT.md](SUPPORT.md) defines current analysis support.
- This document defines delivery order, user stories, acceptance criteria, dependencies, and status.

This is not a second product specification and is not an SDLC plan for repositories scanned by Flopeek. Flopeek itself is delivered using the Agile process described here. SDLC methods inside Flopeek are a product epic in this roadmap.

## Status legend

| Status | Meaning |
| --- | --- |
| `done` | Acceptance criteria are implemented, tested, and documented. |
| `partial` | Useful behavior exists, but listed acceptance criteria remain. |
| `ready` | Refined enough to enter an iteration. |
| `planned` | Accepted direction but not yet refined for immediate implementation. |
| `exploratory` | Requires product/technical validation before commitment. |
| `blocked` | Cannot progress until the named dependency is resolved. |

Checkboxes describe repository implementation status. Prose alone never implies a feature is current.

## Current product baseline

Current public preview package version: `0.2.1-beta.1`.

| Capability | Status | Current evidence |
| --- | --- | --- |
| Local CLI scan and graph cache | `done` | Summary, JSON, Mermaid, and optional cache. |
| Large-repository discovery and bounded scan | `partial` | CLI, local server, Viewer/HTTP/SSE, and MCP share terminal outcomes, progress, cancellation, complete-result-only promotion, and last-complete fallback. Shared-plan mutation verification is current; cross-platform helper cleanup and consented monorepo package evidence remain. |
| Lightweight local viewer | `done` | Feature/entry/dependency views, Flow Lens for supported static entries, flow Context Card, captured before/current comparison, search, inspector, benchmark. |
| AST/compiler-based adapters | `partial` | Detailed in [SUPPORT.md](SUPPORT.md). |
| Machine-readable coverage and limits | `done` | Graph analysis, viewer, MCP agent context. |
| Evidence-first Trust Analytics | `done` | One versioned viewer/HTTP/MCP report preserves denominators, freshness, independent evidence classes, explicit unavailable accuracy, and no composite truth score. |
| Incremental parser-fact reuse | `done` | Changed-file parsing with global relationship rebuild. |
| Live viewer refresh | `partial` | SSE refresh, graph-version badge, bounded persistent delta, affected context/flow tray, current Flow Lens step highlighting, and captured before/current comparison. |
| Static impact and test recommendations | `partial` | Stored-edge traversal; no runtime proof. |
| Static Git graph history | `done` | Commit archive snapshots and flow/topology comparison. |
| Source-safe MCP core | `done` | Versioned source-read-only graph/context operations plus bounded idempotent metadata appends; no source body, shell, credential, or source-write surface. |
| Human descriptions | `partial` | Per-node local notes plus immutable attributed flow verification records. |
| Context Cards and portable refs | `done` | Node and bounded supported-entry flow cards, JSON/Markdown packets, local resolver, and flow verification lifecycle exist. |
| Durable layered Briefs | `done` | Versioned Project/Feature/Flow/Node Briefs, evidence-class separation, source basis, freshness, immutable minimal manifests, artifact expiry, API, and JSON/Markdown packets. |
| Token-budgeted handoff context | `done` | One deterministic MCP/API composition surface ranks project/features/flows/tests/evidence under an explicit character-based token estimator and reports omissions. |
| Portable Handoff Workspace | `done` | Immutable superseding workspace versions, append-only attributed notes, JSON/Markdown export/import, strict portable-text guards, and isolated foreign read-only state. |
| Auditable derived cache | `done` | Feature summaries, Flow Projections, semantic suggestions, impact indexes, and Context Packets use separate immutable artifacts with exact hits, selective path/topology invalidation, and API/MCP/viewer audit visibility. |
| Human-first Project Home | `done` | Purpose/architecture availability, feature map, critical/recent flows, parser coverage, trust boundaries, documentation completeness, unresolved questions, starting points, and deterministic concept search link back to current evidence. |
| Legacy handoff quality gate | `done` | A committed ambiguous/multi-handler/indirect/cross-feature fixture and versioned report measure bounded retrieval, token size, timing, stale detection, evidence traceability, honest agent-outcome availability, and optional consented privacy-minimized human time-to-locate observations. |
| Opt-in runtime evidence | `done` | Sanitized Context Ref-bound observation metadata is stored outside the static graph with separate retention and expired manifests; Briefs and Context Packets surface its availability without upgrading other evidence. |
| Auditable concept tags and ambiguity | `done` | Immutable portable human tags enrich deterministic concept matching with explicit reasons; aliases spanning multiple concepts abstain instead of blending unrelated results. |
| Central multi-project serve workspace | `done` | `serve -g` keeps one user-facing hub port, activates isolated project graphs, restores a machine-local project tree, and never terminates an existing process; per-project serve remains available. |
| Agent/provider semantic proposal overlay | `done` | A current Flow Context Ref can receive an immutable unverified proposal, human review/revision, latest-state verification preconditions, and a verification-backed reusable semantic-memory index. |
| Flow contract and test-run evidence foundation | `partial` | HTTP method/route/exact handler are explicit; the narrow Next.js literal-contract pilot exposes handler-bound request/response fields, while dynamic and unsupported forms remain unavailable. A published opt-in runner fixture reports running/failing static steps without executing commands; real CI integration remains. |
| Agent evidence trace | `done` | Append-only Context Ref/action/changed-path/verification records, bounded viewer history/filtering, API, and MCP are available; records remain declarations, not proof. |
| Semantic inference | `partial` | Deterministic HTTP/request candidates, evidence, confidence, abstention, immutable local feedback, trace binding, and draft-only viewer handoff exist; no real feedback dataset or trained model. |
| SDLC workflow engine and local Work ledger | `partial` | Durable work records, planned windows, append-only actual events, Agile/Waterfall/custom definitions, evidence-gated transitions, a read-only Viewer inspector, immutable continuation checkpoints, immutable planned overlays/Plan Refs with CLI/HTTP/MCP parity, an opt-in Viewer Continue mode, append-only human reconciliation records, deterministic baseline/plan/current comparison, read-only divergence, and declared dependency readiness are current. Checkpoint editing and external evidence authority remain. |
| Public distribution | `partial` | The unscoped `flopeek@0.2.1-beta.1` package is published on npm with the `beta` dist-tag and verified through an anonymous clean-room install. A tagged GitHub beta release, stable channel, and documented upgrade policy remain. |

## Agile operating model

### Iteration policy

A two-week iteration is the default planning unit, but scope is controlled by acceptance criteria rather than calendar pressure. A vertical slice that works in CLI, viewer, and MCP is preferred over isolated backend accumulation.

Each iteration should contain:

1. one primary user scenario;
2. one target repository or deterministic fixture;
3. implementation and contract tests;
4. documentation changes in the same commit series;
5. an explicit list of unsupported cases;
6. a demo using both human and agent interfaces when applicable.

### Definition of ready

A story is ready when:

- the user and job are named;
- current behavior is reproducible;
- expected input/output contracts are written;
- graph domain ownership is known: Evidence, Context, or Delivery;
- privacy and permission behavior are known;
- dependencies and migrations are identified;
- acceptance tests can be described before implementation.

### Definition of done

A story is done when:

- behavior is implemented without weakening product invariants;
- fast tests and relevant integration tests pass;
- public schemas and MCP/API contracts are versioned;
- cache migrations or backward compatibility are handled;
- viewer behavior is verified when user-facing;
- coverage, confidence, and limitations are machine-readable;
- README, product/architecture/support documents remain consistent;
- no planned behavior is documented as current;
- a real repository or audited fixture demonstrates the outcome.

### Prioritization rule

Order work by:

1. correctness and trust;
2. product differentiation;
3. user feedback speed;
4. architecture leverage;
5. breadth of language/framework support.

Adding another parser is lower priority than correcting a misleading default flow or stabilizing the shared context contract.

## Delivery horizons

### Now

- Execute the versioned work-continuation sequence in [docs/work-continuation-plan.md](docs/work-continuation-plan.md), beginning with an immutable Git/graph-bound checkpoint before adding planned technical overlays.
- Validate the global workspace hub on a consented multi-repository microservice system and a large monorepo.
- Run an observed usability study of agent proposal → human revise/verify → reusable semantic memory.
- Validate the completed Next.js Route Handler literal-contract pilot on a consented production-shaped repository; dynamic values and unsupported adapters remain unavailable.
- Validate the tested repository-command adapter fixture against a consented repository-owned CI runner.

### Next

- Add read-only branch divergence after the checkpoint, Plan Ref, Continue-mode, manual reconciliation, and baseline/plan/current comparison contracts.
- Run opt-in human/agent handoff studies on real legacy repositories using the consent-ready observation protocol, and retain independently reviewed outcome evidence outside Flopeek's local cache.
- Add consented runtime/test evidence adapters only after a separate privacy, sanitization, retention, and command-authority review; automatic collection remains out of scope.
- Validate concept taxonomy and aliases with opted-in human handoff studies before broadening the vocabulary.
- Continue extracting remaining scanner responsibilities behind adapter and service contracts; deterministic Next.js/SvelteKit file-system route and source-classification derivation are now isolated and regression tested.
- Validate human-authored cross-project contract references on a consented multi-service handoff; automatic graph edges and flow composition remain out of scope.
- Semantic suggestion feedback dataset and trace-linked agent outcome benchmark.

### Later

- Optional local ML and opt-in LLM wording assistance.
- Explicitly approved local test execution adapters with allowlisted commands; MCP remains free of arbitrary shell access.
- Suggested plan-to-actual matching only after a consented human-reviewed reconciliation dataset and held-out evaluation exist.
- Historical continuity and permissioned integrations.
- Public package/release hardening.

## Epic 0 — Trusted technical-map foundation

Status: `partial`, with the MVP core delivered.

### Outcome

A repository can be scanned locally into an evidence graph that is useful to people and agents without hiding parser limits.

### Completed stories

- [x] CLI scan produces summary, JSON, Mermaid, and optional graph cache.
- [x] Viewer runs locally on `127.0.0.1`.
- [x] Viewer requests bounded server-side projections rather than rendering the complete graph by default.
- [x] Evidence contains parser identity, analysis status, source information, and confidence where supported.
- [x] Mixed-language repositories report parsed, inventory-only, and failed coverage.
- [x] Direct dependency, request flow, impact, related-test, and agent-context queries exist.
- [x] Human descriptions persist locally.
- [x] Fixture relationship quality gate exists.
- [x] Pinned external audit and reproducible benchmark evidence exist.

### Remaining foundation stories

- [ ] Split fast unit/contract tests from slow adapter/integration tests.
- [ ] Create machine-readable adapter capability registry.
- [ ] Generate or validate support documentation from capability metadata.
- [ ] Add CLI `--version` and `doctor`.
- [ ] Establish public license and packaging policy.

### Exit criteria

The baseline remains regression-safe while later epics replace no evidence with invented evidence.

## Epic 1 — Repository scope and cache reliability

Status: `in progress`.

Priority: P0.

### Problem

At the Epic baseline, discovery recognized tests primarily from filenames, route-like fixtures could become application-flow entries, and cache writes were not atomic. Stories 1.1–1.3 now isolate repository scope and provide validated, recoverable, atomic graph-cache persistence.

### Story 1.1 — Repository scope configuration

As a developer, I want Flopeek to distinguish application, test, fixture, generated, and excluded source so that the default flow describes the real application.

#### Delivery

- [x] Add versioned `.flopeek/config.json`.
- [x] Support `sourceRoots`, `testRoots`, `fixtureRoots`, and `exclude`.
- [x] Preserve current safe ignored-directory defaults.
- [x] Define deterministic configuration precedence.
- [x] Expose effective scope through CLI, viewer, API, and MCP.

#### Acceptance criteria

- Flopeek scanning its own repository does not present endpoints from `test/fixtures` as default application flows.
- Tests remain available for `tested_by` and impact evidence.
- A user can explicitly include tests/fixtures in a diagnostic scope.
- Invalid configuration produces a clear error and does not corrupt the cache.
- Scope decisions are visible in agent context.

### Story 1.2 — Graph schema validation

As a maintainer, I want every cache payload validated so that incompatible or corrupt state cannot silently influence people or agents.

#### Delivery

- [x] Extract graph schema and validators from scanner implementation.
- [x] Validate on write and read.
- [x] Define invalid-cache fallback and diagnostics.
- [x] Add schema migration harness.
- [x] Add contract fixtures for current schema v5 and compatible-v4 migration.

#### Acceptance criteria

- A malformed graph cache is rejected with a recoverable diagnostic.
- A compatible valid cache is reused.
- Migration tests preserve evidence and descriptions.
- MCP never serves a graph that failed schema validation.

### Story 1.3 — Atomic cache persistence

As a user, I want interrupted scans to preserve the previous valid cache.

#### Delivery

- [x] Write validated temporary files in the destination directory.
- [x] Close/flush and atomically rename.
- [x] Preserve prior valid state on failure.
- [x] Test Windows rename/lock behavior.

#### Acceptance criteria

- Process interruption cannot leave a partially written `graph.json` as valid state.
- Failure is reported without modifying repository source.

### Epic exit criteria

Default flows respect repository scope, and cache reads/writes are validated, recoverable, and atomic.

## Epic 2 — Graph identity and live delta

Status: `partial` — Next.js literal-contract pilot and repository-command runner fixture completed; cross-framework schema extraction and consented real-CI integration remain pending.

Priority: P0.

Dependency: Epic 1 schema/cache foundation.

### Outcome

Viewer and MCP clients can identify the same graph state, compare adjacent states, and detect stale context.

### Story 2.1 — Project identity

As a local user, I want Flopeek to recognize the configured project across process restarts.

#### Delivery

- [x] Record explicit or generated `projectId`.
- [x] Define Git remote, local UUID, fork, copy, and non-Git behavior.
- [x] Add ADR and migration.

#### Acceptance criteria

- Moving a repository path does not silently create unrelated context when verified identity exists.
- Copy/fork ambiguity is disclosed.

### Story 2.2 — Monotonic graph version

As a person or agent, I want a monotonic graph version so that I know whether my context is current.

#### Delivery

- [x] Separate `schemaVersion` from `graphVersion`.
- [x] Define no-op refresh semantics.
- [x] Include source revision/fingerprint.
- [x] Add graph identity to API, SSE, viewer, and MCP.

#### Acceptance criteria

- Material graph change advances the version exactly once.
- No-op refresh behavior is deterministic and tested.
- Viewer and MCP can report the same project/graph identity.

### Story 2.3 — Persistent adjacent delta

As a developer, I want to know what changed between graph versions without reinterpreting a full graph.

#### Delivery

- [x] Version delta schema.
- [x] Report changed paths, parsed/reused/removed files, node/edge changes, coverage changes, and affected technical nodes.
- [x] Retain a bounded local delta history.
- [x] Define truncation behavior and Context Card limitation.

#### Acceptance criteria

- A changed file produces an explicit from/to version.
- Added, removed, and affected items are distinguishable.
- A topology-neutral source edit is not falsely described as no source change; it is reported as a changed path with no topology delta.

### Story 2.4 — Live change tray

As a developer keeping the viewer open, I want an understandable change summary without losing my current focus.

#### Delivery

- [x] Preserve current selection and zoom when possible.
- [x] Highlight affected flow steps, raw evidence, and captured before/current snapshots.
- [x] Show before/current versions.
- [x] Handle multi-file batches and truncation.

#### Acceptance criteria

- The viewer does not reset to a giant overview after an ordinary save.
- Change status is readable without relying only on color.
- Errors leave the last valid graph visible.

### Epic exit criteria

A person and agent can prove which graph state they used and understand the adjacent change.

## Epic 3 — Context Cards and Flow Lens

Status: `partial`.

Priority: P0/P1.

Dependency: Epic 2 identity contract.

### Outcome

Flopeek turns technical evidence into bounded, readable, resolvable context without claiming business or runtime truth.

### Story 3.1 — Context reference

As a developer, I want a local reference that another person or agent can resolve to the same graph evidence.

#### Delivery

- [x] Implement `fp://local/<project>/<kind>/<id>@<version>` for raw node contexts.
- [x] Add current, stale, historical, unresolved, and successor-candidate resolution states.
- [x] Prevent silent redirect to unrelated nodes.

#### Acceptance criteria

- A copied current ref resolves in viewer and MCP.
- An old ref reports its state and available delta.
- Invalid refs fail safely.

### Story 3.2 — Context Card

As a maintainer, I want one compact artifact containing responsibility, evidence, related flows/tests, limitations, and actions.

#### Delivery

- [x] Version Context Card schema.
- [x] Support node and bounded supported-entry flow cards.
- [x] Include knowledge class, confidence, evidence refs, verification state, and limitations for node and flow cards.
- [x] Provide JSON and Markdown Context Packet exports for node and flow cards.
- [x] Exclude unbounded source contents and secrets.

#### Acceptance criteria

- Every friendly statement identifies whether it is extracted, derived, inferred, verified, or unknown.
- Every technical transition resolves to graph evidence.
- Viewer and MCP return contract-equivalent cards.

### Story 3.3 — Evidence-rich Flow Projection

As a new developer, I want a readable technical flow rather than a breadth-first list of graph nodes.

#### Delivery

- [x] Add projection role per displayed supported-entry step.
- [x] Attach deterministic parser-edge evidence references.
- [x] Identify supported static persistence, queue, and external boundaries without claiming side-effect success.
- [x] Represent retained ambiguity, bounded fan-out, truncation, and missing transition evidence.
- [x] Add one narrow command family: literal `package.json` direct-runner scripts with one scanned source-file target.
- [ ] Add framework-command, queue, event, and schedule families only with their own direct evidence contracts.

#### Acceptance criteria

- Flow steps remain bounded and readable.
- Raw dependencies are one action away.
- The flow states that it is static, not runtime.
- Tests/fixtures are excluded from default application entry families.

### Story 3.4 — Human verification lifecycle

As a domain owner, I want to approve or supersede a flow description without changing parser facts.

#### Delivery

- [x] Store verified titles, descriptions, owner, risk, questions, verifier, timestamp, and graph version.
- [x] Preserve verification across compatible refreshes.
- [x] Mark detached/stale verification.
- [x] Record supersession rather than destructive overwrite.

#### Acceptance criteria

- [x] A rescan cannot silently overwrite human verification.
- [x] Stale verification is visible to viewer and agent.

### Epic exit criteria

A developer can explain, inspect, copy, and verify three critical flows using Context Cards with direct evidence.

## Epic 4 — Shared agent context

Status: `partial`.

Priority: P1.

Dependency: Epics 2–3.

### Current core

- [x] Read-only MCP over stdio.
- [x] Machine-readable parser coverage and interpretation limits.
- [x] Overview, search, node, dependency, static-entry-flow, legacy request-flow, Flow Lens, impact, test, Context Card/ref, delta, snapshot, history, and refresh tools.
- [x] No source contents, shell, source writes, credentials, or deployment access.

### Story 4.1 — Context resolution tools

- [x] Add `get_flow_projection`.
- [x] Add `get_context_card`.
- [x] Add `resolve_context_ref`.
- [x] Add `get_graph_delta`.
- [x] Add `get_changed_contexts`.
- [x] Add `get_flow_comparison`.

### Story 4.2 — Stale-context protocol

As a coding agent, I want Flopeek to reject or warn about stale context before I recommend or verify a change.

#### Acceptance criteria

- Every context-bearing tool returns project and graph identity.
- Agent can request a delta from the version it previously used.
- Deleted/moved/unresolved context is explicit.
- Refresh output names analyzed, reused, removed, and affected context.

### Story 4.3 — Agent evidence trace

As a reviewer, I want to know which Flopeek contexts and test outcomes an agent used without storing private reasoning.

#### Delivery

- [x] Record operation ID, context ref, graph versions, declared action, changed paths, and verification result.
- [x] Never request or automatically capture chain-of-thought, prompts, source contents, command logs, or hidden model state; require outcome-only summaries.
- [x] Make viewer display bounded local trace history with client-side actor/status/path filters; it remains agent-declared metadata.

### Epic exit criteria

An internal agent-task benchmark uses less file context while maintaining or improving verified task outcomes, and stale context is detected before action.

## Epic 5 — Adapter and test architecture

Status: `partial`.

Priority: P1 engineering enablement.

### Outcome

Language/framework support can grow without expanding a monolithic scanner and slow integration suite indefinitely.

### Stories

- [ ] Extract discovery and repository scope.
- [ ] Extract graph schema/builder/store.
- [ ] Define adapter registry and capability metadata.
- [ ] Extract language adapters incrementally behind existing tests.
- [ ] Extract resolvers.
- [ ] Generate support artifact/matrix from registry.
- [ ] Split unit, contract, adapter, viewer, integration, and external-corpus test lanes.
- [ ] Set pull-request feedback-time budget.

### Acceptance criteria

- Existing supported fixtures remain unchanged.
- One adapter can be tested without loading every adapter suite.
- Machine-readable capabilities match [SUPPORT.md](SUPPORT.md).
- Pull-request fast lane has a documented target and stable timing.

## Epic 6 — Transparent semantic inference

Status: `partial` — deterministic suggestions, abstention, immutable feedback,
and a privacy-safe evaluation gate are current; a consented dataset, trained
model, and broader entry-family features remain.

Priority: P2.

Dependency: Context Cards and verified feedback storage.

### Outcome

Flopeek suggests useful technical roles, groupings, and names while preserving evidence and abstaining when uncertain.

### Story 6.1 — Deterministic feature model

- [x] Version the deterministic HTTP/request suggestion contract.
- [x] Use entry position, route segments, Flow Lens roles, direct transitions, and static boundaries.
- [x] Keep route-derived wording separate from parser facts and business claims.
- [x] Return reasons and evidence refs.
- [ ] Add data operations, events/queues, related tests, and broader entry families as versioned features.

### Story 6.2 — Transparent role/grouping suggestions

- [x] Suggest technical request roles and purpose.
- [x] Suggest candidate flow grouping and title.
- [x] Support confidence and abstention.
- [x] Keep suggestions separate from extracted graph and verified metadata.

### Story 6.3 — Human feedback dataset

- [x] Store immutable accepted, edited, rejected, and abstained outcomes, with supersession history.
- [x] Version feedback and label schemas; bind each record to an exact suggestion snapshot/fingerprint.
- [x] Require a concise reason for edited/rejected/abstained labels and keep feedback local; no source bodies, prompts, raw logs, or credentials are accepted.
- [ ] Collect a real consented human-review dataset before external evaluation or model training.

### Story 6.4 — Optional model evaluation

- [x] Establish deterministic contract baseline.
- [x] Implement a privacy-safe held-out cohort schema and recommendation gate; it remains ineligible until real consented human labels are supplied.
- [ ] Split verified data into training and held-out evaluation.
- [ ] Evaluate a small local classifier/ranker.
- [ ] Publish calibration, precision, recall, coverage, and abstention.
- [ ] Add opt-in LLM wording only after selected-context privacy and approval controls exist.

### Epic exit criteria

Semantic suggestions measurably outperform deterministic naming on held-out verified data, explain their basis, and safely return unknown.

## Epic 7 — Flopeek SDLC workflow engine

Status: `partial` — the local Delivery Graph and evidence-gated workflow
foundation are current; versioned continuation, editable Viewer workflow,
dependency blocking, and external evidence authority remain.

Priority: P2/P3.

Dependency: Context Cards, graph identity, and evidence trace.

### Outcome

Flopeek supports Agile, Waterfall, and custom methods as templates over one evidence-gated workflow engine.

### Story 7.1 — Delivery Graph and Work record

- [x] Version local Delivery Graph work-record and append-only event schemas.
- [x] Add locally persisted objective, requirement/story, decision, task, checkpoint, approval, test result, review, release, observation, and incident records.
- [x] Link delivery records to project-scoped Context Refs and their graph versions.
- [x] Keep workflow assertions separate from Evidence Graph facts; this storage layer records plans/events while `workflow-engine.js` owns validated transitions.

### Story 7.2 — Generic workflow state machine

- [x] Version local states, transitions, roles, and evidence requirements; external approval authority and integrations remain unimplemented.
- [x] Validate local transitions deterministically against the assigned workflow and declared evidence references.
- [x] Prevent status from fabricating technical completion; every transition states its explicit limitation.

### Story 7.3 — Method templates

- [x] Agile template: backlog → planned → implementing → verifying → reviewing → released → observing.
- [x] Waterfall template: requirements → design → implementation → verification → release → observing.
- [x] Local custom workflow definitions with schema validation; user editing surfaces remain pending.

### Story 7.4 — Planned-versus-actual timeline

- [x] Planned windows are editable through the local work-plan API and retained as methodology-neutral delivery metadata.
- [x] Actual local events are append-only and can carry declared Context Ref, test, review, release, or observation references; automatic Git/integration collection remains pending.
- [ ] Viewer distinguishes plan, actual, retry, failure, approval, supersession, and rollback without relying only on color.

### Story 7.5 — Human and agent work ledger

- [x] Ownership plus task dependencies are stored as local work-record metadata; cycles are rejected and built-in implementation entry is blocked when declared dependencies are not locally workflow-ready. This remains delivery metadata, not source or runtime proof.
- [x] Required project-scoped Context Refs retain their graph versions and are surfaced with current/stale/future status.
- [x] Local workflow templates require declared verification and approval evidence kinds before their configured transitions.
- [x] Stale Context Ref counts are shared by the Viewer, HTTP, MCP, and CLI ledger views.
- [x] Delivery events reject source bodies, raw logs, credentials, machine paths, and private reasoning fields.

### Story 7.6 — Versioned work continuation

The accepted architecture is [ADR-020](docs/adr/ADR-020-versioned-work-continuation.md).
The lower-cost-model execution contract and acceptance order are maintained in
[docs/work-continuation-plan.md](docs/work-continuation-plan.md).

- [x] Synchronize the current Delivery Graph/workflow baseline and lock planned entities outside the Evidence Graph.
- [x] Compose immutable continuation checkpoints from current Git/source basis, graph version, selected Context Refs, optional Handoff Workspace, and Work records.
- [x] Expose checkpoint list/get/create through one local CLI, HTTP, and MCP contract without adding a Viewer control.
- [x] Add a separate Plan Ref and immutable planned-node/planned-edge overlay without contaminating Flow Lens, impact, search, or parser coverage.
- [x] Expose planned-overlay list/get/create and exact Plan Ref resolution through one local CLI, HTTP, and MCP contract without adding a Viewer control.
- [x] Render explicit, accessible ghost nodes only in an opt-in Viewer Continue mode.
- [x] Add append-only manual one-to-many reconciliation with distinct human and agent authorship.
- [x] Compare retained baseline, plan, and current context with explicit partial/unavailable outcomes.
- [x] Detect local branch/source divergence without network, checkout, merge, rebase, or ref mutation.
- [x] Provide one bounded continuation packet shared by HTTP and MCP.
- [ ] Complete Flopeek-on-Flopeek dogfooding, broad surface parity, documentation, and packaging verification.

### Epic exit criteria

One feature can be followed from requirement through a selected method to implementation, verification, review, release, and observation evidence. Every technical claim resolves to a Context Card or is unknown.

## Epic 8 — Historical intent and integrations

Status: `planned`.

Priority: P3.

### Historical intent stories

- [x] Link bounded active-branch path-touch Git evidence to current/stale Context Refs without checkout, ref mutation, or rationale claims.
- [x] Compare a current/stale Context Ref against two pinned static Git snapshots, separating exact static identity from same-path candidates without rename, successor, or rationale claims.
- [ ] Optionally inspect all refs for archaeology without treating them as current architecture.
- [ ] Link PRs, issues, ADRs, incidents, releases, and observations when evidence exists.
- [ ] Classify rationale as explicit, inferred, verified, superseded, or unknown.
- [ ] Visualize Context Card continuity across Git snapshots.

### Integration stories

- [ ] Define read-only evidence adapter contract.
- [ ] Add Git hosting and CI evidence first.
- [ ] Add deployment and observability evidence after trust/schema validation.
- [ ] Scope any write/execute permission by repository, environment, operation, duration, and work record.
- [ ] Require human approval for material external state changes.

### Exit criteria

Every “why” or “what happened after release” statement links to evidence or is explicitly unknown.

## Epic 9 — Product distribution and operations

Status: `partial`.

Priority: P1 before public recommendation; otherwise can proceed alongside later product work.

### Stories

- [x] Select and add license.
- [x] Remove `private: true` only when publication is authorized.
- [x] Add package `files` allowlist.
- [x] Exclude tests, corpus, and GitHub workflows from runtime package unless intentionally shipped.
- [x] Add `flopeek --version`.
- [x] Add `flopeek doctor` for Node, Git, Go, .NET, adapter, and cache diagnostics.
- [x] Auto-select the next available loopback port or clearly report collision.
- [ ] Add changelog and release automation.
- [ ] Test clean-room install, MCP launch, scan, viewer, and uninstall.

### Exit criteria

A new user can install Flopeek from the selected release channel, scan a repository, connect MCP, and open the viewer using only published documentation.

## Proposed first six iterations

These are sequence proposals, not fixed dates.

### Iteration 1 — Correct application scope

Goal: Flopeek's own default flow no longer comes from test fixtures.

Status: `completed`.

Evidence: `npm.cmd test` passed 56 tests, including configuration defaults, schema/type rejection, source/test/fixture/generated/excluded classification, test relationships, diagnostic flows, CLI/API/viewer/MCP scope metadata, cache preservation, incremental reclassification, and watcher reload. The fixture corpus passed 16/16 audited relationships. Flopeek self-scan produced no default fixture entries while diagnostic flows retained `GET /api/health`, `GET /payments/{payment_id}`, and `POST /orders` from `test/fixtures`.

- Repository config schema.
- Test/fixture classification.
- Entry eligibility.
- Scope contract tests.
- Viewer/MCP effective-scope display.

### Iteration 2 — Reliable graph state

Goal: cache state is validated, atomic, and project-scoped.

Status: `completed`.

Evidence: graph schema validation is extracted into a dedicated validator with a current contract fixture and compatible-v4 migration harness. Cache reads reject malformed, unsupported, malformed-envelope, and wrong-project state with machine-readable diagnostics; writes validate first and use a flushed same-directory temporary file with bounded transient-lock retry. Generated or configured project IDs are visible in CLI JSON, API/viewer context, and MCP context. ADR-001 defines move/copy/fork/non-Git behavior. Iteration 3 extends this baseline with graph state and adjacent deltas.

- Graph schema extraction.
- Atomic write.
- Project identity ADR and first implementation.
- Cache migration harness.

### Iteration 3 — Versioned delta

Goal: every material refresh has an explicit before/after identity.

Status: `completed`.

Evidence: schema v5 separates file format from monotonic `graphVersion`; material fingerprints include deterministic static evidence plus source content/revision and exclude transient refresh metadata. Restart and no-op scans retain the version, while a topology-neutral source edit advances it and produces `sourceChanged: true`, `topologyChanged: false`. `.flopeek/state.json` and 40 retained `.flopeek/deltas/<from>-<to>.json` records persist identity and adjacent changes. The API, SSE, viewer badge/change tray, CLI `delta`, and MCP `get_graph_delta` / `refresh_graph` share this state. ADR-002 specifies recovery and non-claims.

- Graph version.
- Delta schema.
- SSE/API/MCP identity.
- Stale-version contract tests.

### Iteration 4 — Context Card vertical slice

Goal: one endpoint/function can be copied and resolved through viewer and MCP.

Status: `completed`.

Evidence: ADR-003 defines `fp://local` references and a bounded node-card schema. A raw node card can be copied from the viewer as a reference, JSON packet, or Markdown packet; pasted viewer refs and MCP `resolve_context_ref` report current, stale, historical, successor-candidate, or unresolved state without automatic successor navigation. MCP `get_context_card`, local API packet/resolution routes, and contract tests use the same graph-service implementation. This iteration deliberately excluded flow cards, which were added later in Iteration 8; full historical reconstruction and human-verification lifecycle remain excluded.

- Context ref.
- Node Context Card.
- JSON/Markdown packet.
- Resolve/stale states.

### Iteration 5 — Flow Lens vertical slice

Goal: one HTTP request flow is readable, evidence-rich, and bounded.

Status: `completed`.

Evidence: `flopeek-flow-lens/v1` derives a default 12-step projection from one existing HTTP/request flow without changing the scanner's stored facts. Each step has a technical role, current node Context Ref, and a deterministic parser-edge evidence reference when an adjacent-depth transition exists. The lens surfaces bounded fan-out, alternative predecessors, missing evidence, source-traversal limits, and supported static persistence/queue/external boundaries. Viewer flow buttons open the lens and every displayed node drills into raw dependencies; `/api/flow-lens` and MCP `get_flow_projection` share the same graph-service result. Flow-level verification was explicitly `null` in this iteration; later iterations added Context Cards and lifecycle metadata.

- Step roles.
- Evidence refs.
- Static boundaries.
- Raw drill-down.
- Human verification draft (`null`, not a lifecycle).

### Iteration 6 — Live shared-context proof

Goal: edit a flow and show the same affected Context Card to a person and agent.

Status: `completed`.

Evidence: `flopeek-changed-contexts/v1` projects each retained adjacent delta into bounded node and Flow Lens contexts with explicit status, availability, Context Refs, Lens IDs, and changed static step IDs. SSE carries this exact projection; the local viewer preserves an open Flow Lens, shows affected items in the change tray, and marks affected displayed steps. MCP `get_changed_contexts` and `refresh_graph.changedContexts` return the same graph-service result. An end-to-end test edits a static HTTP flow and verifies matching SSE, HTTP, Flow Lens, stale-reference evidence, and server-side refresh-to-context timing. The timing begins after watcher debounce and excludes browser transport/rendering.

- [x] Live change tray.
- [x] Focus preservation.
- [x] Changed-context MCP.
- [x] End-to-end user/agent scenario.
- [x] Context-size and latency measurement.

### Iteration 7 — Adjacent Flow Lens comparison

Goal: let a person and agent inspect a captured affected flow before and after one adjacent graph refresh without treating the old side as live code.

Status: `completed`.

Evidence: `flopeek-flow-comparison/v1` retains bounded before/current Flow Lens snapshots only for captured affected flows in an adjacent delta. It deterministically identifies added/removed steps, static transition, displayed metadata and depth changes, plus source-only evidence changes. The local viewer exposes the same comparison from the live tray and open Flow Lens; old steps are read-only and current steps drill into current raw evidence. `/api/flow-comparison` and MCP `get_flow_comparison` use the graph-service result shared with `get_changed_contexts`. Tests cover source-only, static-step addition, HTTP/SSE parity, and MCP refresh/query behavior. The capability explicitly excludes arbitrary historical reconstruction, source contents, runtime order, and business-process proof.

- [x] Bounded retained snapshots in adjacent deltas.
- [x] Deterministic static comparison classification.
- [x] Viewer before/current inspector with safe historical behavior.
- [x] HTTP and MCP comparison access.
- [x] Contract and end-to-end tests.

### Iteration 8 — Portable Flow Context Card

Goal: let a person or agent copy one bounded HTTP/request flow as a versioned Context Packet and safely resolve it after graph changes.

Status: `completed`.

Evidence: `flopeek-context/v1` now supports `kind: flow` with `fp://local/<project>/flow/<flow-id>@<version>`. The card packages one current `flopeek-flow-lens/v1` projection, direct related-test evidence, truncation, limitations, unresolved questions, verification state, and safe actions without source-file contents. JSON and Markdown packets are available from the open viewer, `/api/flow-context-card`, and MCP `get_flow_context_card`. The shared resolver returns current or stale current cards, historical removal evidence with an already-captured bounded Lens snapshot when available, and explicit unresolved results; it does not infer flow successors or reconstruct a full old card. Contract tests cover viewer/API, MCP, current, stale, historical, unresolved, packet bounds, and source-content exclusion.

- [x] Versioned flow Context Ref and `kind: flow` card.
- [x] Bounded Flow Lens and related-test evidence.
- [x] JSON/Markdown packet export.
- [x] Current/stale/historical/unresolved resolution.
- [x] Viewer, HTTP, and MCP parity.
- [x] Contract and integration tests.

### Iteration 9 — Human flow verification lifecycle

Goal: let a person attach attributable, versioned confirmation to a bounded flow without changing parser facts or granting approval authority to an agent.

Status: `completed`.

Evidence: `flopeek-flow-verifications/v1` stores immutable local records in `.flopeek/flow-verifications.json`. A record contains a verified title, description, owner, risk, questions, verifier, timestamp, source graph version, technical fingerprint, participating source paths, and a supersession link. The resolver exposes `current`, `compatible`, `stale`, `detached`, `indeterminate`, `unverified`, and `unavailable` outcomes; compatibility requires a complete retained adjacent-delta chain with no participating path or flow change. The Flow Lens, Flow Context Card, JSON/Markdown Context Packet, HTTP API, and read-only MCP `get_flow_verification` return the same resolution. The viewer creates replacement records rather than overwriting history. Tests cover immutable supersession, source-content exclusion, compatible unrelated changes, stale participating-source changes, detached flows, invalid-store preservation, local API, and MCP read access.

- [x] Immutable local record store and atomic writes.
- [x] Version/fingerprint/delta-based lifecycle resolution.
- [x] Viewer verification form and visible status/history.
- [x] HTTP API and read-only MCP access.
- [x] Context Card and packet separation of human and derived knowledge.
- [x] ADR, documentation, and regression coverage.

### Iteration 10 — Adapter capability registry and fast test lanes

Goal: make proven static adapter support a versioned, declarative contract and provide deterministic feedback lanes before semantic inference work begins.

Status: `completed`.

Evidence: `flopeek-adapter-capabilities/v1` is a validated, deterministically sorted registry exposed identically by graph analysis, `/api/capabilities`, and read-only agent context. `SUPPORT.md` has a generated registry block with write and non-mutating drift-check commands. Explicit fast, unit, adapter, contract, viewer, fixture, complete, and external-corpus lanes preserve existing parser behavior without putting network cloning in ordinary pull-request checks. The local fast lane passed 7 tests in 5.36 seconds; the complete suite passed 75 tests, and the fixture gate retained 16/16 expected relationships at 100% precision and recall.

- [x] Versioned, validated declarative adapter registry.
- [x] Shared graph/API/agent-context registry exposure and repository-coverage separation.
- [x] Deterministic generated support matrix and drift check.
- [x] Explicit local verification lanes and CI ordering for Node 20 and 22.
- [x] Current-state architecture/support documentation and ADR.

### Iteration 11 — Deterministic semantic flow suggestions

Goal: turn bounded static HTTP/request evidence into explainable candidate titles, technical purposes, roles, and groupings without AI, runtime claims, or automatic human verification.

Status: `completed`.

Implemented evidence: `flopeek-semantic-flow-suggestion/v1` produces deterministic `suggested` or `abstained` outcomes with confidence, reasons, and direct node/edge evidence references. Flow Lens, `/api/flow-suggestion`, Flow Context Cards, Markdown packets, viewer drafts, and agent context share the same result. `benchmarks/semantic-flow-suggestions.json` is a committed contract corpus; it measures deterministic output stability, not business-purpose correctness. The external repository runner now reports repository/scope progress, enforces a per-repository child-process timeout, and preserves structured partial results without calling them a pass.

- [x] Versioned deterministic suggestion schema and validation.
- [x] Candidate title, technical purpose, role, grouping, confidence, reasons, and evidence references.
- [x] Explicit abstention for unsupported, dynamic, or ambiguous entry evidence.
- [x] Shared Flow Lens, HTTP, Context Card, viewer, and agent-context exposure.
- [x] Draft-only handoff into immutable human verification.
- [x] Deterministic evaluation corpus and focused test lane.
- [x] Bounded external-corpus progress and partial-failure reporting.
- [x] Complete local and external verification evidence: 81 local tests, 16/16 fixture relationships, and 92/92 pinned external relationships.
- [x] ADR and current-state documentation audit.

### Iteration 12 — Agent Evidence Trace

Goal: let reviewers and later agents see which versioned Flopeek context, declared action, changed paths, and verification outcome an agent used without storing private reasoning or granting source-write capability.

Status: `completed` for the append/query foundation; opt-in viewer history and an outcome benchmark remain Epic 4 follow-up work.

Implemented evidence: `flopeek-agent-evidence-trace/v1` records append-only `agent-declared` metadata in `.flopeek/agent-evidence-traces.json`. Caller operation IDs make retries idempotent and conflicting reuse fails without overwrite. Context Refs must belong to the current project and resolve as current, stale, or retained historical evidence. Paths are normalized repository-relative values; absolute/traversal paths are rejected. HTTP and MCP share graph-service operations, while agent context advertises the policy and a bounded recent summary window. The MCP append tool cannot write repository source, execute commands, or create human verification; it never requests or automatically captures private reasoning/source contents, and its contract prohibits callers from placing them in outcome summaries.

- [x] Versioned append-only record, store, result, list, and policy schemas.
- [x] Context Ref, evidence/recording graph versions, operation ID, action, changed paths, verification result, actor, and timestamp.
- [x] Idempotent retry and immutable conflict behavior.
- [x] Invalid-store preservation and safe repository-relative path validation.
- [x] Shared graph service, trusted-local HTTP API, MCP read/append tools, and agent-context policy.
- [x] Focused `test:trace` lane plus HTTP/MCP integration coverage.
- [x] Complete local verification evidence: 84/84 tests and 16/16 fixture relationships; the unchanged pinned external corpus remains 92/92 from Iteration 11.
- [x] ADR and current-state documentation audit.

### Iterations 13–21 — Durable understanding and handoff layer

Status: `completed` as nine independently versioned slices.

These iterations are grouped here to keep one roadmap from duplicating their detailed contracts in README and architecture documentation:

- [x] Iteration 13: semantic feedback lifecycle and review queue with original-versus-edited evidence.
- [x] Iteration 14: durable Project, Feature, Flow, and Node Briefs with evidence classes and freshness.
- [x] Iteration 15: deterministic token-budgeted `get_handoff_context` with omissions and progressive evidence depth.
- [x] Iteration 16: portable immutable Handoff Workspace, append-only notes, strict import schema, and foreign-unverified isolation.
- [x] Iteration 17: separately auditable derived artifacts with exact-version reuse and selective invalidation.
- [x] Iteration 18: human-first Project Home, starting points, trust boundaries, and semantic concept search.
- [x] Iteration 19: reproducible legacy handoff quality gates and explicit unavailable agent-outcome classification.
- [x] Iteration 20: opt-in sanitized runtime observation evidence kept outside the static graph.
- [x] Iteration 21: portable human concept tags and deterministic ambiguity abstention.

### Iteration 22 — Central multi-project serve workspace

Status: `completed` for the local hub foundation; cross-project graph edges remain intentionally absent.

- [x] `flopeek serve <project> -g --workspace <id>` starts or joins one user-facing hub port.
- [x] A later activation command adds/selects a project without stopping the running hub or another process.
- [x] Every project retains an independent `projectId`, graph version, watcher, and `.flopeek` tree.
- [x] The viewer exposes a project selector and routes all ordinary API/SSE traffic through the active project.
- [x] Machine-local workspace definitions restore activated project roots and are excluded from portable handoff exports.
- [x] Port fallback is deterministic; `--strict-port` preserves explicit collision failure, and machine-local live registration lets later commands rejoin the same workspace ID on its fallback port.
- [x] Integration tests prove two isolated service graphs behind one stable public port.

### Iteration 23 — Agent proposal, latest-state verification, and semantic memory

Status: `completed` for bounded metadata and human control; no model is embedded or trained.

- [x] MCP/API can append an immutable `agent-proposed` semantic overlay only for a current Flow Context Ref.
- [x] Provider candidates can prefill a human-editable review or verification draft but never replace parser facts or verification.
- [x] The review queue distinguishes deterministic suggestion, agent proposal, human edit, rejection, and verification.
- [x] Verification requests require expected graph version and Flow Context Ref; stale drafts fail with a conflict.
- [x] `get_verified_semantic_memory` exposes current/compatible human verification from `.flopeek/flow-verifications.json` and excludes stale records by default.
- [x] The memory contract states that no model weights are stored and a memory hit cannot auto-verify another flow.

### Iteration 24 — Honest contract visibility and test-run adapter journal

Status: `partial` — narrow Next.js literal contracts, a tested repository-command runner fixture, and explicit machine-local cross-project declarations are complete; consented real-CI integration, privacy review, and automatic multi-service composition remain pending.

- [x] Each Flow Lens exposes HTTP method, route, exact-handler availability, related tests, and explicit request/response schema availability.
- [x] Missing payload or expected-response schema is shown as unavailable rather than synthesized from names.
- [x] A versioned append-only runner-event protocol reports running, passed, failed, or cancelled runs and the current/failing displayed Flow Lens step.
- [x] Events require a current Flow Context Ref, validated step transitions, idempotent operation IDs, and sanitized single-line metadata.
- [x] MCP/API/viewer can read run progress; MCP may append adapter events but cannot execute commands or accept raw logs.
- [x] Extract request/response schemas as parser facts for one narrow adapter: exact Next.js handlers with inline request type literals and returned literal JSON bodies with explicit numeric status.
- [x] Publish a runner-adapter contract fixture that reports current and failing displayed Flow Lens steps without embedding a command.
- [x] Prove the adapter protocol against a repository fixture's own `npm test` command; it preserves a failing assertion while storing only three sanitized loopback events.
- [ ] Validate that protocol against a consented real repository-owned CI command.
- [x] Define machine-local, human-authored cross-project `http-contract` references that require current graph versions and Flow Context Refs, report current/stale/unavailable state, and never merge graphs or create automatic flows.
- [ ] Complete privacy/retention review before enabling automatic event collection.

### Iteration 25 — Bounded Flow Lens contract parity

Status: `completed` for the local cross-surface contract.

- [x] Centralize the default 12-step and maximum 24-step contract without silent clamping.
- [x] Accept the same optional integer `maxSteps` on HTTP and MCP Flow Lens requests.
- [x] Propagate the same limit through Flow Context Card JSON and Markdown generation.
- [x] Keep an expanded viewer's copied Context Card at the currently displayed depth.
- [x] Report requested limit, displayed/source counts, display truncation reason, and source-traversal bound reason.
- [x] Isolate derived-cache records for compact and expanded projections.
- [x] Reject zero, out-of-range, fractional, string-typed MCP, and non-canonical HTTP values with explicit errors.
- [x] Cover core validation, cache isolation, HTTP parity, MCP parity, packet parity, and viewer request propagation.

### Iteration 26 — Portable independent reviewer kit

Status: `completed` for the repository-local review protocol; real multi-provider execution evidence remains a release activity.

- [x] Add optional explicit-invocation skills for Azka, Bono, Cuna, and Dana.
- [x] Add Elda as the next four-letter alphabetical release and stability reviewer.
- [x] Route reviewer domains and preserve Flopeek evidence-class boundaries in `AGENTS.md`.
- [x] Define provider/model/run provenance without pretending persona names prove provider independence.
- [x] Define a strict portable `flopeek-independent-review/v1` JSON Schema.
- [x] Define alpha, beta, stable, and ineligible release gates.
- [x] Validate every skill with the official skill validator.
- [ ] Capture a real four-distinct-provider quorum against one current Flopeek release candidate.

### Iteration 27 — Discovery, R&D, and paired QA roles

Status: `completed` for portable role contracts; execution evidence remains task-specific.

- [x] Add Fara for evidence-aware brainstorming and falsifiable option design.
- [x] Let Fara audit contextual SDLC role coverage and promote only high-relevance recurring gaps through a validated four-letter alphabetical role contract.
- [x] Add Gama for primary-source research and reproducible R&D experiments.
- [x] Add Hadi for automated QA evidence and Iris for observable manual QA evidence.
- [x] Require Hadi/Iris subject parity and agreement when both QA domains are material.
- [x] Keep ideation/research separate from approval through `flopeek-specialist-work-product/v1`.
- [x] Extend independent review artifacts for automated and manual QA provenance.

### Iteration 28 — Standalone portable team baseline

Status: `completed` for the local standalone repository and Flopeek adoption contract; remote publication and multi-project adoption evidence remain separate release work.

- [x] Extract project-agnostic role domains, evidence rules, release gates, and artifact schemas into `portable-sdlc-agent-team`.
- [x] Add a dependency-free cross-platform installer with idempotent AGENTS routing and non-destructive project-context ownership.
- [x] Generate deterministic draft onboarding from repository identity, conventional documents, and declared commands without inventing business purpose.
- [x] Distinguish project-local role promotion from cross-project upstream role proposals.
- [x] Keep Flopeek skills as specialized adapters and record the portable-to-project role mapping in `.agent-team/upstream.json`.
- [x] Add standalone installer/contract tests and Flopeek adoption-contract coverage.
- [ ] Publish the standalone repository to a remote host and replace clone placeholders with its canonical URL.
- [ ] Validate adoption in at least two unrelated projects before promoting any new cross-project role.

### Iteration 29 — Evidence-first Trust Analytics and Product Proof

Status: `completed` for the project-native vertical slice; independently labeled live-repository accuracy remains unavailable by design.

- [x] Add `flopeek-trust-analytics/v1` as a read-only aggregation of parser coverage, explicitly cataloged and bounded static transition evidence, related-test availability, graph/cache freshness, human verification, runtime observations, test runs, semantic feedback, and agent-declared traces.
- [x] Keep every evidence class independent and return `overallScore: null` instead of inventing a project truth score.
- [x] Mark live-repository precision and recall unavailable unless independently labeled ground truth exists for that repository.
- [x] Expose contract-equivalent output through graph service, loopback HTTP, read-only MCP, and the lightweight local viewer.
- [x] Keep portable reviewer roles outside Flopeek runtime and prohibit role/persona names from becoming product evidence.
- [x] Add unit, HTTP, viewer-contract, and MCP quality gates for schema parity and anti-overclaiming behavior.
- [x] Add `flopeek-product-proof/v1` with validated 92-relationship audit evidence, four pinned monorepo performance rows, current-repository facts, capability showcase, reproduction commands, and explicit non-claims.
- [x] Expose **Why Flopeek** through the lightweight viewer, read-only HTTP/MCP, and an explicit `flopeek proof` or trusted-loopback local benchmark action.
- [x] Make README and BENCHMARKS the public evidence path: outcome first, methodology and limitations adjacent, raw machine-readable evidence checked in.
- [ ] Add exportable time-series snapshots only after retention, comparison semantics, and stale-evidence rules are specified.
- [ ] Add release-readiness policies as explicit evidence requirements; do not derive them from a weighted analytics score.

### Iteration 30 — Agent Bootstrap and Integration

Status: `completed` for project-local Codex, Claude Code, Cursor, and Gemini CLI integration; remote ChatGPT integration and package publication remain separate work.

- [x] Add `flopeek-agent-bootstrap/v1` as the provider-independent current graph identity, readiness, coverage, workflow, and evidence-policy contract.
- [x] Expose the same bootstrap through `flopeek bootstrap`, `GET /api/agent-bootstrap`, and read-only MCP `get_agent_bootstrap`.
- [x] Add a versioned platform registry with explicit project-local skill and MCP config paths plus a truthful `remote-only` ChatGPT web boundary.
- [x] Add `flopeek install`, `uninstall`, and `doctor` with JSON output, explicit platform selection, PATH-only detection, dry-run, strict diagnostics, and meaningful failure status.
- [x] Generate and validate one canonical portable Flopeek tool-usage skill that requires graph-first orientation, source fallback, post-edit refresh, repository-owned verification, and explicit evidence limits.
- [x] Preflight all writes; preserve unrelated host configuration; reject malformed, unmanaged, or modified Flopeek content; make reinstall idempotent and uninstall ownership-aware.
- [x] Keep the external developer-role ecosystem outside Flopeek product/runtime and prohibit provider proposals from becoming parser facts or human verification.
- [x] Add unit, contract, HTTP, MCP, and official skill-validator coverage.

Acceptance evidence: a supported host can be configured from a repository with one command; the installed MCP process remains scoped to that repository; every host receives the same bootstrap contract; repeated install is a no-op; conflicts produce no partial skill copy; and uninstall preserves unrelated configuration.

### Iteration 31 — Repository Understanding Benchmark

Status: `completed` for the initial deterministic retrieval suite. Consented human and AI-provider outcome studies remain explicitly `not-run` and require separate future work.

Goal: prove whether Flopeek reduces the time, files, and context required for a person or agent to understand and safely plan a change in an unfamiliar repository.

- [x] Create `benchmarks/orientation-cases.json` with line-ending-normalized tree pins, task prompts, expected target paths, ordered flow steps, related tests, and stale-ref probes.
- [x] Create separate `benchmarks/orientation-baseline.json` and `benchmarks/orientation-flopeek.json` raw per-case outputs; never merge unlike evidence into one score.
- [x] Implement `src/orientation-benchmark.js` and `flopeek evaluate orientation <repository> --cases <file>` with baseline, Flopeek, and combined conditions.
- [x] Measure correct target retrieval, ordered flow-step recall/precision when available, cold/warm time to useful context, files inspected, disclosed estimated context tokens, related-test recall, unsupported-claim availability, and stale-context detection.
- [x] Start with `legacy-handoff`, a TypeScript order fixture, and a Python payment fixture.
- [x] Keep deterministic retrieval, consented human study, and AI-agent study as three independently reported evidence classes; the latter two remain `not-run`.
- [x] Add `test/unit/orientation-benchmark.test.js` and `docs/orientation-benchmark-protocol.md` with scoring, omission, failure, reproducibility, privacy, and non-claim rules.
- [x] Publish raw per-case output and denominators; do not convert fixture accuracy, host timing, unavailable baseline capabilities, or an agent declaration into universal product effectiveness.

Current checked-in evidence: both conditions retrieve 10/10 declared target paths and 3/3 related tests. Flopeek additionally retrieves 14/14 ordered static steps and detects 3/3 stale Context Refs while exposing 13 context files and an estimated 1,158 tokens versus 16 files and 1,304 estimated tokens for the lexical baseline. Current preparation plus retrieval is 1,457.100 ms for Flopeek versus 72.237 ms for the lexical condition on the captured host. The prior Flopeek sample was 4,544.429 ms; repeated synchronous Git metadata commands and eager non-participating parser initialization were removed, producing a host-specific 67.94% reduction. Separate stale-ref validation is 3,416.186 ms and process startup/module load remains unavailable. No universal speed claim is made. Baseline flow order and stale refs are unavailable, not scored as failures. Human and provider studies were not run.

After this iteration: build a showcase repository, then an agent comparison harness, public-alpha clean-room packaging, a real consented user study, and an evidence-based release-readiness page.

### Iteration 32 — Guided Checkout Showcase

Status: `completed` for the local demonstration contract. This iteration is not independent benchmark evidence, a human study, an AI-provider outcome study, runtime verification, or a release gate.

Goal: let a prospective user reproduce Flopeek's strongest current workflow from a clean clone with one command while keeping evidence boundaries and the source-read-only agent surface explicit.

- [x] Add a realistic supported TypeScript checkout repository with a declared primary flow, direct related test evidence, and one deliberate unsupported computed dynamic import.
- [x] Add `flopeek showcase` and `npm run showcase` to validate the manifest, copy the example into a marked temporary workspace, start the normal loopback server with port fallback, and deep-link the primary Flow Lens.
- [x] Add bounded `apply`, `reset`, and `status` actions that accept only a marked showcase workspace and manifest-declared source, remain idempotent at baseline/changed hashes, and refuse diverged content.
- [x] Keep the explicit demonstration mutation in the CLI; do not add arbitrary source writes or shell execution to Viewer, HTTP, or MCP.
- [x] Add an English viewer guide with copyable commands, automatic initial flow focus, and explicit no-target-execution and static-evidence boundaries.
- [x] Connect directly related tests to displayed symbol steps through their containing file IDs without claiming behavioral coverage.
- [x] Add a complete walkthrough covering baseline inspection, Context Card copy, live change, changed contexts, before/current comparison, stale Context Ref, impact, reset, agent workflow, and limitations.
- [x] Add end-to-end coverage for original-example immutability, temporary-copy confinement, Viewer/HTTP/real stdio MCP parity, graph-version advancement, retained comparison, stale resolution, related-test impact, cleanup, and no target execution.

Acceptance evidence: `npm run test:showcase` passes; the committed example receives no `.flopeek` directory; Viewer, HTTP, and MCP share graph identity and Context Ref at one version; the declared change adds the risk-review step and advances the graph; the prior ref resolves stale; and reset restores the baseline source.

After this iteration: build Iteration 33, an agent comparison harness that separately measures provider task outcomes with and without Flopeek. Then pursue public-alpha clean-room packaging, a consented human study, and an evidence-based release-readiness page.

### Iteration 33 — Agent Comparison Harness and Cold-Path Optimization

Status: `completed` for the provider-neutral evaluator and deterministic performance optimization. The checked provider study remains explicitly `not-run`.

Goal: make the cold-orientation cost explainable and materially lower, then provide a trustworthy contract for comparing equivalent supplied provider outcomes with and without Flopeek.

- [x] Profile initial static scans into scope/identity, source analysis, resolver context, and graph assembly without adding transient timing to graph evidence.
- [x] Replace repeated synchronous Git metadata commands with one porcelain-v2 status command plus static Git directory, shallow state, and origin-remote reads.
- [x] Load Python, PHP, Java, and Rust parsers only when a participating file requires them; retain all existing adapter contracts and tests.
- [x] Upgrade orientation evidence to v2 and count repository preparation once, case retrieval once per case, stale-ref validation separately, and process startup/module load as explicitly unavailable.
- [x] Refresh checked orientation evidence through an explicit maintenance command and publish the prior/current host-specific comparison without turning it into a universal speed claim.
- [x] Add `flopeek-agent-comparison-runs/v1` and `flopeek-agent-comparison-report/v1` schemas, a privacy-reviewed empty template, and an explicit `not-run` checked report.
- [x] Add `flopeek evaluate agent-comparison` for operator-supplied paired provider/model sessions using the same pinned case, distinct sessions, uncontaminated conditions, and source-safe metadata.
- [x] Score targets, ordered flow steps when supplied, related tests, stale refs, duration, bounded context, separately reviewed unsupported claims, verification, and optional comparable cost.
- [x] Reject unknown/source-body fields, absolute paths, reused sessions, incomplete pairs, provider/model mismatch, unsupported Flopeek tools, missing consent, and evidence-free reviewed claims or verification outcomes.
- [x] Keep provider execution external and explicit. The harness invokes no provider or target application and never upgrades provider outcomes into parser facts, human verification, or independent provider quorum.
- [x] Add focused CLI, schema, profiling, adapter-regression, public-proof, and contract tests plus English protocols and canonical documentation.

Acceptance evidence: the checked Flopeek preparation-plus-retrieval sample decreases from 4,544.429 ms to 1,457.100 ms on the same bounded host/fixture class; all 14/14 expected flow steps, 10/10 targets, 3/3 related tests, and 3/3 stale refs remain; the checked agent comparison output is exactly `not-run`; synthetic paired records demonstrate deterministic scoring and privacy redaction; and no provider or target process is started by the evaluator.

After this iteration: run a real privacy-reviewed paired provider cohort outside Flopeek, then pursue public-alpha clean-room packaging, a consented human study, and an evidence-based release-readiness page.

### Iteration 34 — Public Alpha Clean-Room Packaging

Status: `completed` for a public-Core candidate tarball and local clean-room contract. npm publication, a real provider cohort, and release-stage approval remain explicitly outside this iteration.

Goal: prove that the exact bounded npm artifact can be installed and used from an empty temporary project without relying on the source checkout, leaking repository-only artifacts, executing target code, or claiming publication/release authority.

- [x] Add explicit repository/homepage/issue metadata and a package `files` allowlist while retaining `private: true`.
- [x] Add `flopeek-package-policy/v1` with required runtime paths, bounded entry/size limits, and rejection of governance, cache, Git, credential, log, source-map, key, certificate, and undeclared content.
- [x] Add `flopeek --version`, `flopeek version`, and `flopeek -v` without scanning a repository.
- [x] Add inventory-only `npm run audit:package` and focused package-policy tests.
- [x] Add `flopeek-clean-room-package-report/v1` and a Windows-safe verifier that packs to a temporary directory, installs with lifecycle scripts disabled, and resolves the installed local binary.
- [x] Verify help, non-strict doctor, `scan --no-cache`, MCP `tools/list`, and `get_agent_bootstrap` against a copied fixture without running its application or tests.
- [x] Fingerprint non-cache fixture content before and after, retain only bounded observations, reject source/log/path/credential leakage from the report, and require complete temporary-state cleanup.
- [x] Keep the checked clean-room evidence outside the package allowlist to avoid a recursive tarball hash.
- [x] Add the package audit and clean-room verifier to the existing Node 20/22 CI matrix without interpreting workflow configuration as a passing remote run.
- [x] Document commands, evidence boundaries, unsupported release claims, and the still-unrun real provider cohort in canonical English artifacts.

Acceptance evidence: `npm run test:package`, `npm run audit:package`, `npm run verify:clean-room`, and the full repository test suite pass; the final tarball contains only allowlisted files within the committed bounds; the installed version matches `package.json`; the copied showcase scans without graph-cache persistence; MCP exposes required context tools; non-cache fixture content remains unchanged; the temporary workspace is removed; and publication remains unattempted/unapproved.

After this iteration: obtain a genuinely uncontaminated privacy-reviewed provider cohort outside Flopeek, then run a consented human orientation study and build an evidence-based release-readiness page. Licensing and npm publication require explicit owner decisions.

### Iteration 35 — Developer-facing product experience

Status: `completed` for the local Viewer, public documentation, and checked documentation assets. Human outcome studies and external provider comparisons remain separate future evidence.

Goal: let a developer understand Flopeek's value, open a useful technical flow, and share the same bounded context with an agent without first reading internal implementation notes.

- [x] Exclude repository-declared oracle files from literal orientation retrieval and disclose every exclusion in the report.
- [x] Reframe the README and public guide around developer tasks, evidence boundaries, and copyable commands.
- [x] Generate compact SVG charts from checked benchmark JSON instead of maintaining hand-entered numbers.
- [x] Improve Cytoscape/Dagre readability with directional focus, non-color node shapes, quieter unrelated edges, and an explicit static-evidence legend.
- [x] Capture sanitized screenshots from the real local Viewer and package the public guide and assets through the strict allowlist.
- [x] Add documentation freshness, screenshot, and package-contract tests.

Acceptance evidence: the direct-repository benchmark cannot read `expectations.json`; generated charts match checked JSON; the Viewer distinguishes incoming, selected, and outgoing context without relying only on color; screenshots contain no real repository path; public documentation and assets survive the package audit and clean-room install; and no chart or screenshot upgrades static evidence into runtime or business truth.

After this iteration: run paired, consented developer and provider studies that measure time to first correct flow, files inspected, unsupported claims, and verified task outcomes. Do not infer those outcomes from deterministic retrieval alone.

### Iteration 36 — Public Core and private overlay boundary

Status: `completed` for the repository-model migration. `badsleepyday/flopeek` is the public canonical Core on `main`; the private overlay is separate and consumes pinned public Core tags. The former private-development-to-public snapshot model has been retired.

Goal: preserve one public Core source of truth while keeping commercial and confidential work in a separate private overlay without copying Core implementation or tests.

- [x] Make public `main` the only long-lived Core source branch and release alpha, beta, release-candidate, and stable channels as immutable tags.
- [x] Enforce typed short-lived SDLC branch names in CI, prohibit tool or agent identity prefixes, and delete contribution branches after merge.
- [x] Create a tagged-release workflow that verifies public source and package evidence before creating the corresponding GitHub Release.
- [x] Define the private overlay as a consumer of immutable public Core tags rather than a mirror, exporter source, or alternative Core branch.
- [x] Retire private-development-to-public export scripts, policies, tests, and documentation from the public Core repository.
- [x] Keep public Core release readiness separate from npm publication approval and from private-overlay work.

Acceptance evidence: `RELEASING.md`, `ARCHITECTURE.md`, `SUPPORT.md`, and this roadmap identify public `main` as canonical; CI rejects non-SDLC and tool-identity branch names; document-contract verification rejects the retired snapshot model; the public release workflow runs from `v*` tags; and the private overlay pins a public immutable tag without copying Core source.

After this iteration: complete the remaining observable stability gate, choose the package and brand identity, then prepare a separately approved npm beta release from a tagged public Core commit.

### Iteration 37 — Private-repository dogfooding safety and entry integrity

Status: `completed` for anonymous read-only scan evidence, targeted product remediation, and advisory role reviews. It is not an independent precision/recall audit, a runtime validation, a provider quorum, or a release approval.

Goal: validate Flopeek against private repository shapes without retaining target code or paths, then resolve evidence-backed safety, meaning, and human-navigation defects before a broader release decision.

- [x] Scan completed target aliases in memory with target execution, graph-cache persistence, and project-identity persistence disabled.
- [x] Retain only anonymous aggregate coverage, graph size, endpoint count, duration, and explicit timeout status in `flopeek-private-dogfood-summary/v1`.
- [x] Correct `--no-cache` so CLI scan and impact do not create `.flopeek/project.json`; add a regression test.
- [x] Restrict HTTP/request Flow Lenses to extracted endpoint facts; controller and route-like nodes without endpoint evidence remain technical-map nodes.
- [x] Give zero-Flow-Lens Viewer states a bounded explanation plus Feature overview and Find code actions.
- [x] Reconcile product, architecture, support, user-guide, package, generated-documentation, and benchmark artifacts; keep private source, machine paths, revisions, Context Refs, logs, and credentials out of checked evidence.
- [x] Collect advisory UI/UX, implementation, system-flow, and documentation reviews. All runs came from one provider family, so the provider quorum is explicitly incomplete.
- [x] Record the broad-workspace initial-scan budget overrun as an open scale finding rather than treating it as accuracy evidence.

Acceptance evidence: [`benchmarks/private-dogfood-summary.json`](benchmarks/private-dogfood-summary.json) records five completed anonymous scans and one explicit 60-second budget overrun; endpoint-free scans retain technical graphs while exposing zero HTTP/request Flow Lenses; the multi-repository sample exposes matching endpoint/Flow-Lens counts; `scan --no-cache` leaves no Flopeek metadata in its temporary regression fixture; `npm run test:docs`, package/public policy checks, and the scanner suite pass.

After this iteration: add a user-configurable initial-scan time budget and workspace discovery strategy, then run a consented human orientation study and an actually independent multi-provider cohort. Do not claim either outcome from this dogfooding evidence.

### Iteration 38 — Stable repository discovery and bounded analysis

Status: `partial`. The shared human/agent scan-outcome slice is current;
filesystem-pass optimization, helper-process portability evidence, and consented
large-monorepo package validation remain.

Goal: make large-repository startup explicit and bounded without ever presenting
an incomplete graph as complete or replacing the last complete cache.

- [x] Add a read-only `flopeek-repository-discovery/v1` contract for candidate
  source, bytes, scope, static manifests, package names, adapter demand,
  diagnostics, declared limits, and an opaque source/resolver-control inventory
  fingerprint.
- [x] Add `flopeek discover` with time, file, and byte bounds, summary/JSON
  output, exit code `2` for bounded discovery, and no metadata write.
- [x] Add `flopeek-bounded-scan-result/v1` for complete,
  partial-by-budget, cancelled, and failed terminal outcomes.
- [x] Analyze only the discovered source plan, re-inventory after analysis, and
  discard the graph when its fingerprint changed.
- [x] Preserve the last complete graph cache byte-for-byte when preflight blocks
  analysis; never promote a partial graph.
- [x] Add exact-limit, fingerprint-change, cancellation, cache-preservation, CLI,
  and no-cache regression coverage.
- [x] Replace the separate discovery/analysis/verification walks with one shared
  immutable discovery plan without weakening mutation detection. Verification
  re-reads planned directories and relevant candidates, not a second broad
  workspace/adapter/manifest discovery report.
- [ ] Prove or qualify Go/.NET helper-process cleanup on Windows, Linux, and macOS.
- [x] Give cache-disabled sessions monotonic source-state identity or disable
  stale Context Ref claims for those sessions.
- [x] Expose one bounded outcome, cached fallback, progress, and cancellation
  contract through server startup, watcher refresh, Viewer/HTTP/SSE, and MCP.
- [x] Prove active HTTP/SSE and MCP cancellation retain one stale-unverified
  complete graph, and reconcile a filesystem event queued during invalidated
  manual bounded analysis.
- [x] Keep rejected repository-switch candidates out of the active SSE outcome,
  and isolate cache-disabled session deltas from durable cache identities.
- [x] Keep candidate-root Viewer state explicit and bind live-watcher regression
  assertions to the exact SSE delta rather than a later filesystem refresh.
- [x] Let a developer explicitly select one validated local package path with
  `--package`; preserve root/ancestor resolver controls, label the resulting
  static subtree in Viewer/HTTP/MCP/agent context, and force a non-promotable
  session-only graph so it cannot overwrite the repository-wide cache.
- [ ] Validate package selection and per-package progress on consented large
  monorepositories; manifest inventory alone is not workspace topology.

Current dogfood observation: Flopeek-on-Flopeek discovery completed with 132
candidate files and a bounded no-cache scan produced a complete 1,257-node,
4,484-edge graph with a matching shared-plan verification within the declared
local limits. These are development
observations, not public performance or accuracy evidence.

Acceptance for the completed iteration requires one shared outcome across human
and agent surfaces, cache preservation under every non-complete state, explicit
omissions, reproducible large-workspace evidence, and no unsupported hard
cancellation or Context Ref freshness claim.

After this iteration: generalize Flow Projections beyond HTTP/request entries
one evidence-backed family at a time, beginning with command and scheduled entry
points, while preserving the same Context Ref, limitation, and human/agent
parity contracts.

### Iteration 39 — Generalized evidence-backed entry flows

Status: `complete` — the versioned entry contract covers narrow literal package scripts, Django management-command declarations, Click/Typer/Flask CLI framework command declarations, and narrow literal node-cron schedules. Django `5.2.5` was scanned at pinned revision `a3b1107a4955bdd994908efb4c6e1d03c281e69f` as production-shaped static evidence.

Goal: project technical flows from supported non-HTTP entry facts without
renaming static topology as runtime, business, or successful execution truth.

- [x] Define `flopeek-static-flow-entry/v1` and retain it in Flow Lens, Context Packet, comparison, and delta evidence.
- [x] Add deterministic command entry points from literal `package.json` scripts with exactly one supported direct runner and one repository-local scanned source target; do not execute the manifest or runner.
- [x] Add framework command declarations without executing configuration.
- [x] Add scheduled entry points only for adapters with direct syntax evidence: module-scope default-import node-cron `schedule()` with a safe literal cron expression and one exact local top-level function target.
- [x] Add a narrow Django management-command entry adapter: a non-private `management/commands/<name>.py` module, one top-level `Command` class directly extending an imported `django.core.management.base.BaseCommand` binding, and one direct `handle` method; retain all other forms as unsupported inventory.
- [x] Add narrow Click, Typer, and Flask CLI adapters: direct Click module decorators, direct top-level `typer.Typer()` receiver decorators, or direct top-level imported `Flask` receiver CLI decorators, each with one direct top-level function target and a default or literal command name; retain dynamic names and indirection as unsupported inventory.
- [x] Preserve the same Flow Context Ref, bounds, ambiguity, comparison,
  verification, Viewer, HTTP, and MCP contracts used by HTTP/request Flow Lens.
- [x] Keep unsupported shell-composed, quoted, flagged, indirect, out-of-repository, and unscanned-target package scripts plus unsupported node-cron expressions/callbacks machine-readable and absent from Flow Lens claims; scheduler initialization, task execution, dynamic dispatch, and other scheduler APIs remain unsupported.
- [x] Keep unsupported Django command forms, app registration, settings loading, command invocation, and execution outside Flow Lens claims.
- [x] Validate each entry family on a pinned fixture and at least one consented
  production-shaped repository before broad support wording.

### Iteration 40 — Dense Viewer renderer and WebGL feasibility

Status: `partial`.

Goal: determine whether a WebGL-backed renderer materially improves dense,
bounded projections without weakening human comprehension or accessibility.

- [x] Pin small, medium, and dense projection fixtures with reproducible node and
  edge counts in `benchmarks/renderer-projection-corpus.json`.
- [ ] Measure load time, interaction latency, fit/focus latency, memory, and
  stable-frame behavior for the current Cytoscape canvas renderer and candidate
  WebGL renderers across genuinely distinct devices. The local Viewer can now
  record bounded Canvas/WebGL construction, fit, focus, stable-frame, and
  browser-memory availability observations, but one browser session is not
  cross-device evidence.
- [ ] Run Azka and Iris readability checks for label legibility, focus direction,
  semantic zoom, keyboard navigation outside the canvas, screenshots, and
  non-color cues.
- [ ] Preserve node IDs, Context Refs, inspector behavior, and selection parity
  across renderer implementations.
- [ ] Reject renderer migration if its only advantage requires rendering an
  unbounded repository graph or hiding evidence labels.
- [x] Keep Canvas as the supported default and make WebGL an explicit bounded-map preview with Canvas fallback (ADR-018); no default-renderer change is approved.

## Next executable sequence — Versioned work continuation

Status: `in progress`, with C1 through C10 complete. C11 is the next
implementation item.

This sequence refines Story 7.6 without creating a second roadmap. Execute it in
order; one focused commit and acceptance gate per item. The exact schemas, files,
surface contracts, tests, non-goals, and suggested commit messages are in
[docs/work-continuation-plan.md](docs/work-continuation-plan.md).

| Item | Status | Outcome |
| --- | --- | --- |
| C1 Canonical baseline synchronization | `done` | Current Delivery Graph/workflow behavior, remaining boundaries, ADR-020, and this execution contract are aligned. |
| C2 Immutable continuation checkpoint core | `done` | Exact current project/Git-or-working-tree/graph baseline composes selected context, handoff, and delivery work in immutable local storage. |
| C3 Checkpoint surface parity | `done` | CLI, HTTP, MCP, and service contracts share one checkpoint identity and freshness result. |
| C4 Planned technical overlay core | `done` | Planned nodes/edges and Plan Refs remain separate from technical graph facts in immutable local storage. |
| C5 Planned overlay surface parity | `done` | CLI, HTTP, and MCP share exact immutable overlay projections and non-redirecting Plan Ref resolution. |
| C6 Explicit Viewer Continue mode | `done` | The opt-in local Viewer overlay uses explicit text, shape, border, opacity, dashed relationships, counts, Plan Refs, and an evidence boundary; factual search, impact, Flow Lens, and parser facts remain unchanged. |
| C7 Append-only manual reconciliation | `done` | CLI, HTTP, MCP, and the trusted local Viewer record/list exact append-only reconciliation projections. Positive outcomes require a human actor and current same-project technical Context Refs; every record remains delivery metadata, not parser fact. |
| C8 Baseline/plan/current comparison | `done` | HTTP, MCP, and the Viewer share one deterministic retained-evidence comparison. It reports plan status without AI matching or concluding that unavailable history means implementation is absent. |
| C9 Read-only branch divergence | `done` | HTTP, MCP, and the Viewer expose bounded local Git/source divergence plus selected Context Ref freshness without mutating refs or the working tree. |
| C10 Bounded agent continuation packet | `done` | HTTP and MCP share one versioned token-bounded packet with baseline, selected current Context Cards, optional exact plan, reconciliation, divergence, limitations, and explicit omissions. |
| C11 Stabilization and dogfooding | `partial` | Public Core CI at `da8a4a2` passed Ubuntu, Windows, and macOS on Node 20 and 22, including clean-room package/MCP verification. A real local stdio-MCP and single-host Viewer observation cover the bounded refresh/comparison journey. Human/accessibility and independent-provider review evidence remain open before this sequence can close. |
| C12 Dependency-aware continuation preflight | `done` | Declared work dependencies have a bounded read-only readiness projection, circular plans are rejected, and built-in implementation entry stops on blocking, unresolved, or unknown local dependency metadata without treating readiness as source or runtime proof. |
| C13 Active-branch Context Git evidence | `done` | A current/stale Context Ref yields bounded local path-touch history from the active branch without checkout, ref mutation, or rationale claims. |
| C14 Git snapshot Context continuity | `done` | CLI, HTTP, and MCP compare a current/stale Context Ref across two static snapshots, preserving exact static identity separately from same-path candidates and never inferring rename, successor, or semantic equivalence. |

### Immediate dogfooding stability gate

Status: `in progress`. This gate takes priority over new product breadth. Its
purpose is to make the existing surfaces dependable enough for repeated
Flopeek-on-Flopeek and supported-language dogfooding; it does not widen any
language, runtime, business-flow, or release claim.

| Gate | Status | Required outcome |
| --- | --- | --- |
| S1 Production module loading | `done` | The history/continuity circular dependency is removed and production CLI/MCP loading is covered. |
| S2 Entry-point regression coverage | `done` | Production CLI and real stdio MCP cover history, Git snapshot comparison, and Git Context continuity import order. |
| S3 Cache hygiene | `done` | Cache retention is inspectable and explicitly prunable; cache-disabled fixture scans do not create new Flopeek metadata. Existing user-owned metadata is preserved. |
| S4 Delivery-document synchronization | `done` | Gate B reconciled roadmap, checkpoint, support claims, and executable E46–E53 evidence at the current dirty baseline; manual Viewer/browser evidence remains separately open in S5. |
| S5 C11 observable stabilization | `partial` | The [six-job public Core matrix](https://github.com/badsleepyday/flopeek/actions/runs/30161751505) passed on Ubuntu, Windows, and macOS with Node 20 and 22. A single-host browser-assisted checkout observation against `beccef32af9b0a978d4463a90806aeb66a8f1a28` exercised keyboard Flow Lens recovery, v1-to-v2 comparison, and v2 stale resolution after reset to v3. Human readability/accessibility, 200%-zoom, touch/cross-browser/cross-device, and explicitly scoped independent-provider evidence remain required. |
| S6 Supported-language dogfooding proof | `done` | A digest-pinned TypeScript, Python, and PHP fixture cohort audits declared static relations, semantic levels, MCP Context Ref retrieval, disposable refresh, and stale resolution without executing targets. It is not production-repository or runtime evidence. |

The mechanical implementation contract is
[docs/stability-semantic-zoom-execution-plan.md](docs/stability-semantic-zoom-execution-plan.md).
Execute it in order; bounded semantic zoom is the first priority feature after
the projection and live-renderer foundations are stable.

| Execution item | Status | Stability outcome |
| --- | --- | --- |
| E46 Production surface recovery | `done` | Git history and continuity now load through real CLI and stdio MCP without the former circular module dependency. |
| E47 Cache hygiene and retention observability | `done` | Local cache size and registered derived-artifact retention are inspectable; dry-run-first pruning is explicitly scoped before storage migration. |
| E48 Bounded view-projection contract | `done` | `flopeek-view-projection/v2` removes silent graph slicing and establishes shared identity, bounds, and omissions. |
| E49 Stable live renderer | `done` | Compatible live refreshes reconcile Cytoscape elements in place and preserve viewport and unchanged-node positions. |
| E50 Bounded semantic zoom v1 | `done` | Deterministic Domain, Feature, Component, and Symbol navigation is available across Viewer, CLI, and MCP; composite derived ids retain every selected ancestor and root files do not become fabricated domains. |
| E51 Flow-first product navigation | `done` | A supported bounded Flow Lens is the primary Viewer journey; Project Home remains explicit and is the no-flow fallback. |
| E52 Evidence readability and observable QA | `done` | Delivered Viewer contract has non-color evidence vocabulary, responsive/reduced-motion safeguards, and a local observable QA test; the separate manual S5 release gate remains open. |
| E53 Supported-language product dogfooding | `done` | A pinned JS/TS, Python, and PHP supported-subset cohort passes audited static flow, semantic zoom, MCP Context Ref, and stale-refresh checks. |

Routine CLI/MCP dogfooding requires S1 through S4. Routine product dogfooding
requires E46 through E52 plus the minimum pinned E53 cohort. S5 remains
required before any beta or stable claim; S6 and E53 are complete for the
declared static cohort.

## Product metrics

| Metric | Initial measurement intent |
| --- | --- |
| Time to first correct critical flow | Compare unassisted repository orientation with Flopeek. |
| Evidence-backed flow-step rate | Every displayed transition should cite stored evidence. |
| Live update latency | Measure save-to-affected-context response, not only parser time. |
| Context staleness detection | Count stale refs caught before agent planning/verification. |
| Verified critical-flow coverage | Track important flows with current human verification. |
| Agent context efficiency | Compare source files/tokens and verified outcome with baseline. |
| Semantic suggestion outcomes | Accepted, edited, rejected, abstained. |
| SDLC evidence completeness | Required evidence present at workflow transitions. |

Targets are set only after a reproducible baseline exists.

## Cross-cutting risks

| Risk | Mitigation |
| --- | --- |
| Attractive but false flow | Evidence refs, knowledge classes, confidence, abstention, raw drill-down. |
| Feature explosion into a generic platform | Enforce [PRODUCT.md](PRODUCT.md) decision guardrails. |
| Large graph/viewer overload | Bounded server-side projections and semantic zoom. |
| Stale agent context | Monotonic graph version and resolvable Context refs. |
| Parser breadth weakens correctness | Adapter contracts, capability metadata, fixtures, audited scopes. |
| Cache corruption/migration loss | Validation, atomic writes, backups, migration tests. |
| ML hides unsupported inference | Deterministic baseline, reasons, held-out evaluation, abstention. |
| SDLC status replaces evidence | Separate Delivery Graph and evidence-gated transitions. |
| Integrations expand authority | Read-only first, scoped permissions, human approval. |
| Slow Agile feedback loop | Split test lanes and set PR timing budget. |

## Change-control policy

A roadmap change must:

1. link to a product job or explicitly change [PRODUCT.md](PRODUCT.md);
2. name its graph domain;
3. identify dependencies and migration impact;
4. define acceptance evidence;
5. preserve trust/privacy invariants;
6. update architecture/support documents when contracts change;
7. avoid documenting exploratory behavior as committed current scope.

No new roadmap document should be created. Product decisions, architecture decisions, support facts, and benchmark evidence belong in their respective canonical documents.
