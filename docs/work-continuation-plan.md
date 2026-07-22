# Versioned work-continuation execution plan

This document is the detailed execution contract for the next Flowpeek Delivery
Graph sequence. `ROADMAP.md` remains the prioritized source of delivery status;
this document makes its continuation sequence mechanical enough for a lower-
cost implementation model to execute one bounded change at a time.

## Baseline

The plan was refined against private development branch `development` at commit
`0aafe20`.

Current reusable foundations:

- project identity, graph version, source revision, and source fingerprint;
- current/stale/historical Context Ref resolution;
- static Git snapshots without working-tree checkout;
- immutable Handoff Workspace versions and portable exports;
- Delivery Graph work records, owner/dependency metadata, planned windows, and
  append-only actual events;
- built-in Agile and Waterfall plus validated local custom workflows;
- evidence-gated local workflow transitions;
- Viewer/HTTP/MCP/CLI Work ledger parity, with a read-only Viewer inspector;
- Cytoscape.js Canvas as the supported Viewer renderer and an experimental
  bounded WebGL preview.

If implementation begins from a later revision, inspect the intervening diff.
Never reset later work to this baseline.

## Product invariants

Every sequence item must preserve these rules:

1. Evidence Graph contains repository and parser facts only.
2. Planned nodes and edges are Delivery/Context metadata, never technical facts.
3. Workflow state cannot prove implementation, tests, approval, release, or
   runtime behavior.
4. Agent proposals cannot create human verification.
5. Context Ref and Plan Ref types are not interchangeable.
6. Positive reconciliation requires current actual Context Refs.
7. Metadata writes are schema-bounded, idempotent, atomic, and preserve an
   invalid prior store rather than replacing it.
8. Stored metadata excludes source bodies, raw logs, credentials, absolute
   machine paths, private reasoning, shell access, and target execution.
9. Viewer, HTTP, CLI, and MCP call the same domain services.
10. Planned overlays are opt-in; the default Viewer remains factual.
11. Missing retained evidence is unknown or unavailable, not evidence of
    absence.
12. No AI/ML matching is added before a reviewed manual reconciliation dataset
    and held-out evaluation exist.

## Sequence policy

- Complete one sequence item per focused commit.
- Write the input/output contract before implementation.
- Run its focused tests and `npm run test:fast` before committing.
- Run `npm run test:full` at surface-parity milestones and final stabilization.
- Update current/target documentation in the same commit series.
- Record reproducible Flowpeek-on-Flowpeek observations under the dogfooding
  protocol. Do not silently remediate unrelated findings.
- Do not declare an item complete from prose or model confidence. Its tests and
  acceptance conditions must be present.

## C1 — Canonical baseline synchronization

Status: `complete` when this plan, ADR-020, and the canonical current/target
status corrections are committed.

Files:

- `ROADMAP.md`
- `ARCHITECTURE.md`
- `PRODUCT.md`
- `SUPPORT.md`
- `docs/adr/ADR-020-versioned-work-continuation.md`
- `docs/work-continuation-plan.md`

Acceptance:

- Delivery Graph and workflow foundations are no longer described as merely
  planned.
- Viewer editing, checkpoint controls, read-only branch-divergence analysis,
  and external integrations remain explicitly non-current; append-only manual
  reconciliation and comparison remain delivery metadata rather than
  implementation proof.
- `npm run check:docs`, `npm run check:support`, and `npm run test:docs` pass.

Suggested commit: `docs: align work continuation with delivery baseline`

## C2 — Immutable continuation checkpoint core

Status: `complete`.

Add:

- `src/continuation-checkpoint.js`
- `test/unit/continuation-checkpoint.test.js`
- `.flowpeek/delivery/continuation-checkpoints.json` as runtime-local storage,
  never as a committed generated artifact.

Define `flowpeek-continuation-checkpoint/v1` with:

- idempotent `operationId` and immutable content fingerprint;
- project identity;
- baseline derived from the current graph: source-basis kind, Git revision,
  branch, dirty state, source fingerprint, and graph version;
