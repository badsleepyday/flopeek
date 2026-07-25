# Flowpeek checkout showcase

## Purpose

The checkout showcase is a safe, guided product demonstration. It proves that the current Flowpeek build can expose one shared static context through the local viewer, HTTP API, and MCP; retain a live adjacent graph delta; resolve an older Context Ref as stale; and display a before/current Flow Lens comparison.

It is not independent benchmark evidence, a human study, an AI-agent outcome study, runtime verification, business-intent verification, or a claim that unsupported behavior is absent.

## Start from a clean clone

```powershell
npm install
npm run showcase
```

The command:

1. validates `examples/commerce-showcase/flowpeek-showcase.json`;
2. copies the example into a uniquely marked operating-system temporary directory;
3. starts the ordinary loopback Flowpeek server with port fallback;
4. opens a deep link to `POST /api/checkout`;
5. leaves the target application unexecuted.

The original example remains unchanged and receives no `.flowpeek` cache. Closing the showcase process removes the temporary workspace unless `--keep-workspace` was supplied.

## Inspect the baseline

The viewer opens the primary Flow Lens automatically. Its static path includes:

```text
POST /api/checkout
  -> POST handler
  -> checkout
  -> validateCart / loadDiscountRule / reserveInventory
  -> authorizePayment
  -> authorizeProvider / saveOrder
  -> publishOrderCreated / Prisma client (within the bounded projection)
```

The fan-out is static relationship evidence, not an assertion of runtime ordering. `src/checkout/discount.ts` deliberately contains a computed dynamic import. Flowpeek does not resolve that target; the missing edge does not prove that the runtime discount behavior is absent.

Use **Copy Flow Context Card** in the inspector. The copied packet includes the project ID, graph version, exact Flow Context Ref, displayed static steps, transition evidence, truncation, directly related test evidence, and limitations without source-file bodies.

## Apply the declared change

Open another terminal and run the exact command printed by the showcase process or copied from the blue viewer guide:

```powershell
flowpeek showcase apply "<temporary-workspace>"
```

This command is accepted only when `<temporary-workspace>` contains a valid `flowpeek-showcase-workspace/v1` marker and the declared source has either its baseline or changed hash. It refuses an arbitrary directory and refuses to overwrite diverged source.

The change replaces the direct `authorizePayment -> saveOrder` relationship with:

```text
authorizePayment -> reviewRisk -> saveOrder
```

The running server watches the temporary source, incrementally refreshes the graph, and advances the graph version. The live tray identifies `src/checkout/payment.ts`, the affected checkout flow, the source-changed step, and the retained comparison.

Open **Compare before/current**. The comparison should report:

- `reviewRisk` as an added static step;
- changed transitions around `authorizePayment` and `saveOrder`;
- the prior Flow Context Ref as stale;
- source and topology change evidence from one adjacent graph delta.

The two sides are bounded snapshots. They are not reconstructed runtime history.

## Inspect impact and related tests

The affected payment source maps to `test/checkout.test.ts` through direct stored parser relationships. This is a candidate for repository-owned verification, not proof that the test covers every checkout behavior. Flowpeek does not run the example test or install its declared integrations.

For an agent host configured against the temporary workspace, the equivalent safe sequence is:

```text
get_agent_bootstrap
get_entry_flows
get_flow_projection
get_flow_context_card
get_related_tests
refresh_graph
get_changed_contexts
get_flow_comparison
resolve_context_ref
```

Viewer, HTTP, and MCP must report the same project ID, graph version, primary flow ID, displayed step IDs, and Flow Context Ref for the same graph state. MCP retains no arbitrary shell or repository-source write tool; the explicit showcase CLI owns the bounded demonstration mutation.

## Reset or inspect status

```powershell
flowpeek showcase status "<temporary-workspace>"
flowpeek showcase reset "<temporary-workspace>"
```

`status` reports `baseline`, `changed`, or `diverged` by comparing only the declared source file with the two committed hashes. It is not Git cleanliness or runtime status. `reset` has the same marker and divergence protections as `apply`.

Use this only when the workspace must remain after the server closes:

```powershell
flowpeek showcase --keep-workspace
```

The retained path is printed explicitly. It can be deleted after inspection because it is a generated temporary copy.

## Verification

```powershell
npm run test:showcase
```

The test validates temporary-copy confinement, idempotent apply/reset, divergence refusal, viewer assets, HTTP context, real MCP stdio parity, live graph refresh, stale Context Ref resolution, before/current comparison, related-test impact, cleanup, and the no-target-execution boundary.
