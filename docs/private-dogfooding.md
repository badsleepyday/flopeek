# Private dogfooding protocol

This protocol records scale and safety observations from repositories that cannot be published with Flowpeek. It protects the target repository while still producing useful product evidence.

## What is retained

- an anonymous repository alias;
- aggregate parser coverage, graph size, endpoint count, and bounded scan duration;
- an explicit completion, failure, or time-budget status;
- product findings and their verification status.

## What is never retained

- machine paths, repository names, source bodies, configuration values, credentials, logs, Context Refs, Git revisions, or target test output;
- runtime or business-flow claims;
- a claimed provider quorum when reviewer runs are from one provider family.

## Safe execution

Use an in-memory scan with identity and cache persistence disabled. Do not run the target application, install dependencies, invoke its test suite, or write into its worktree.

```powershell
npm exec -- flowpeek scan D:\path\to\repository --format json --no-cache
```

`--no-cache` does not create `.flowpeek` cache or project-identity metadata. Existing Flowpeek configuration can still be read to determine the intended source scope.

## How to interpret an empty Flow Lens catalog

A Flow Lens exists only when Flowpeek extracts a supported static HTTP/request endpoint. A repository with zero Flow Lenses can still have a useful technical map: use Feature overview, Find code, and Direct dependencies. It does not imply that the application has no behavior or no runtime entry point.

## Current anonymous observation

The checked summary is [`private-dogfood-summary.json`](../benchmarks/private-dogfood-summary.json). It covers completed Go, JavaScript, mixed-workspace, and multi-repository scans plus one explicitly time-bounded large-workspace attempt.

This is scale and parser-coverage evidence only. Relationship accuracy remains bounded by the audited corpus, and performance remains host-specific.
