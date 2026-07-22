# Stability and semantic-zoom execution contract

This document is the mechanical execution contract for making Flowpeek stable
enough for repeated product dogfooding before product breadth expands. It also
makes bounded semantic zoom the first priority product feature after the core
context and Viewer lifecycle are stable.

`ROADMAP.md` remains the single prioritized delivery source. This document does
not create a second roadmap. It defines the required order, contracts,
acceptance evidence, stop conditions, and handoff format for the stability
sequence summarized in the roadmap.

## Baseline and rebase rule

This plan was prepared against private development branch `development` at
commit `8d4414a`.

Known baseline facts:

- the full automated suite passed 292/292 and the package lane passed 7/7;
- the documented production `flowpeek history` entry point fails because of a
  circular module dependency even though the unit-oriented suite passes;
- the current Viewer destroys and recreates Cytoscape for a graph refresh;
- dependency projection silently slices its relationship list to 36 entries;
- current overview grouping is a small fixed feature classification rather than
  a navigable repository/domain/feature/component/symbol hierarchy;
- graph persistence is validated JSON with a current full graph, monotonic
  graph version, 40 adjacent deltas, optional Git snapshots, and immutable
  derived artifacts;
- Flowpeek-on-Flowpeek graph v629 had 190 `.flowpeek` files using 23,240,971
  bytes, including 141 derived artifacts using 7,283,478 bytes;
- exact derived-artifact hits require the current graph version and source
  fingerprint, so dependency-unaffected artifacts are not yet promoted safely
  across versions;
- an existing untracked fixture `.flowpeek` directory must be treated as
  user-owned state until the responsible test path is reproduced and contained.

If implementation begins from a later revision:

1. fetch and rebase onto the current `development` baseline;
2. inspect every intervening change touching the modules or contracts named by
   the next execution item;
3. rerun the item's preflight command;
4. retain later valid work instead of resetting to this commit;
5. update the current checkpoint with the actual baseline before editing.

## Required outcome

At the end of this sequence, a person must be able to:

```text
open a repository
  -> see bounded project domains
  -> choose a feature or supported entry flow
  -> zoom to components and exact symbols
  -> inspect visible evidence and omissions
  -> retain focus while source refreshes
  -> compare changed static context
  -> copy the same versioned context to an agent
```

An agent must be able to request the same bounded projection, level, graph
version, evidence classes, limits, and omissions without receiving the browser
canvas or source bodies.

## Stable-context definition

Flowpeek context is stable only when all five layers agree:

| Layer | Stability requirement |
| --- | --- |
| Evidence | Parser facts are deterministic for the declared adapter subset, carry evidence/coverage metadata, and never become runtime or business claims. |
| Graph state | Project identity, source basis, material fingerprint, graph version, cache promotion, and adjacent delta refer to one complete validated graph. |
| Projection | The selected level, focus, bounds, displayed catalog, omitted catalog, ordering, and evidence classes are explicit and reproducible. |
| View | Refresh preserves compatible focus, selection, semantic level, pan/zoom, and unchanged-node positions; removed or stale context is disclosed. |
| Handoff | Viewer, HTTP, CLI, and MCP resolve the same current/stale Context Ref and never silently redirect a stale identity or convert a Projection Ref into parser fact. |

Passing only parser tests or only rendering a graph does not satisfy stable
context.

## Product invariants

Every execution item must preserve these rules:

1. Evidence Graph contains repository and parser facts only.
2. Static relationships are not runtime order, control flow, successful
   behavior, business intent, or original rationale.
3. Missing or truncated evidence is `unknown`, `omitted`, or `unavailable`, not
   proof of absence.
4. Aggregate domain/feature/component nodes are derived projection entities,
   never technical source nodes.
5. Technical Context Refs and projection-level references are different types
   and are never interchangeable.
6. A stale or removed Context Ref is never redirected silently to a same-path or
   similarly named candidate.
7. Planned nodes and edges remain Delivery Graph metadata and are excluded from
   factual node, edge, relationship, and coverage counts.