- optional Handoff Workspace ID;
- bounded existing Delivery Graph work-record IDs;
- disjoint completed and remaining work-record ID sets;
- at least one same-project selected Context Ref;
- bounded portable constraints, acceptance criteria, and unresolved questions;
- creator identity/class, timestamp, supersession, and `delivery-plan` evidence
  class.

Caller input must include `expectedGraphVersion`; reject mismatch. The service
derives the baseline and must not accept caller-manufactured Git/source values.

Acceptance:

- same operation and same input replay idempotently;
- same operation and different input fails;
- cross-project, future, malformed, or empty Context Ref selection fails;
- unknown work/handoff references fail;
- completed and remaining sets cannot overlap;
- invalid prior JSON remains untouched;
- atomic-write behavior follows existing graph-cache conventions;
- focused test and `npm run test:fast` pass.

Implemented boundary: the core is local storage and service-only. Viewer, HTTP,
MCP, and CLI checkpoint surfaces remain C3 work.

Suggested commit: `feat: add immutable continuation checkpoints`

## C3 — Checkpoint surface parity

Status: `complete`.

Update:

- `src/graph-service.js`
- `src/server.js`
- `src/mcp.js`
- `src/cli.js`
- `scripts/run-tests.js`
- `test/unit/continuation-surfaces.test.js`
- `test/scanner.test.js`

HTTP:

- `GET /api/continuation-checkpoints`
- `GET /api/continuation-checkpoint?id=...`
- `POST /api/continuation-checkpoints` through the trusted local mutation gate

MCP:

- `list_continuation_checkpoints`
- `get_continuation_checkpoint`
- `create_continuation_checkpoint` as bounded metadata write

CLI:

- `flowpeek continue list <repository>`
- `flowpeek continue show <repository> --checkpoint <id>`
- `flowpeek continue checkpoint <repository> --input <json-file>`

Acceptance:

- all surfaces report the same project, graph, checkpoint, and freshness state;
- read-only listing creates no metadata;
- MCP schemas reject source/log/path/credential/private-reasoning fields;
- MCP `tools/list` contains the exact new contracts;
- focused tests, `test:contracts`, `test:fast`, and `test:full` pass.

Implemented boundary: CLI, HTTP, and MCP share the immutable checkpoint service
and freshness result. The Viewer remains read-only for the Work ledger and has
no checkpoint controls; planned overlays remain C4 work.

Suggested commit: `feat: expose continuation checkpoint contracts`

## C4 — Planned technical overlay core

Status: `complete`.

Add:

- `src/planned-overlay.js`
- `test/unit/planned-overlay.test.js`
- local `.flowpeek/delivery/planned-overlays.json` storage

Define `flowpeek-planned-overlay/v1` as an immutable version tied to one
continuation checkpoint. Planned node kinds are bounded to endpoint, service,
module, function, database, queue, external, test, boundary, and other.

Planned relationships are bounded to:

- `planned_after`
- `planned_to_call`
- `planned_to_use`
- `planned_to_extend`
- `planned_to_replace`
- `planned_to_publish`
- `planned_to_subscribe`
- `planned_to_verify`

Endpoints are typed as either a same-overlay planned-node ID or a checkpoint-
selected Context Ref. Reject factual edge names such as `calls`, `imports`,
`reads`, `writes`, `uses`, and `tested_by`.

Define a separate Plan Ref:

```text
fpp://local/<project-id>/<checkpoint-id>/<planned-node-id>@<overlay-version>
```

Acceptance:

- planned entities never enter `graph.nodes`, `graph.edges`, Flow Lens, impact,
  parser coverage, or factual search;
- Context Ref and Plan Ref parsers reject each other's values;
- planned anchors remain bounded to checkpoint-selected context;
- portable relative candidate paths are optional; absolute paths fail;
- storage idempotency, immutability, invalid-store preservation, and limits are
  tested;
- focused test and `test:fast` pass.

