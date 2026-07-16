---
name: flowpeek
description: Use Flowpeek's deterministic local graph and Context Refs to orient work in an unfamiliar repository, locate entry points and bounded application flows, assess static impact and related tests, detect stale context, compare before/current flow evidence, and create an evidence-backed handoff. Use before planning or reviewing repository changes and again after source edits.
---

# Flowpeek

Ground repository work in Flowpeek's current static evidence without treating the graph as runtime or business truth.
Use a graph-first workflow with source fallback whenever deterministic evidence is incomplete.

## Workflow

1. Call `get_agent_bootstrap` before relying on graph results. Read its graph identity, readiness, coverage, policy, and limitations.
2. Call `get_handoff_context` with the task intent when the task is known. Otherwise use `get_project_overview`, `find_nodes`, and `get_request_flows` to find a bounded starting point.
3. Resolve implementation evidence with `get_node`, `get_flow_projection`, `get_flow_context_card`, `get_direct_dependencies`, and `get_related_tests` before proposing a change.
4. Read source with the host's workspace tools whenever coverage is incomplete, a construct is inventory-only, or graph evidence is insufficient. Never claim that missing graph evidence proves missing behavior.
5. Edit source only with the host's workspace tools. Flowpeek does not expose repository-source writes, arbitrary shell execution, credentials, deployments, or target-application execution.
6. After source changes, call `refresh_graph`. Inspect `get_changed_contexts`, `get_flow_comparison`, and `get_change_impact` before reusing an earlier Context Ref.
7. Run repository-owned tests and checks with approved host tools. Flowpeek's related-test results are static candidates, not test-success evidence.
8. Report the Context Refs, graph version, parser evidence, verification performed, unsupported areas, and unresolved questions that support the conclusion.

## Evidence Rules

- Treat deterministic parser facts as static code evidence only.
- Do not infer runtime order, successful side effects, dynamic dispatch, business intent, or complete behavioral coverage from static edges.
- Resolve a Context Ref again after every graph refresh. Do not silently reuse stale evidence.
- Keep agent proposals separate from parser facts and human verification.
- Use direct source, test, runtime, or human evidence when Flowpeek explicitly abstains or reports incomplete coverage.
- Do not store source bodies, secrets, prompts, private reasoning, or raw command logs in Flowpeek metadata.

## Completion Check

Before claiming completion, confirm that the graph was refreshed after edits, changed contexts were reviewed, relevant repository checks were run, and limitations remain explicit.