8. AI, ML, embeddings, and generated wording do not choose factual hierarchy,
   create parser edges, or approve grouping in this sequence.
9. Every server projection is bounded before transmission. The browser does not
   receive an unbounded graph and hide most of it locally.
10. Every truncation reports matching, displayed, and omitted counts plus the
    bound that caused truncation.
11. Viewer, HTTP, CLI, and MCP use the same domain service and projection
    schema.
12. Cache reuse is never silent across incompatible project, schema, graph,
    source, dependency, topology, or artifact-integrity bases.
13. Invalid prior cache or metadata is preserved and reported; it is not
    overwritten as a repair shortcut.
14. The target repository is not executed by scanning, projection, semantic
    zoom, cache inspection, or Viewer navigation.
15. Repository and UI artifacts remain English.

## Sequence and completion policy

Execute E46 through E53 in order. E50 semantic zoom is the first priority
feature, but E48 and E49 are hard prerequisites because semantic zoom cannot be
stable on a silently truncated projection or a renderer that destroys the
current mental map.

| Item | Status | Hard dependency | Outcome |
| --- | --- | --- | --- |
| E46 Production surface recovery | `done` | Current baseline | Git history and continuity load without cycles through real CLI and stdio MCP. |
| E47 Cache hygiene and retention observability | `done` | E46 | Cache growth and registered-artifact retention are inspectable; pruning is explicit, dry-run capable, and bounded. |
| E48 Bounded view-projection contract | `done` | E46 | Every view reports exact basis, bounds, displayed catalog, and omissions through shared surfaces. |
| E49 Stable live renderer | `done` | E48 | Refresh updates compatible Cytoscape elements without discarding focus or viewport. |
| E50 Bounded semantic zoom v1 | `done` | E48, E49 | Domain, feature, component, and symbol projections form one deterministic navigable hierarchy; composite derived ids retain each selected ancestor and root files remain in the Project grouping. |
| E51 Flow-first product navigation | `done` | E50 | Project Home, flow selection, hierarchy navigation, and raw evidence form one understandable journey. |
| E52 Evidence readability and observable QA | `done` | E49-E51 | Automated evidence vocabulary, responsive behavior, and keyboard-described alternatives are verified; manual review remains a separate explicit S5 gate. |
| E53 Supported-language product dogfooding | `done` | E46-E52 | JS/TS plus two non-JS supported subsets pass the scoped static product journey on source-digest-pinned fixtures. |

An item becomes `in progress` only when its baseline, responsible branch, and
preflight result are recorded. It becomes `done` only when every acceptance
condition and required verification lane passes. A model answer, local visual
impression, or checked checkbox is not completion evidence.

Use one focused implementation commit and, when useful, one separate focused
test/documentation commit per item. Do not combine unrelated parser breadth,
storage migration, or SDLC features with this sequence.

## Required verification lanes

| Lane | When required | Minimum command or evidence |
| --- | --- | --- |
| Focused unit/contract | Every item | Item-specific `node --test` files. |
| Fast repository gate | Every implementation commit | `npm run test:fast`. |
| Full repository gate | E46, E48, E49, E50, E52, E53 | `npm test`. |
| Documentation gate | Contract or support changes | `npm run test:docs`, `npm run check:docs`, `npm run check:support`. |
| Package gate | Runtime/package/dependency changes | `npm run test:package`. |
| Production entry point | E46 and affected later items | Spawn the installed/source CLI and real stdio MCP rather than importing only domain modules. |
| Viewer delivery assertion | E49-E52 | Automated shipped-asset and local surface contracts; not a substitute for manual browser observation. |
| Manual Viewer review | E49-E53 | Current Azka and Iris artifacts or an explicitly incomplete gate. |
| Dogfooding observation | Every item exposing a reproducible issue | Append a schema-valid `.agent-team/dogfooding-findings.json` record. |

## E46 - Production surface recovery

