# ADR-005: Adapter capability registry

## Status

Accepted.

## Context

Adapter support statements previously appeared in scanner output and human documentation independently. That made it easy for a parser change, API context, and support matrix to drift apart.

## Decision

`src/adapter-registry.js` is the declarative source of truth for general adapter capability metadata. It uses the versioned `flopeek-adapter-capabilities/v2` schema, separates product capability from JavaScript/native implementation availability, validates closed vocabulary and fields, and returns deterministically sorted records. It never reads the scanned repository or executes target code/configuration.

Graph `analysis.adapterCapabilities`, `/api/capabilities`, and agent context expose the same registry. Repository-specific `analysis.coverage` remains a separate parse-result report. Generated material in `SUPPORT.md` is produced from the registry and `check:support` rejects drift without writing files.

Toolchain-conditional entries explicitly name their required local toolchain. The registry describes only proven static support; it does not claim runtime execution, dynamic dispatch, dependency injection, reflection, or relationship recall outside audited slices.

Test lanes are explicit so a pull-request fast lane can validate the registry, core contracts, flow verification, fixture precision/recall, and generated documentation without cloning external repositories or starting optional Go/.NET helpers. The complete lane retains every existing test, while the external corpus remains scheduled separately.

## Consequences

Adding or changing an adapter requires updating the registry, generated support output, and contract evidence together. Semantic suggestions and generic workflow behavior remain outside this decision.
