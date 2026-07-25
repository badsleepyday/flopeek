---
name: flopeek
description: Use Flopeek's deterministic local graph and Context Refs to orient work in an unfamiliar repository, locate entry points and bounded application flows, assess static impact and related tests, detect stale context, compare before/current flow evidence, and create an evidence-backed handoff. Use before planning or reviewing repository changes and again after source edits.
---

# Flopeek

Ground repository work in Flopeek's current static evidence without treating the graph as runtime or business truth.
Use a graph-first workflow with source fallback whenever deterministic evidence is incomplete.

## Workflow

1. Call `get_agent_bootstrap` and `get_scan_status` before relying on graph results. Read scan freshness, graph identity, readiness, coverage, policy, and limitations. If the active graph is `stale-unverified`, use it only as the last complete baseline and inspect current source directly.
2. When continuing a Flopeek checkpoint, call `get_continuation_context` with its checkpoint ID and, when selected, its exact planned overlay ID. For each selected work record that declares dependencies, call `get_work_dependency_status` before entering implementation. Treat `blocking`, `unresolved`, and `unknown` as a reason to report the local delivery blocker or obtain human direction; `ready` is only local workflow metadata, never source or runtime proof. Stop for source inspection if the continuation packet reports non-current selected Context Refs. Otherwise call `get_handoff_context` with the task intent, or use `get_project_overview`, `find_nodes`, and `get_request_flows` to find a bounded starting point.
3. If a handoff needs bounded local Git context, call `get_active_branch_git_evidence` only after resolving a current or stale Context Ref. Treat each result solely as a current-path-touch commit list from attached-branch `HEAD`: it is not evidence of original rationale, runtime behavior, review, test success, or release state. Do not use an unavailable result to infer that older evidence is absent.
4. Resolve implementation evidence with `get_node`, `get_flow_projection`, `get_flow_context_card`, `get_direct_dependencies`, and `get_related_tests` before proposing a change.
5. Read source with the host's workspace tools whenever coverage is incomplete, a construct is inventory-only, or graph evidence is insufficient. Never claim that missing graph evidence proves missing behavior.
6. Edit source only with the host's workspace tools. Flopeek does not expose repository-source writes, arbitrary shell execution, credentials, deployments, or target-application execution.
7. Treat Plan Refs as planned delivery intent, not source facts. After source changes, call `refresh_graph`, then confirm `get_scan_status` is complete/current. Inspect `get_changed_contexts`, `get_flow_comparison`, `get_continuation_comparison`, and `get_change_impact` before reusing an earlier Context Ref. An agent may record only a reconciliation proposal; human confirmation remains unresolved. `cancel_scan` may stop an active bounded scan without promoting incomplete evidence; it cannot interrupt unbounded scanning.
8. Run repository-owned tests and checks with approved host tools. Flopeek's related-test results are static candidates, not test-success evidence.
9. Report the Context Refs, graph version, parser evidence, verification performed, unsupported areas, and unresolved questions that support the conclusion.

## Evidence Rules

- Treat deterministic parser facts as static code evidence only.
- Do not infer runtime order, successful side effects, dynamic dispatch, business intent, or complete behavioral coverage from static edges.
- Resolve a Context Ref again after every graph refresh. Do not silently reuse stale evidence.
- Keep agent proposals separate from parser facts and human verification.
- Use direct source, test, runtime, or human evidence when Flopeek explicitly abstains or reports incomplete coverage.
- Do not store source bodies, secrets, prompts, private reasoning, or raw command logs in Flopeek metadata.

## Completion Check

Before claiming completion, confirm that the graph was refreshed after edits, changed contexts were reviewed, relevant repository checks were run, and limitations remain explicit.