**Completed 2026-07-22.** Git topology comparison now depends on the isolated
`graph-delta` module rather than the high-level graph service. A real CLI
history command and a real stdio MCP process both exercise the import order
that previously exposed the cycle; both complete without a circular-module
warning or an unavailable delta function.

### Objective

Restore the documented Git history and continuity entry points and prevent a
safe unit-test import order from hiding a broken production import order.

### Required changes

- remove the `history -> graph-service -> git-context-continuity -> history`
  cycle;
- move graph-delta comparison or Git snapshot primitives into lower-level
  modules that do not import `graph-service.js`;
- keep service composition one-way: storage/analysis primitives -> domain
  services -> CLI/HTTP/MCP;
- make Node circular-dependency warnings fail the production smoke tests;
- exercise `history`, snapshot creation/comparison, and Git Context continuity
  through actual CLI and stdio MCP process boundaries.

### Candidate files

- `src/history.js`
- `src/graph-service.js`
- `src/git-context-continuity.js`
- `src/cli.js`
- `src/mcp.js`
- a new lower-level graph-delta or Git snapshot module if required;
- production-entry smoke tests under `test/unit/` or `test/integration/`.

### Acceptance

- `flowpeek history <fixture> --from <ref> --to <ref>` exits zero;
- snapshot and Git-continuity CLI paths exit zero;
- real stdio MCP can list and call snapshot comparison and Context continuity;
- stdout remains protocol-safe and stderr contains no circular-dependency
  warning;
- existing graph-delta, history, server, CLI, and MCP contracts pass;
- `npm test` and `npm run test:package` pass.

### Stop conditions

Stop and mark E46 blocked if the proposed fix changes graph semantics, Context
Ref resolution, Git refs, or working-tree content merely to break the cycle.

Suggested commits:

```text
fix: restore production Git history surfaces
test: cover production CLI and MCP module loading
```

## E47 - Cache hygiene and retention observability

**Completed 2026-07-22.** Session-only scans now mark all derived artifacts as
cache-disabled, preventing Flow Lens retrieval from writing fixture metadata.
`flowpeek cache status` measures local metadata without source reads, while
`flowpeek cache prune --dry-run` previews registered, old derived artifacts and
`cache prune` removes only that exact reviewed set. Graph/state/history/delta,
delivery, verification, runtime, and unregistered files remain outside its
destructive scope. HTTP and MCP expose the same read-only hygiene projection.

### Objective

Make long-lived local dogfooding inspectable and bounded before replacing JSON
storage or claiming cross-version context reuse.

### Required changes

- reproduce which verification path leaves fixture `.flowpeek` state;
- run cache-writing fixture tests in explicit temporary copies or remove only
  state created and owned by that exact test;
- never delete a repository user's pre-existing `.flowpeek` directory;
- add one read-only cache-status contract containing total/current/stale counts,
  bytes, delta retention, history count, and artifact categories;
- add a dry-run-first cache-prune contract with an explicit retention policy;
- retain current graph/state/project identity, verification, handoff, Delivery
  Graph, runtime observations, and Git snapshots unless the user explicitly
  selects their category;
- add bounded derived-artifact retention and manifest cleanup;
- measure safe cross-version artifact promotion separately. Do not implement it
  until dependency paths, topology compatibility, source basis, schema, and
  integrity checks are sufficient.

### Initial retention contract

| Artifact | Initial policy |
| --- | --- |
| Current graph/state/project identity | Always retain. |
| Adjacent deltas | Retain newest 40. |
| Derived-cache audit events | Retain newest 1,000. |
| Current derived artifacts | Retain. |
| Older derived artifacts | Retain a bounded recent set per logical key until measured policy is implemented. |
| Human verification, handoff, delivery, runtime, and test-run metadata | Not cache-pruned by default. |
| Git snapshots | Manual retention; prune only through explicit category selection. |

### Acceptance

- all automated lanes finish with the same tracked/untracked state they began
  with, except explicitly declared output paths;
