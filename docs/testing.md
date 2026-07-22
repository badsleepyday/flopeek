# Test lanes

`npm run test:fast` is the pull-request feedback lane. It checks generated support drift, registry validation, Product Proof evidence integrity, Trust Analytics claim boundaries, semantic suggestions, semantic feedback, agent evidence traces, capability exposure contracts, flow verification, and the fixture relationship gate. It does not clone the external corpus or start optional Go/.NET helpers.

`test/unit/product-proof.test.js` validates the checked-in public evidence against the pinned real-repository manifest, recomputes precision/recall and speedup formulas, validates the checked-in orientation totals, enforces explicit non-claims, and exercises the opt-in `flowpeek proof` CLI. Local-server tests cover both the ordinary benchmark endpoint and the Product Proof wrapper. MCP exposes only the non-executing report; it cannot start a benchmark.

`test/unit/orientation-benchmark.test.js` validates the source-pinned repository-orientation case schema and both deterministic conditions. It requires exact target and related-test retrieval, ordered static Flow Lens retrieval for the Flowpeek condition, stale Context Ref detection, bounded context accounting, no source-body leakage, and no writes to the original fixtures. The direct-repository condition deliberately reports flow and stale-reference evidence as unavailable. Human and AI-agent studies remain separate and `not-run`. Because it performs repeated cold scans and temporary-copy stale probes, it runs in the full/unit/explicit orientation lanes rather than the fast pull-request lane; fast verification still validates the checked-in orientation totals through Product Proof.

`test/unit/git-metadata.test.js` protects the one-command porcelain-v2 metadata parser and static worktree/common-directory/origin resolution. Scanner coverage requires four non-persisted timing phases while prohibiting transient performance data from entering graph evidence. Existing JavaScript/TypeScript, Python, PHP, Java, Rust, Go, and C# tests protect lazy parser initialization from relationship drift.

`test/unit/agent-comparison.test.js` validates the checked `not-run` template/report, paired scoring against the committed oracle, session fingerprinting, condition isolation, consent, safe paths, unknown-field rejection, and the CLI no-provider boundary. Synthetic pairs test aggregation mechanics only; they are not published provider evidence.

`test/showcase.test.js` validates the guided checkout demonstration as a product contract, not as benchmark evidence. It checks marked temporary-copy confinement, original-example immutability, idempotent apply/reset, divergence refusal, viewer assets, shared HTTP and real stdio MCP identity, live graph-version advancement, changed contexts, retained before/current comparison, stale Context Ref resolution, related-test impact, cleanup, and the no-target-execution boundary. Run it directly with `npm run test:showcase`; it is also part of `test:full`.

`test/unit/trust-analytics.test.js` is the primary anti-overclaiming gate. It requires explicit denominators, `null` for undefined ratios, unavailable live-repository precision/recall, no composite score, and separation between developer-governance role names and Flowpeek runtime output. The local-server and MCP integration tests require contract parity across human and agent surfaces.

The lane runner caps Node test-file concurrency at four. Several integration files start loopback servers or parser/toolchain helpers; unbounded file concurrency can starve or strand those processes on constrained Windows and CI hosts. The cap changes scheduling only, not test selection or assertions.

The fast and contract lanes also validate repository-local reviewer skills, explicit-invocation policy, AGENTS routing, and review/specialist artifact schema identity. This structural gate does not replace independent provider execution or manual QA.

`test/unit/repository-discovery.test.js` validates deterministic inventory,
scope, static manifest/package classification, exact and exceeded bounds,
opaque analysis-plan fingerprints, and metadata-free CLI preflight.
`test/unit/bounded-scan.test.js` requires complete-result-only graph delivery,
immutable shared-plan source binding, source-set mutation rejection after
discovery, cancellation without graph promotion, prior-cache preservation, and
no-cache CLI behavior. `test/unit/repository-discovery.test.js` verifies the
same plan detects added source files/directories while leaving non-source,
non-control edits outside its source-inventory contract. These tests do not yet
prove cross-platform cleanup of optional adapter child processes or
server/Viewer/MCP parity. The plan fingerprint is metadata-based; an adversarial
same-size, timestamp-preserving rewrite remains outside this test lane.

`npm run test:full` retains the complete local test suite. `test:unit`, `test:docs`, `test:orientation`, `test:agent-comparison`, `test:package`, `test:public-repository`, `test:showcase`, `test:semantic`, `test:feedback`, `test:reviewed-evaluation`, `test:trace`, `test:adapters`, `test:contracts`, `test:viewer`, and `test:fixtures` provide focused lanes. `test:docs` checks that evidence-backed SVGs match their JSON inputs and that README screenshots are present, portable PNG captures. `test:orientation` is the deterministic repository-understanding gate described in `docs/orientation-benchmark-protocol.md`. `test:agent-comparison` validates the provider-neutral paired-run contract, consent boundary, Context Ref identity, evidence requirements, and checked `not-run` artifact without invoking an AI provider. `test:package` validates the package allowlist, denied-content and private-release boundaries, npm dry-run inventory, version command, source fingerprinting, and checked clean-room report. `test:public-repository` validates the clean-snapshot allowlist, private governance exclusions, history-free export, and release blockers. `verify:clean-room` remains an explicit isolated tarball installation and MCP smoke run rather than an ordinary unit test. `test:showcase` exercises the temporary-copy Viewer/HTTP/MCP walkthrough without executing the target. `test:semantic` evaluates candidate fields and abstention against a committed deterministic contract corpus. `test:feedback` checks immutable/idempotent labels, exact Context Ref trace binding, supersession, invalid-store preservation, and synthetic metric aggregation. `test:reviewed-evaluation` checks the consent/privacy contract, held-out leakage protection, and recommendation thresholds using only in-test data. `test:trace` checks immutable/idempotent trace append, safe repository-relative paths, Context Ref status, bounded query, and invalid-store preservation. `test:real-corpus` remains an explicit external audit lane and is not part of ordinary pull-request verification; it reports progress and enforces a configurable per-repository process timeout.

Documentation charts are generated from checked JSON evidence:

```powershell
npm run generate:docs
npm run check:docs
```

Viewer screenshots use an isolated headless Chrome/Edge profile and only accept a loopback HTTP URL plus an output path under `docs/assets/screenshots`:

```powershell
node scripts/capture-doc-screenshot.js --url http://127.0.0.1:4780/ --output docs/assets/screenshots/flow-lens.png
```

The capture script sanitizes the repository input path, closes the isolated browser, and removes its temporary profile. Screenshot presence proves only that the declared Viewer state rendered on the capture host; it is not a browser-compatibility or usability study.

`npm run evaluate:semantic` reports correct and incorrect suggestions, correct and unexpected abstentions, coverage, and contract accuracy. Its committed synthetic cases protect deterministic behavior; they are not a business-purpose benchmark.

`npm run evaluate:feedback` verifies decision and optional trace-link metric aggregation against a synthetic contract corpus. It is deliberately not human-feedback collection, a candidate-quality benchmark, model calibration, or a recommendation score.

`npm run evaluate:reviewed-feedback -- --dataset <private-file> --require-gate` evaluates only a separately collected consented human-review cohort. Its template always reports `NOT ELIGIBLE`; it is a format example, not evidence.

Initial engineering target: the fast lane should complete in under 30 seconds on the originating Windows host. This is a local feedback target, not a cross-machine performance guarantee. During Iteration 10 it completed in 5.36 seconds with Node.js 24.14.1; the complete local suite completed in 78.33 seconds.
