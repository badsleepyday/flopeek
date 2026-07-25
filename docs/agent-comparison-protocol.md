# Agent comparison protocol

## Purpose

Iteration 33 provides a provider-neutral A/B measurement contract for one question:

> For the same pinned repository task and provider/model, how do supplied task outcomes differ when the agent works directly from the repository versus when it may use Flopeek context?

Flopeek validates and scores supplied records. It does not invoke a provider, open a remote session, execute the target application, collect hidden prompts, or convert an agent answer into parser or human truth.

## Conditions

Each `pairId` contains exactly two executions:

1. `direct-repository` — the provider may inspect the repository with the host's ordinary read-only facilities but must not use Flopeek data, Context Refs, Viewer, HTTP API, cache, skill, or MCP tools.
2. `flopeek` — the same provider and model may use Flopeek MCP/context. The run must record its project ID, graph version, Context Refs, and supported Flopeek tools used.

The two executions require distinct provider sessions to prevent context carry-over. Their order should be randomized outside Flopeek. A larger study should counterbalance order and repeat each case across providers or participants. Flopeek does not infer randomization, blinding, provider independence, or consent.

## Inputs

Copy [`benchmarks/agent-comparison-runs.template.json`](../benchmarks/agent-comparison-runs.template.json) to a private study file and use `flopeek-agent-comparison-runs/v1`, validated by [`flopeek-agent-comparison-runs.schema.json`](schemas/flopeek-agent-comparison-runs.schema.json).

A completed file must declare explicit operator-supplied consent and privacy review. Every execution records only:

- portable study, pair, case, execution, provider, model, and private session identifiers;
- total observed duration supplied by the operator;
- repository-relative inspected paths and a disclosed context-character estimate;
- bounded answer target paths, optional ordered flow-step IDs, related tests, and Context Ref resolution statuses;
- separately reviewed claim IDs/categories/outcomes with evidence references, never claim prose;
- verification status and evidence references;
- optional numeric cost and currency;
- for the Flopeek condition only, graph identity, Context Refs, and supported MCP tools used.

The evaluator rejects unknown fields, absolute or upward-traversing paths, file URLs, multiline metadata, contaminated direct-repository records, unpaired conditions, reused sessions, provider/model mismatch inside a pair, unsupported Flopeek tool names, and measured records without explicit consent.

## Privacy and evidence rules

Do not store source bodies, raw prompts, raw model answers, chain-of-thought, raw logs, credentials, environment variables, machine-local paths, participant identity, email, or account identifiers in the run file. Provider session IDs are accepted only to enforce pair independence and are emitted as short one-way fingerprints in the report.

Evidence classes remain distinct:

- expected paths and ordered steps come from the source-pinned orientation oracle;
- the provider response is `ai-provider-outcome` evidence;
- deterministic scoring against the oracle does not turn the response into parser truth;
- claim-review labels are separately supplied review evidence;
- repository-owned verification remains separate from claim review and static flow evidence;
- an unavailable claim review is not an unsupported-claim rate of zero.

## Metrics

The report gives each condition and the paired delta for:

- target-path recall;
- ordered flow-step recall when the provider returned an order;
- related-test recall;
- stale Context Ref detection rate;
- duration;
- files inspected;
- estimated context tokens using `flopeek-char4-estimator/v1`;
- separately reviewed unsupported-claim rate;
- passed, failed, or unrun verification;
- optional comparable cost.

Positive or negative values apply only to the supplied paired executions. They are not a universal speed, accuracy, cost, or provider ranking.

## Run the evaluator

The checked template intentionally reports `not-run`:

```powershell
npm run evaluate:agent-comparison
flopeek evaluate agent-comparison . --cases benchmarks/orientation-cases.json --runs benchmarks/agent-comparison-runs.template.json
```

Evaluate a separately collected private cohort:

```powershell
flopeek evaluate agent-comparison D:\study-suite `
  --cases D:\study-suite\orientation-cases.json `
  --runs D:\private\agent-comparison-runs.json `
  --format json
```

The command reads and scores the supplied files. It starts no provider and target process. Review the output against [`flopeek-agent-comparison-report.schema.json`](schemas/flopeek-agent-comparison-report.schema.json) before publication.

## Checked public status

[`benchmarks/agent-comparison-report.json`](../benchmarks/agent-comparison-report.json) is `not-run`. It proves only that the template and evaluator contract are available and tested. Public outcome claims require a real privacy-reviewed paired cohort and must retain provider/model, case, omission, failure, verification, and evidence-class boundaries.