- cache status accounts for bytes and records without reading source bodies;
- prune dry-run and prune report the same selected records;
- interruption preserves the previous valid registry and current graph;
- no current Context Ref becomes unresolved because of a default prune;
- DF-023 and DF-026 remain open until their original reproductions pass.

Suggested commits:

```text
fix: isolate generated fixture cache state
feat: make local cache retention inspectable
```

## E48 - Bounded view-projection contract

**Completed 2026-07-22.** `flowpeek-view-projection/v2` binds every map to its
project and graph basis, uses a default 40-node/80-edge display ceiling with
100/200 hard ceilings, and reports returned, omitted, and node-bound edges.
`flowpeek view`, `/api/view`, and MCP `get_view_projection` share the contract.

### Objective

Replace implicit browser-oriented graph slices with one typed, deterministic,
bounded projection shared by people and agents.

### Required ADR

Add `docs/adr/ADR-021-bounded-semantic-view-projections.md` before changing the
public contract. It must decide projection identity, hierarchy evidence,
Context Ref separation, hard bounds, and stale behavior.

### Contract

Define `flowpeek-view-projection/v2` with at least:

```json
{
  "schemaVersion": "flowpeek-view-projection/v2",
  "project": {
    "projectId": "project:example",
    "graphVersion": 17,
    "sourceRevision": "abc123"
  },
  "projection": {
    "id": "view:feature:payments@17",
    "level": "feature",
    "focusId": "feature:payments",
    "scope": "application",
    "depth": 1
  },
  "catalog": {
    "sourceNodes": 1611,
    "matchingNodes": 143,
    "displayedNodes": 32,
    "omittedNodes": 111,
    "matchingEdges": 218,
    "displayedEdges": 54,
    "omittedEdges": 164,
    "truncated": true
  },
  "bounds": {
    "maxNodes": 40,
    "maxEdges": 80,
    "hardMaxNodes": 100,
    "hardMaxEdges": 200
  },
  "nodes": [],
  "edges": [],
  "limitations": []
}
```

Defaults are 40 displayed nodes and 80 displayed edges. Accepted caller bounds
must remain within hard limits of 100 nodes and 200 edges. A later benchmark may
change defaults through the same ADR process; implementations must not silently
clamp invalid caller input.

Every projection node declares:

- stable projection ID;
- level and representation kind (`aggregate` or `technical`);
- evidence class;
- parent ID when known;
- child availability/count;
- source member count and bounded member preview for aggregates;
- Technical Context Ref only for an exact technical node;
- a separately typed Projection Ref for aggregate navigation.

Every projection edge declares:

- source and target projection IDs;
- exact or aggregate relationship kind;
- underlying relationship count;
- evidence class;
- bounded evidence-reference preview;
- omission/truncation metadata when applicable.

### Surfaces

- one graph-service method;
- one HTTP projection route;
- one typed MCP tool or a backward-compatible extension of the existing typed
  projection tool;
- optional CLI JSON output for reproducible inspection;
- Viewer consumes the same response without local unbounded reconstruction.

### Acceptance

- no `slice()`-based node or relationship omission lacks catalog disclosure;
- identical input and graph state produce byte-stable normalized JSON;
- invalid level, depth, node bound, edge bound, relation, and stale expected
  graph version fail explicitly;
- aggregate and technical IDs cannot collide;
- planned entities are excluded from factual catalog counts;
- HTTP, MCP, service, and CLI projections agree;
- `npm test`, documentation, and support checks pass.

Suggested commit: `feat: expose bounded view projection contracts`

## E49 - Stable live renderer

**Completed 2026-07-22.** Compatible live refreshes reconcile Cytoscape nodes
and edges in place. The renderer preserves the current viewport and the
positions of unchanged nodes; only a renderer-mode change, an empty view, or
an incompatible graph library state creates a new instance. Newly added nodes
receive a deterministic local placement near a factual neighbor.

### Objective

Preserve the user's mental map across compatible graph refreshes.

### Required changes