Implemented boundary: planned overlays and Plan Refs are immutable local
Delivery/Context metadata only. No CLI, HTTP, MCP, Viewer, factual graph,
Flow Lens, impact, parser-coverage, or technical-search surface consumes them
until C5/C6 work is complete.

Suggested commit: `feat: add planned technical overlay contracts`

## C5 — Planned overlay surface parity

Status: `complete`.

Expose shared services through:

- HTTP list/get/create and Plan Ref resolution;
- MCP `list_planned_overlays`, `get_planned_overlay`, `resolve_plan_ref`, and
  `create_planned_overlay`;
- CLI `flowpeek continue plan list|show|create|resolve`.

Acceptance:

- a stale planned anchor remains explicit and never silently redirects;
- no factual endpoint accepts Plan Ref as Context Ref;
- no planned endpoint accepts Context Ref as Plan Ref;
- HTTP/MCP/CLI outputs preserve one overlay identity;
- focused, contract, fast, and full tests pass.

Suggested commit: `feat: expose planned overlay references`

Implemented boundary: local CLI, HTTP, and MCP share one immutable overlay
projection and exact Plan Ref resolution. The resolver returns the retained
planned node with an explicit current, stale, future, unavailable, or
unresolved state; it never redirects a plan to a current technical Context Ref,
source node, or another overlay. The Viewer remains C6 work.

## C6 — Explicit Viewer Continue mode

Status: `complete`.

Update `public/index.html`, `public/app.js`, `public/styles.css`, and Viewer
contract tests. Reuse Cytoscape.js; do not add a second graph library.

Requirements:

- add an explicit Continue mode and overlay selector;
- keep planned overlay disabled in ordinary factual views;
- render planned nodes with text badge, shape/border/opacity differences, and
  planned edges with dashed style plus relationship labels;
- show technical and planned counts separately;
- exclude planned nodes from factual search and impact by default;
- inspector states `Delivery plan` and `Not found in source`, and exposes Plan
  Ref, checkpoint, responsibility, acceptance criteria, anchors, and freshness;
- copy actions expose Plan Ref and bounded continuation context;
- status remains understandable without color and keyboard focus remains
  observable;
- WebGL remains experimental and gains no new performance claim.

Acceptance:

- overlay-off output preserves the existing graph contract;
- screenshot/manual review demonstrates solid versus planned distinction;
- Viewer-focused, accessibility contract, fast, and full tests pass;
- any renderer evidence gap remains recorded under DF-022.

Suggested commit: `feat: render explicit planned nodes in continue mode`

Implemented boundary: the local Viewer keeps its ordinary technical map factual
by default. A user must explicitly enable Continue mode and select one retained
overlay before synthetic planned nodes and planned relationships render. The
overlay has text, shape, border, opacity, and dashed-line differences; its
inspector exposes its Plan Ref, checkpoint freshness, responsibility, acceptance
criteria, anchors, and a bounded delivery-plan context. It does not enter source
search, impact, Flow Lens, parser coverage, or technical-node identity.

## C7 — Append-only manual reconciliation

Status: `complete`.

Add `src/plan-reconciliation.js`, unit tests, and local
`.flowpeek/delivery/reconciliations.json` storage.

Define `flowpeek-plan-reconciliation/v1` with one Plan Ref, zero/one/many actual
Context Refs, actor identity/class, evidence references, timestamp,
supersession, and one outcome:

- `confirmed-implemented`
- `partially-implemented`
- `implemented-differently`
- `not-the-same`
- `superseded`
- `unresolved`

Positive implementation outcomes require current actual Context Refs. Agent-
authored records remain proposals and cannot be represented as human
confirmation. One-to-many and many-to-one mappings are valid.

Expose list/get/record through shared HTTP, MCP, CLI, and trusted local Viewer
actions.

Acceptance:

- stale/future/cross-project actual references cannot support a positive result;
- reconciliation never changes parser evidence or planned overlay content;
- append-only supersession and invalid-store preservation are tested;
- human and agent author classes remain visible;
- focused, contract, Viewer, fast, and full tests pass.

