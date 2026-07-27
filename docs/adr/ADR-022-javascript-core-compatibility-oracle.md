# ADR-022: JavaScript core compatibility oracle

Status: accepted

## Context

Flopeek's current JavaScript implementation is the only complete implementation
of scanner facts, evidence edges, static entry flows, coverage, and capability
metadata. A future native core or storage backend must not redefine those facts
implicitly while improving performance.

The serialized graph cache is not a suitable parity artifact by itself. It
contains machine- and session-specific state such as the absolute repository
root, local project identity, Git metadata, timestamps, graph version, and cache
status. Comparing the whole file would create false drift across otherwise
equivalent scans.

## Decision

The JavaScript implementation remains the source-of-truth compatibility oracle
until a separately reviewed migration promotes another implementation.

`flopeek-core-compatibility/v1` projects the stable static-fact boundary:

- graph schema version, aggregate statistics, parser coverage, and capability
  metadata;
- normalized nodes excluding local manual descriptions;
- evidence edges;
- supported and diagnostic static flows.

The projection deliberately excludes machine-, Git-, cache-, and session-local
state. The committed `flopeek-js-core-baseline/v1` manifest pins source and
compatibility digests for every fixture with audited relationship expectations.
CI fails closed when a fixture or projected fact drifts. Updating the manifest
requires an intentional `npm run update:core-baseline` operation and review of
the semantic change.

During native-core development, Flopeek JS continues to orient and assess each
repository change. The native implementation must also emit or be adapted to the
same compatibility projection and match the pinned cases before it can replace
any JavaScript path.

## Consequences

- Parser and graph semantics can change, but drift is explicit and reviewable.
- Native implementation order, internal IDs, storage layout, and concurrency may
  differ only where the compatibility projection remains equivalent.
- Storage migration, performance, runtime behavior, and cache migration need
  separate gates; this contract does not claim them.
- The JavaScript core is retained throughout the migration as the fallback and
  dogfooding engine. Removal requires a later ADR with parity evidence.