- create Cytoscape once per compatible Viewer session;
- replace unconditional destroy/recreate with an element-diff update inside
  `cy.batch()`;
- retain selection, focus, semantic level, active filters, pan, and zoom;
- retain positions for unchanged projection IDs;
- lay out only new or materially affected subgraphs when practical;
- disclose and safely fall back to a full bounded relayout when incremental
  layout cannot preserve correctness;
- treat removed selection as explicit stale/removed context rather than
  silently selecting another node;
- preserve the last complete projection when refresh is cancelled, bounded,
  invalidated, or failed;
- prevent duplicate event listeners and renderer instances across refreshes.

### View-state contract

View state is session/UI metadata, not Evidence Graph data. It contains:

```text
projection ID and graph version
selected technical Context Ref or Projection Ref
focus ID
semantic level
pan and zoom
expanded groups
relationship/evidence filters
change-only mode
```

Do not persist source-derived claims in browser storage. Initial implementation
may keep view state in memory and URL parameters; durable saved views are not
part of E49.

### Acceptance

- 100 compatible refreshes preserve one unchanged selected node, focus, pan,
  zoom, and semantic level;
- a source-only edit marks affected context without moving unchanged nodes;
- a new node does not force an unannounced whole-projection relayout;
- a removed selected node produces a visible stale/removed state;
- listener and Cytoscape instance counts remain bounded after repeated refresh;
- a failed refresh retains and labels the last complete projection;
- Canvas remains the supported renderer; WebGL remains optional and cannot be
  used to bypass bounds or readability checks;
- full and browser-specific tests pass.

Suggested commit: `feat: preserve live graph focus across refreshes`

## E50 - Bounded semantic zoom v1

**Completed 2026-07-22.** Domain, Feature, Component, and Symbol levels are
deterministic projections of existing node metadata. The Viewer can drill from
a selected summary to the next level, while CLI and MCP accept the same level
parameter. No semantic level writes to, or is returned as, a factual source
node or runtime observation.

### Objective

Make semantic zoom the primary way to move from project orientation to exact
source evidence without rendering an unbounded graph.

### Semantic levels

| Level | Primary entities | Required meaning |
| --- | --- | --- |
| `domain` | Repository/package/domain aggregates | A bounded top-level orientation view. |
| `feature` | Supported entry groups and deterministic feature aggregates | User-recognizable technical capabilities, not verified business processes. |
| `component` | Service/module/class/repository/database/queue/external boundaries | Architectural implementation context. |
| `symbol` | Exact functions, methods, classes, modules, entries, and parser edges | Raw technical evidence drill-down. |

### Hierarchy evidence order

Use the first unambiguous source in this order:

1. explicit repository-owned Flowpeek grouping configuration;
2. exact workspace/package and parser/framework ownership;
3. exact source containment and module boundaries;
4. deterministic existing feature/domain classification;
5. explicit `unresolved` aggregate.

Path names, topology, or labels may support deterministic derived grouping, but
cannot create business purpose. Multiple equally valid candidates produce an
ambiguous/unresolved result rather than an arbitrary selection.

### Interaction contract

- expose explicit Domain, Feature, Component, and Symbol controls;
- wheel/pinch thresholds may suggest a level transition only after the explicit
  controls and keyboard path work;
- zoom-in keeps the selected aggregate as the anchor for its child projection;
- zoom-out returns to the deterministic parent;
- back/forward restores the exact prior projection request and view state;
- every level shows displayed/omitted counts and the active evidence boundary;
- aggregate Projection Refs never resolve as Technical Context Refs;
- a graph refresh retains level/focus when identities remain compatible and
  reports stale/removed anchors otherwise.

### Acceptance

- Domain -> Feature -> Component -> Symbol -> parent round-trip is
  deterministic on pinned fixtures;
- each transition stays within E48 bounds and transmits no unbounded graph;
- ambiguous grouping remains visible and does not fabricate a parent;
- exact symbols preserve their current Technical Context Refs;
- HTTP/MCP projection parity holds at all four levels;
- planned overlays remain visually and contractually separate;
- no AI/ML/provider call is required;
- full, browser, accessibility, and documentation lanes pass.

