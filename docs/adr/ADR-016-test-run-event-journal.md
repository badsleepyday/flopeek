# ADR-016: Test-run adapter event journal

Status: accepted as a partial QA foundation.

## Decision

Flopeek exposes an append-only event protocol for explicit test-runner adapters. Events bind a run to the current Flow Context Ref and one displayed static Flow Lens step where applicable. A validated sequence reports run start, step start/pass/fail, and terminal pass/fail/cancel state. The grouped projection exposes the current step and failure stop step.

Flopeek does not execute repository commands through MCP. Repository-owned test configuration remains executable truth. The journal accepts only sanitized single-line summaries and excludes source bodies, credentials, machine paths, and raw logs.

## Contract boundary

The per-flow interface reports HTTP method, route, and exact handler when backed by parser facts. The narrow Next.js pilot may expose one exact handler's inline request type literal and returned literal JSON bodies with explicit numeric status. Dynamic/unsupported forms remain `unavailable`; human examples or route-name inference must not be promoted to parser facts.

## Follow-up requirements

- validate the narrow schema extractor on a consented production-shaped repository;
- prove a local runner adapter against a repository-owned command outside the MCP shell boundary;
- define retention/archive behavior before automatic high-volume event collection;
- validate explicit cross-project contract references before any multi-service flow composition.
