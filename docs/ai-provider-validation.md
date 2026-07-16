# Independent AI-provider validation

This protocol turns Azka, Bono, Cuna, and Dana into portable review roles for Flowpeek-generated technical flows. It does not make a model omniscient or authoritative. Trust comes from a current subject identity, direct evidence, reproducible checks, explicit unknowns, and independent review provenance.

## Evidence authority

Use this order when claims conflict:

1. reproducible repository-owned tests or directly captured runtime observations;
2. current parser facts, graph version, Context Refs, and source/configuration evidence;
3. current human verification with attributable provenance;
4. deterministic Flowpeek derivations and comparisons;
5. independent reviewer conclusions;
6. unverified model suggestions or naming-based hypotheses.

A lower layer may identify a concern but cannot silently override stronger contradictory evidence. No layer proves business purpose unless that purpose has attributable human or project evidence.

## Review sequence

1. Capture the repository commit or dirty-state disclosure, Flowpeek project ID, graph version, and reviewed Context Refs.
2. Select only the reviewers whose domains are affected. Use all four for public release candidates and broad Flow Lens contract changes.
3. Run each required role in a separate provider execution when provider independence is required.
4. Give each reviewer the same subject identity and raw evidence access, but do not provide another reviewer's verdict before its independent pass is complete.
5. Validate every returned artifact against `docs/schemas/flowpeek-independent-review.schema.json`.
6. Reject an artifact whose subject identity is stale, evidence is missing for a pass/fail, or provider provenance is incomplete.
7. Compare disagreements. Preserve minority findings; do not resolve them by majority vote alone.
8. Re-run affected reviews after remediation.
9. Invoke Elda only when release classification is requested and all required artifacts are current.

## Required primary domains

### Azka — UI/UX and human comprehension

Azka evaluates whether people can read, navigate, filter, expand, compare, copy, and interpret a flow without mistaking line density or layout for proven execution order. Accessibility, semantic zoom, focus behavior, empty/error states, and visual disclosure of uncertainty are in scope.

### Bono — implementation and platform correctness

Bono evaluates code paths, surface parity, validation, cache identity, incremental behavior, tests, security boundaries, resource use, and supported cross-platform behavior. Claims spanning languages, frameworks, commands, operating systems, or kernels require direct evidence or an `unknown` result.

### Cuna — system analysis and flow semantics

Cuna evaluates entry points, actors, dependencies, boundaries, alternative paths, omissions, requirement traceability, Context Ref freshness, and whether static evidence is being overinterpreted as runtime or business truth.

### Dana — documentation and claim integrity

Dana evaluates whether product, architecture, roadmap, support matrix, commands, examples, limitations, and release notes match the current implementation and verified evidence. Documentation must remain English and portable.

## Additional release role

Elda is the next four-letter alphabetical reviewer. Elda owns release-readiness classification and stability gates; Elda does not redo or replace the four primary reviews.

## Discovery and QA specialists

- **Fara — brainstorming and role-gap discovery:** creates alternatives and falsifiable experiments in a `flowpeek-specialist-work-product/v1` artifact. Fara may promote a high-relevance recurring SDLC gap into a permanent, explicitly invoked repository skill only after proving non-overlap with the existing catalog and updating routing, contracts, documentation, and automated validation. Lower-relevance or speculative gaps remain proposals. Fara cannot approve implementation or release.
- **Gama — research and development:** tests technical feasibility using primary sources and reproducible experiments in the same specialist artifact. One fixture never establishes universal language, command, OS, or kernel support.
- **Hadi — automated QA:** creates an independent review artifact backed by repository-owned automated checks and explicit environment/tool versions.
- **Iris — manual QA:** creates an independent review artifact backed by reproducible human-observable steps, expected/actual results, and environment disclosure.

When both automated and human-observable behavior matter, Hadi and Iris form one paired QA gate. Both artifacts must target the same source and compatible graph identity. Automated assertions cannot prove visual comprehension, while manual observation cannot prove parser, cache, security, performance, or regression correctness. A material failure, blocker, disagreement, or unknown keeps the paired gate open.

### Alpha

- core installation and primary workflow are reproducible on declared platforms;
- known limitations and unsafe interpretations are prominent;
- no unresolved critical security, data-loss, or integrity failure exists;
- primary automated gates pass;
- the package is explicitly labeled experimental.

### Beta

- alpha gates remain satisfied;
- real-repository evidence covers declared priority stacks;
- required four-provider review artifacts are current for the candidate;
- the Hadi/Iris paired QA gate is current when the candidate includes material viewer or end-to-end human workflow behavior;
- upgrade, cache migration, portability, and failure recovery are tested;
- no unresolved critical or high-severity release blocker exists;
- public API/MCP contracts have compatibility policy and change notes.

### Stable

- beta gates remain satisfied over a documented observation period;
- supported platform and Node-version matrices pass reproducibly;
- security/privacy, rollback, corruption recovery, and backward compatibility are verified;
- performance and large-repository behavior meet published thresholds;
- release artifacts, licensing, governance, support policy, and versioning are complete;
- every material reviewer disagreement is resolved or explicitly accepted by an accountable human owner.

If evidence is missing, Elda returns `ineligible`, never the nearest optimistic stage.

## Artifact rules

Every artifact uses schema `flowpeek-independent-review/v1` and records:

- reviewer role and invoked skill;
- actual provider, model, and session/run identifier;
- project, commit/dirty state, graph version, and Context Refs;
- bounded scope and evidence inventory;
- checks with status, finding, and evidence references;
- verdict, confidence, limitations, and timestamp.

`provider.independentExecution` means the run was isolated from other reviewers' conclusions. It does not prove a distinct provider. A four-provider quorum additionally requires four different non-placeholder `provider.name` values and separate run identifiers.
