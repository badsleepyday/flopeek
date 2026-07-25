# ADR-014: Central multi-project serve workspace

Status: accepted and implemented for local project activation.

## Decision

Flowpeek supports two serve modes. Per-project mode keeps one graph server for one repository. Global mode (`serve -g`) exposes one user-facing hub port and activates multiple independently identified project roots behind it. The browser selects one active project; ordinary API and SSE traffic is routed to that project's isolated scanner, graph, watcher, version, and `.flowpeek` cache.

A workspace definition is machine-local operational state outside scanned repositories. It may contain absolute roots and is never included in portable Handoff Workspace exports. An occupied port advances without terminating another process unless `--strict-port` requests explicit failure. A separate process-bound live registration records the actual loopback hub endpoint, so later commands using the same explicit workspace ID rejoin the fallback port instead of creating a second hub; exact-instance cleanup prevents an older process from deleting a newer registration.

## Boundaries

- The hub does not merge graphs.
- Equal names, routes, features, or symbols never create cross-project edges.
- Cross-service traces may be recorded only as explicit current-context human contract references; they remain metadata rather than graph edges or runtime proof.
- Internal ephemeral loopback backends are implementation details; the hub URL is the user-facing web source of truth.
- Project activation is a trusted-local mutation and cannot write source.
- A hub-level scan refreshes only the active project's configured root. Root additions and switches use the workspace project-activation endpoint, preserving the definition-to-graph identity boundary.

## Consequences

Microservice and monorepo subprojects can share one orientation surface without weakening per-project identity. Explicit references make intended boundaries auditable; cross-project search and automatic flow composition remain unavailable.