Suggested commits:

```text
feat: add bounded semantic zoom projections
feat: navigate project hierarchy by evidence level
```

## E51 - Flow-first product navigation

**Completed 2026-07-22.** The Viewer opens the first supported bounded Flow
Lens as its initial technical journey. Project Home remains an explicit toolbar
destination and the truthful fallback for repositories without a supported
static flow. Re-scanning a repository starts the same bounded journey again;
ordinary navigation and refreshes preserve the user's current context.

### Objective

Make the first experience an understandable project journey rather than a raw
architecture canvas or a catalog of implementation capabilities.

### Required journey

```text
Project Home
  -> browse domains or select a supported entry flow
  -> inspect one bounded Flow Lens
  -> zoom to related components
  -> drill into exact source evidence
  -> inspect impact/tests/changes
  -> copy Context Ref or continuation packet
```

### Required navigation

- visible breadcrumb;
- back and forward projection history;
- parent and child navigation;
- upstream/downstream selection;
- depth 1 through 3 within E48 bounds;
- relationship-type and evidence-class filters;
- changed-only mode;
- center selected and fit current bounded projection;
- expandable aggregate with visible child and omission counts;
- accessible non-canvas equivalent for every primary navigation action.

### Inspector information order

1. identity and concise technical responsibility;
2. source/project location and evidence class;
3. why the node or edge is shown;
4. incoming/outgoing relationships and omissions;
5. related Flow Lenses and boundaries;
6. related-test candidates;
7. current/stale/change state;
8. copy Context/Projection reference;
9. advanced verification, trace, and export controls.

### Acceptance

- a first-time user can reach a supported Flow Lens without opening raw symbol
  inventory;
- duplicate labels remain distinguishable by path/type/parent context;
- every graph action has a visible navigation result and recoverable back path;
- advanced review controls do not dominate initial orientation;
- empty, unsupported, inventory-only, loading, stale, and error states have
  distinct copy and recovery actions;
- browser and manual Viewer gates pass.

Suggested commit: `feat: make Flow Lens the primary viewer journey`

## E52 - Evidence readability and observable QA

**Completed 2026-07-22 for the automated product contract.** The Viewer now
uses textual, non-color map vocabulary for static, aggregate, planned, and
inventory-only entities; it exposes a keyboard-described alternative to canvas
navigation and uses responsive/reduced-motion safeguards. An automated
delivered-asset test checks the Viewer contract. The separate manual browser and
assistive-technology review remains an explicit S5 release gate; no unrun
manual result is represented as passed.

### Objective

Prove that the bounded graph is understandable and recoverable, not merely
rendered.

### Required visual vocabulary

| Evidence/state | Non-color requirements |
| --- | --- |
| Exact parser fact | Solid border plus evidence label. |
| Supported-subset fact | Solid border plus subset/limitation label. |
| Derived aggregate | Double border plus aggregate/member count. |
| Runtime observation | Observation badge; never a static edge replacement. |
| Human verification | Attributed verification marker. |
| Planned entity | Dashed shape and explicit not-found-in-source text. |
| Inventory-only entity | Dotted/limited marker and no relationship implication. |
| Stale/removed context | Warning marker and explicit graph-version state. |

### Automated browser baseline

Add a reproducible browser journey harness. Playwright is the preferred
development-only candidate, subject to package-policy and clean-room review; an
equivalent harness is acceptable only if it can exercise real local Viewer
events, focus, history, refresh, and accessibility names.

Cover:

- keyboard journey through search, flow list, hierarchy, inspector, and back;
- 200% browser zoom and a narrow viewport;
- long and duplicate labels;
- non-color state distinctions;
- reduced-motion behavior;
- slow, cancelled, failed, stale-unverified, and recovered refresh;
- selected-node removal;
- before/current Flow Lens comparison;
- semantic-level transition and retained view state;
- screenshots for the four semantic levels and change state.