Suggested commit: `feat: add manual plan reconciliation`

Implemented boundary: `flowpeek-plan-reconciliation/v1` records are immutable
local Delivery/Context metadata stored separately from planned overlays and the
technical graph. CLI, HTTP, MCP, and the trusted local Viewer share one
projection. A positive outcome requires a human actor and one or more current,
same-project technical Context Refs; agent/tool records remain explicit
proposals. Reconciliation never creates or rewrites source nodes, parser facts,
Flow Lens steps, impact results, test proof, runtime observations, or approval
authority.

## C8 — Baseline/plan/current comparison

Status: `complete`.

Add `src/continuation-comparison.js` and tests. Produce
`flowpeek-continuation-comparison/v1` deterministically from checkpoint evidence,
planned overlay, current resolvers, and current reconciliation.

Per-plan statuses:

- `planned-only`
- `reconciled`
- `partial`
- `implemented-differently`
- `superseded`
- `anchor-stale`
- `unresolved`

Expose `get_continuation_comparison` through HTTP and MCP and provide a
coordinated Baseline/Planned/Current Viewer view. Do not claim full historical
reconstruction: unavailable retained evidence stays partial or unknown.

Acceptance:

- Viewer and MCP share exact status and limitations;
- missing history never becomes missing implementation;
- no AI/similarity heuristic participates;
- focused, contract, Viewer, fast, and full tests pass.

Suggested commit: `feat: compare baseline plan and current context`

Implemented boundary: `flowpeek-continuation-comparison/v1` is a read-only,
deterministic projection of one exact retained checkpoint and planned overlay,
the current graph, and append-only reconciliation records. HTTP, MCP, and the
selected-node Continue-mode Viewer panel share this projection. It reports
retained-evidence statuses only; it does not reconstruct missing history, infer
missing implementation, use AI/similarity matching, create source facts, or
rewrite reconciliation or parser evidence.

## C9 — Read-only branch divergence

Status: `complete`.

Add `src/continuation-divergence.js` and Git-fixture tests. Compare the checkpoint
baseline with local current Git/source state without network, checkout, merge,
rebase, or branch mutation.

Statuses:

- `exact`
- `working-tree-changed`
- `ahead`
- `behind`
- `diverged`
- `commit-unavailable`
- `non-git`
- `unknown`

Expose `get_checkpoint_divergence` through HTTP/MCP and a Viewer warning with
bounded changed-path and selected-context freshness evidence. Divergence is not
called a merge conflict without conflict evidence.

Acceptance:

- temporary Git fixtures cover exact, ahead, behind, diverged, dirty, missing
  revision, and non-Git states;
- no command changes the target working tree or refs;
- focused, contract, fast, and full tests pass.

Suggested commit: `feat: detect continuation baseline divergence`

Implemented boundary: `flowpeek-continuation-divergence/v1` performs only
read-only local Git and source inspection for one retained checkpoint. HTTP,
MCP, and the selected-node Continue-mode Viewer share its bounded path and
selected-context freshness result. It never fetches, checks out, merges,
rebases, mutates refs, reconstructs historical code, or calls divergence a
merge conflict without separate conflict evidence.

## C10 — Bounded agent continuation packet

Status: `complete`.

Add `src/continuation-context.js` and tests. Expose
`get_continuation_context` through MCP and HTTP. The packet includes bounded
checkpoint identity, current graph identity, divergence, selected Context
Cards, work records, planned overlay, reconciliation, acceptance criteria,
limitations, omissions, and the existing explicit token estimator.

Recommended agent sequence:

1. resolve checkpoint and divergence;
2. stop when required anchors are unresolved;
3. inspect current selected Context Cards;
4. treat Plan Refs only as planned intent;
5. edit through the host's existing authorized workspace tools;
6. call `refresh_graph` and `get_changed_contexts`;
7. compare baseline/plan/current;
8. record only an agent reconciliation proposal;
9. leave human confirmation unresolved.

