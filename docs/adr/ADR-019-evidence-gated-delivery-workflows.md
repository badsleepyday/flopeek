# ADR-019: Evidence-gated local delivery workflows

**Status:** Accepted  
**Date:** 2026-07-18

## Context

Flopeek needs to connect a planned work item with the technical Context Cards it
affects, while preserving a hard boundary: a delivery status must never rewrite
parser facts or claim that a change executed successfully.

Teams also use different methods. A product-specific Agile board or an
unconstrained canvas would either hard-code one process or allow a task to be
marked complete without inspectable evidence.

## Decision

- Store plans and actual delivery events separately from the Evidence Graph in
  `.flopeek/delivery/`.
- Make actual delivery events append-only and associate each record with one
  project plus optional versioned Context Refs.
- Define `flopeek-workflow/v1` with an initial state, named states, allowed
  transitions, optional roles, and required evidence kinds.
- Ship local **Agile** and **Waterfall** templates. Custom local templates use
  the same schema and cannot replace a built-in template.
- Assigning a workflow and transitioning it both append an event. The current
  state is derived from that event history.
- A transition only checks that required local evidence references are present.
  It does not execute code, validate a remote CI result, authenticate an
  approval, deploy anything, or prove runtime behavior.

## Consequences

Flopeek can provide a trustworthy local ledger for planned-versus-actual work
without becoming a project tracker, CI system, or deployment control plane.
People and agents must still resolve referenced Context Refs and inspect the
underlying evidence. A stale Context Ref cannot satisfy the built-in
`current-context` requirement.

Future HTTP, Viewer, CLI, and MCP surfaces must call the same engine rather than
changing workflow state directly. External evidence and permissions require
separate integration contracts.