### Manual gate

Azka and Iris review the same subject revision and Viewer build. Hadi covers the
automated contract. Unknown keyboard, readability, or recovery behavior keeps
the gate open; automated DOM/source assertions cannot waive manual observation.

### Acceptance

- primary journey is keyboard reachable without direct canvas manipulation;
- active level, focus, omissions, evidence class, and stale state remain legible
  at supported viewport/zoom cases;
- no graph line density is presented as runtime order or completeness;
- error and recovery journeys preserve the last complete evidence state;
- automated and manual artifacts cite the same commit and graph basis;
- unresolved material Azka, Hadi, or Iris findings keep E52 open.

Suggested commit: `feat: clarify graph evidence and accessible navigation`

## E53 - Supported-language product dogfooding

**Completed 2026-07-22.** A source-digest-pinned TypeScript, Python, and PHP
cohort now verifies its declared static relation oracle, Flow Lens, semantic
levels, MCP Context Ref basis, disposable source-only refresh, and stale
resolution. The checked report is
[`supported-language-dogfood.json`](../benchmarks/supported-language-dogfood.json).
The cohort does not execute target applications, commands, tests, or runtimes.

### Objective

Prove the complete product journey on several declared static-analysis subsets,
not only on internal fixtures or one language.

### Current digest-pinned fixture cohort

| Cohort | Required scope |
| --- | --- |
| JS/TS | One source-digest-pinned TypeScript fixture exercising declared imports, direct calls, one HTTP entry flow, related tests, refresh, and semantic levels. |
| Python | One source-digest-pinned fixture using only declared parser/import/direct-call and supported HTTP-entry subsets. |
| PHP | One source-digest-pinned fixture using the declared structure/import/direct-call and literal package-command subset. |

This fixture cohort does not satisfy a production-repository or runtime claim.
Production-shaped static evidence is separately recorded in
[`production-static-evidence.json`](../benchmarks/production-static-evidence.json).
Go may replace the third cohort only when the required toolchain and supported
host matrix are explicit. C# structure-only evidence and inventory-only
languages do not count as a functional flow pass.

### Journey per repository

1. discover and declare scan bounds;
2. scan without executing target code;
3. audit expected relationships against a source-pinned oracle;
4. navigate Domain -> Feature -> Component -> Symbol;
5. select and copy a Flow Lens/Context Ref;
6. resolve the same context through MCP;
7. make one controlled source edit in a disposable copy;
8. observe refresh latency and retained Viewer state;
9. resolve current/stale context and before/current comparison;
10. inspect related-test candidates and explicit omissions;
11. measure cache growth and cleanup;
12. restore/delete only the disposable copy.

### Metrics remain separate

- audited relationship precision and recall;
- ordered supported-flow step accuracy;
- time to first useful flow;
- navigation actions to exact source evidence;
- displayed/omitted count comprehension;
- refresh-to-context latency;
- focus/viewport/semantic-level retention;
- Context Ref resolution correctness;
- related-test recall;
- unsupported-claim rate;
- cache bytes/artifacts before and after;
- automated and manual pass/failed/unknown outcomes.

Do not collapse these metrics into one truth, quality, or confidence score.

### Acceptance

- every repository is pinned to an immutable source revision and declared
  supported subset;
- each expected relationship has an independently inspectable oracle;
- Viewer and MCP use the same graph/projection basis;
- no inventory-only relationship is counted as a detected flow;
- unsupported runtime/business statements remain zero in the reviewed output;
- source edit and cleanup occur only in a disposable copy;
- S1 through S4, S6, and E46 through E52 remain passing at the final baseline;
- final full, package, documentation, delivered-Viewer, and dogfooding gates pass;
- the manual S5 gate is retained as explicit `unknown` until its separate
  browser/assistive-technology evidence exists.

Suggested commits:

```text
test: dogfood semantic zoom across supported languages
docs: publish scoped Viewer stability evidence
```

## Stability regression matrix

