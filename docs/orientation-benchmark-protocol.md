# Repository orientation benchmark protocol

## Question

The benchmark asks a bounded question:

> How much correct, traceable repository context can each deterministic retrieval condition expose for a declared orientation task?

It does not answer whether a developer or AI agent completes a coding task faster or more accurately. Human productivity and agent outcomes require separate studies.

## Conditions

### Direct repository

The direct condition builds a read-only text inventory and ranks files using case-insensitive literal substring occurrences from the case's declared search terms. It uses no Flopeek graph, relationship inference, Context Ref, AI provider, regular-expression source interpretation, or target execution.

This condition can return candidate files and test-looking paths. It cannot produce relationship order. Flow-step recall therefore remains `unavailable`; assigning it zero or deriving an order from the oracle would bias the comparison.

### Flopeek

The Flopeek condition performs a deterministic static scan, searches graph metadata, resolves the declared request-flow query, projects at most 24 static Flow Lens steps, and follows direct test relationships on each step and its containing file. It never executes the target repository.

Stale-context probes run only in temporary repository copies. They create a versioned node Context Ref, append one newline to the declared source path, refresh the graph, and evaluate the resolver status. Original fixtures remain read-only.

## Dataset and oracle

[`benchmarks/orientation-cases.json`](../benchmarks/orientation-cases.json) uses `flopeek-orientation-cases/v1`. Each repository entry declares:

- a portable repository-relative path;
- a line-ending-normalized `tree-sha256` source pin;
- explicit retrieval exclusions for benchmark-owned oracle files;
- one or more unique tasks;
- literal search terms and an optional flow query;
- expected target paths, ordered flow-step IDs, and directly related test paths;
- an optional node/path stale-context probe.

The initial suite contains three fixture cases:

- legacy TypeScript handoff;
- TypeScript order creation;
- Python payment lookup.

Fixture oracles are reviewed repository facts, not generated answers. `expectations.json` is excluded from direct retrieval so the literal condition cannot retrieve the relationship oracle as candidate context. The exclusion remains visible in each raw report. A source-pin mismatch stops evaluation before scoring.

## Metrics

| Metric | Definition | Comparison rule |
| --- | --- | --- |
| Correct target retrieval | Expected target paths present in bounded returned paths | Recall is comparable across deterministic conditions. |
| Flow-step recall | Longest expected-order match divided by expected step count | Reported only when a condition produces relationship order. |
| Flow-step precision | Returned expected steps divided by all returned steps | Reported only when relationship order is available. |
| Related-test recall | Expected directly related test paths present in returned paths | Comparable for the declared oracle only. |
| Files inspected | Unique repository paths exposed in the bounded result | Scanner/index preparation is reported separately as files processed. |
| Estimated context tokens | Returned context characters divided by four and rounded up | Uses `flopeek-char4-estimator/v1`, not a provider tokenizer. |
| Repository preparation | Text inventory or Flopeek initial static scan, counted once per repository | Host-specific, observed, and non-gating. |
| Bounded retrieval | Case search and projection after preparation | Host-specific, observed, and non-gating. |
| Total time to useful context | Repository preparation plus bounded case retrieval | Does not include process startup/module load or the separate stale-ref validation probe. |
| Separate stale-ref validation | Temporary-copy baseline scan, source change, incremental scan, cache persistence, and resolution | Reported separately because it is validation after useful context, not retrieval latency. |
| Process startup and module load | Time before the in-process evaluator begins | Explicitly `unavailable`; it is never silently folded into scan timing. |
| Unsupported-claim rate | Unsupported claims divided by evaluated claims | `null` for the deterministic harness because it emits no prose claims. |
| Stale-context detection | Requested stale Context Refs resolved as stale, historical, or successor-candidate | Available only for a condition with a versioned Context Ref contract. |

Missing metrics remain `unavailable`; they are never converted to zero. Timing must retain Node version, platform, architecture, CPU model, logical CPU count, clock, the non-gating policy, per-phase Flopeek preparation, and its accounting rule. Repository preparation is counted once even when one repository contains several cases.

## Evidence classes

Every report keeps these classes independent:

1. `deterministic-retrieval` — produced by this executable harness;
2. `human-observation` — requires a separately consented study artifact and is `not-run` here;
3. `agent-declared-or-independently-reviewed` — requires a separately captured provider execution and is `not-run` here.

The deterministic benchmark never fills the human or agent fields from fixture success. Repeated runs of one provider cannot become an independent-provider study.

## Reproduction

```powershell
flopeek evaluate orientation . --cases benchmarks/orientation-cases.json
flopeek evaluate orientation . --cases benchmarks/orientation-cases.json --condition baseline --format json
flopeek evaluate orientation . --cases benchmarks/orientation-cases.json --condition flopeek --format json
npm run test:orientation
npm run update:orientation-evidence
```

The positional repository is the suite root. Repository paths inside the case file must remain within that root. A single external repository can use `"path": "."` in its own case file.

Checked-in raw runs:

- [`benchmarks/orientation-baseline.json`](../benchmarks/orientation-baseline.json);
- [`benchmarks/orientation-flopeek.json`](../benchmarks/orientation-flopeek.json).

## Interpretation boundary

The initial three-case result is a regression and retrieval proof only. It shows that Flopeek returns ordered static steps and versioned stale detection that the literal condition does not model. Exact symbol-rich search terms make literal retrieval deliberately strong; this suite does not represent orientation from an unconstrained natural-language task. It must not be presented as proof that:

- developers understand arbitrary projects faster;
- AI agents use fewer real provider tokens;
- Flopeek is faster on cold scans;
- every returned flow is runtime-correct;
- business intent is understood;
- unsupported or dynamic behavior does not exist;
- a coding change will be correct or safe.

Those claims require larger pinned repositories plus separately designed consented human and provider studies.

The provider-study successor is the [agent comparison protocol](agent-comparison-protocol.md). Its checked public artifact remains `not-run` until explicitly supplied provider executions exist.
