# ADR-020: Versioned work continuation remains separate from source evidence

**Status:** Accepted  
**Date:** 2026-07-18

## Context

Flowpeek already preserves version-bound technical Context Refs, immutable
Handoff Workspace versions, static Git snapshots, local delivery work records,
planned windows, append-only actual events, and evidence-gated Agile,
Waterfall, and custom workflow definitions.

Those primitives do not yet form one continuation contract. A person or agent
cannot select an exact source baseline, attach the current technical context and
remaining work, draw planned technical entities, then compare that plan with a
later graph without manually reconstructing the relationship among artifacts.

Putting planned entities directly into the Evidence Graph would be unsafe. A
planned service or edge is intent, not proof that a symbol, call, runtime path,
test result, approval, or release exists.

## Decision

- Introduce an immutable `flowpeek-continuation-checkpoint/v1` artifact that
  composes one project identity, exact Git or working-tree source basis, graph
  version, selected Context Refs, optional Handoff Workspace, and Delivery Graph
  work records.
- Derive checkpoint baselines from the current validated graph. Callers provide
  an expected graph version but cannot manufacture a different source basis.
- Introduce `flowpeek-planned-overlay/v1` as Delivery/Context metadata. Planned
  nodes and planned edges never enter `graph.nodes`, `graph.edges`, Flow Lens,
  static impact, or parser coverage.
- Give planned entities a distinct Plan Ref contract. A Plan Ref is never
  accepted where a technical Context Ref is required, and the reverse is also
  rejected.
- Prefix every planned relationship with `planned_`. Factual relationship names
  such as `calls`, `imports`, `reads`, `writes`, `uses`, and `tested_by` remain
  reserved for evidence-backed graph relationships.
- Introduce append-only manual reconciliation records between one Plan Ref and
  zero, one, or many current technical Context Refs. Positive implementation
  outcomes require current actual Context Refs.
- Treat agent-authored reconciliation as a proposal. It cannot silently become
  human confirmation or parser evidence.
- Build baseline/plan/current comparison from retained checkpoint evidence,
  current resolvers, planned overlays, and reconciliation records. Missing
  historical evidence produces `partial`, `unavailable`, or `unknown`, never a
  fabricated reconstruction.
- Detect Git divergence read-only. Flowpeek does not fetch, check out, merge,
  rebase, or change branches as part of continuation analysis.
- Keep the ordinary Viewer factual by default. Planned overlays require an
  explicit Continue mode and remain distinguishable through text, shape, border,
  and line style rather than color alone.
- Add deterministic/manual behavior first. Suggested matching or ML evaluation
  is deferred until a consented, human-reviewed reconciliation dataset exists.

## Consequences

Flowpeek can evolve from a technical-flow context layer into a versioned work-
continuation layer without turning a plan into source truth or becoming a
project tracker, Git client, CI runner, deployment system, or autonomous coding
agent.

The first delivery sequence is checkpoint composition, planned overlay storage,
explicit Viewer rendering, manual reconciliation, bounded comparison, read-only
divergence, and an agent continuation packet. Automatic materialization,
external workflow execution, arbitrary history reconstruction, and model-based
matching remain outside the first sequence.