Every later Flowpeek change must identify affected rows and rerun their gates.

| Contract | Must remain stable | Invalidating change |
| --- | --- | --- |
| Project identity | Same configured/generated identity for the same local project policy. | Explicit identity change or disclosed copy/fork mismatch. |
| Graph version | No-op refresh retains version; material change advances once. | Material fingerprint or source-basis change. |
| Technical Context Ref | Exact current node/flow identity or explicit stale/historical/unresolved state. | Graph version or technical identity change; never silent redirect. |
| Projection Ref | Exact project/version/level/focus/projection identity. | Projection basis, hierarchy, bounds, or graph version change. |
| Projection catalog | Matching/displayed/omitted counts and deterministic ordering. | Source graph or explicit projection request change. |
| Viewer state | Focus, selection, level, pan/zoom, filters, and stable positions on compatible refresh. | Removed/stale anchor or explicit user reset. |
| Evidence classes | Parser, derived, runtime, human, agent, and delivery classes remain distinct. | No implicit conversion is allowed. |
| Cache | Exact compatible reuse, atomic writes, explicit invalidation, bounded retention. | Project/schema/source/dependency/topology/integrity incompatibility. |
| MCP/HTTP/CLI parity | Same typed projection and context semantics. | Versioned contract change with migration/documentation. |
| Language support | Claims do not exceed pinned adapter evidence. | New audited adapter contract and support update. |

## Stable-dogfooding exit gate

Flowpeek is stable for routine product dogfooding only when:

- E46 through E52 are `done`;
- S1 through S5 are `done`;
- at least one JS/TS and two non-JS supported-subset pinned journeys from E53
  pass their declared contracts;
- production CLI and real stdio MCP contain no known blocking load-order error;
- successful automated verification returns the repository to its starting
  tracked/untracked state;
- cache growth and pruning are visible and bounded;
- every Viewer projection discloses omissions;
- refresh preserves compatible mental-map state;
- all four semantic levels work through Viewer and MCP;
- the Hadi/Iris QA pair agrees on the covered outcome with no unresolved
  material failure or unknown;
- documentation reports the executable result, not only the intended design.

This gate authorizes routine dogfooding only. It does not authorize beta,
stable, universal-language, runtime, business-flow, or public-release claims.

## Stop and rollback rules

Stop the active item and preserve the last valid baseline when:

- a partial or invalid graph would replace the current complete cache;
- projection changes hide omissions or mix planned and factual entities;
- a stale Context Ref would be redirected silently;
- Viewer stability requires sending an unbounded graph;
- semantic grouping would require an unsupported business or runtime inference;
- a cache cleanup cannot prove ownership of the files it deletes;
- a new dependency breaks Node 20/22, clean-room packaging, or a supported host;
- the target repository would be executed without a separate explicit contract;
- source, credentials, prompts, raw logs, or private reasoning would enter a
  portable artifact.

Rollback means revert only the active focused item or disable its new opt-in
surface. Do not reset unrelated user work, delete user-owned `.flowpeek` state,
or rewrite the shared checkpoint history.

## Checkpoint and handoff template

After every item, update the current checkpoint with:

```text
Item and status
Branch and commit
Baseline graph version/source revision
Changed contracts and files
Preserved invariants
Focused verification commands/results
Full/package/docs/browser gate results when required
Manual review status
Dogfooding finding IDs opened/resolved
Known dirty state and ownership
Exact next item and preflight command
```

The next implementation host must begin from this checkpoint and the committed
execution plan, not from conversation memory.

## Storage boundary during this sequence

JSON remains the authoritative local backend through E53. E47 adds measurement,
retention, and an abstraction seam; it does not authorize a database migration.

Evaluate an embedded backend only after pinned evidence shows that full JSON
rewrite, artifact registry growth, query latency, or history retention exceeds
declared product budgets. SQLite is the primary local-first candidate. Neo4j may
be evaluated later as an optional exported/team analytics projection, not as a
required local cache or source of parser truth.