Acceptance:

- packet is deterministic, bounded, versioned, and reports omissions;
- no source body, absolute machine path, shell, credential, or execution surface
  is introduced;
- generated provider integration skill documents the same sequence;
- focused, skill-contract, MCP-contract, fast, and full tests pass.

Suggested commit: `feat: provide bounded continuation context to agents`

Implemented boundary: `flowpeek-continuation-context/v1` is a deterministic
character-budgeted packet for one exact retained checkpoint and optional exact
planned overlay. HTTP and MCP share current Context Ref resolution, divergence,
linked delivery metadata, omissions, and safe next steps. It excludes source
bodies, shell access, credentials, target execution, machine paths, and any
claim that a plan or reconciliation is source proof.

## C11 — Stabilization, dogfooding, and documentation

Status: `in progress` after C10. The automated real-stdio-MCP journey is
covered; manual observable and independent-provider review evidence remains
open.

Exercise Flowpeek on Flowpeek:

1. create one current checkpoint;
2. attach Handoff Workspace, work records, and Context Refs;
3. create a small planned overlay;
4. consume the continuation packet through real stdio MCP;
5. make a bounded source change through the host, not Flowpeek;
6. refresh the graph and inspect changed context;
7. reconcile manually;
8. verify stale checkpoint and divergence behavior;
9. retain reproducible dogfooding observations.

Required verification:

```text
npm run check:docs
npm run check:support
npm run test:fast
npm run test:contracts
npm run test:viewer
npm run test:full
npm run test:public-source
npm run test:package
```

Use Azka for planned-overlay readability, Bono for storage/surface/security,
Cuna for graph-domain semantics, Dana for public claims, Hadi for automated QA,
and Iris for the observable continuation journey. Reviews from one provider
remain one provider family and do not establish an independent-provider quorum.

Do not silently remediate open unrelated dogfooding findings unless they block
these acceptance conditions or weaken a product invariant.

Suggested commits remain separated by purpose, for example:

- `test: cover versioned work continuation`
- `docs: document versioned work continuation`
- `fix: remediate verified continuation findings`

Automated implementation evidence: `test/work-continuation-journey.test.js`
uses a disposable repository and a real stdio MCP client. It creates one
checkpoint, work record, and planned overlay; reads a bounded continuation
packet; applies a host-owned source change; refreshes; observes changed and
stale context; then records an explicitly human reconciliation. The MCP client
has no source-write operation. This demonstrates the product contract without
claiming a runtime flow, independent-provider review, or manual Viewer
usability result.

## C12 — Dependency-aware continuation preflight

Status: `complete` for the deterministic local contract. It is independent of
the still-open C11 manual and provider evidence track.

Work records already retained declared dependency IDs, but a person or agent
could not determine whether a dependency was missing, active, ready, or outside
the workflow semantics before beginning implementation. This item adds a
read-only `flowpeek-work-dependency-status/v1` projection.

Contract:

- reject circular dependency records at create/update time while allowing a
  plan to name a record not yet created;
- classify each declared dependency as `ready`, `blocking`, `unresolved`, or
  `unknown` from local work-record and workflow metadata only;
- treat `released`/`observing` in Agile and `release`/`observing` in Waterfall
  as explicit delivery-ready metadata states; a terminal custom state is
  visible as ready, while a non-terminal custom state remains unknown;
- refuse only built-in transition into `implementing` or `implementation` when
  one declared dependency is not ready; custom workflow transitions stay
  explicit rather than receiving an invented policy;
- expose the same single-record projection through HTTP, MCP
  `get_work_dependency_status`, and `flowpeek work dependencies`;
- provide a bounded HTTP list projection for a future/read-only ledger view.

Evidence boundary:

```text
dependency readiness
!= source implementation
!= test success
!= approval authority
!= release proof
!= runtime behavior
!= external system state
```

Acceptance evidence:

- `test/unit/delivery-graph.test.js` rejects an indirect circular dependency;
- `test/unit/workflow-engine.test.js` demonstrates blocked built-in
  implementation entry, then a metadata-ready dependency that permits entry;
- `test/unit/delivery-surfaces.test.js` exercises HTTP, MCP registration, and
  CLI projections;
- the projection has no source body or machine-path field and the limitation is
  emitted by every available result.

Suggested commit: `feat: add dependency-aware continuation preflight`

## C13 — Active-branch Context Git evidence

Status: `complete` for the bounded local evidence contract. It is independent
of full-history archaeology and the still-open C11 manual/provider evidence
track.

Add `flowpeek-active-branch-git-evidence/v1` for one exact current or stale
Context Ref. Resolve the Context Card first, derive only its current safe
repository-relative paths, then list a bounded number of commits reachable from
the current attached branch `HEAD` that touched each path.

Expose one shared projection through:

- `GET /api/active-branch-git-evidence?contextRef=...&limit=...`;
- MCP `get_active_branch_git_evidence`;
- `flowpeek git-evidence <repository> --context-ref <fp://local/...>`.

Contract:

- never checkout, fetch, merge, rebase, mutate refs, or execute target code;
- return `unavailable` for non-Git targets, detached `HEAD`, missing `HEAD`,
  unresolved/historical refs, or Context Cards without safe current paths;
- inspect only commits reachable from current branch `HEAD`, with at most 50
  commits per path and no rename-following;
- omit source bodies, author identity, raw Git output, credentials, machine
  paths, and private reasoning;
- state that path touch is not proof of symbol introduction, original
  rationale, runtime behavior, review, test success, release state, or absence
  of earlier evidence.

Acceptance evidence:

- disposable Git fixtures demonstrate bounded current-path evidence, no target
  Git mutation, unresolved/non-Git/detached abstention, and source exclusion;
- HTTP, MCP, and CLI return the same path evidence for one Context Ref;
- exact MCP inventory, fast, full, documentation, support, public-source, and
  package gates pass.

Suggested commit: `feat: add active-branch Context Git evidence`

## C14 â€” Git snapshot Context continuity

Status: `complete` for a bounded static continuity projection. It does not
replace historical-card reconstruction, all-ref archaeology, or the still-open
C11 manual/provider evidence track.

`flowpeek-git-context-continuity/v1` resolves one current or stale Context Ref,
then creates or reuses static snapshots for two selected local Git commits. It
reports exact static node/flow identity separately from bounded nodes with the
same current repository-relative paths.

The shared read-only contract is available through:

- `GET /api/git-context-continuity?contextRef=...&from=...&to=...`;
- MCP `get_git_context_continuity`;
- `flowpeek git-continuity <repository> --context-ref <fp://local/...> --from <ref> --to <ref>`.

Contract:

- never checkout, fetch, merge, rebase, mutate refs, or execute target code;
- return `unavailable` for unresolved/historical refs, Context Cards without
  safe current paths, or unavailable local snapshots;
- return exact static identity presence independently from same-path candidates;
- never follow renames, infer successors, reconstruct a historical Context
  Card, or treat a candidate as an implementation, rationale, semantic, test,
  release, or runtime match;
- omit source bodies, author identity, credentials, raw Git output, machine
  paths, and private reasoning.

Acceptance evidence:

- disposable Git fixtures cover exact flow identity, same-path candidates,
  unavailable Context Refs/snapshots, source exclusion, and target Git status;
- HTTP, MCP, and CLI return the same semantic snapshot projection;
- exact MCP inventory, fast, full, documentation, support, public-source, and
  package gates pass.

Suggested commit: `feat: compare Context Refs across Git snapshots`

## Deferred until manual evidence exists

- automatic ghost-node materialization;
- AI/ML reconciliation matching;
- automatic Git fetch, checkout, merge, or rebase;
- Git-hosting, tracker, CI, deployment, or observability writes;
- generic project-management board behavior;
- arbitrary historical Context Card reconstruction;
- cross-repository planned-flow inference;
- automatic approval or release decisions.
