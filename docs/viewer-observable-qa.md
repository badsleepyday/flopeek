# Viewer Observable QA

The local Viewer is a bounded technical-evidence surface. This protocol keeps
its accessibility and recovery claims testable without treating a rendered map
as runtime proof or a manual observation as parser evidence.

## Automated baseline

`test/unit/viewer-observable-qa.test.js` verifies the shipped Viewer asset
contract exposes:

- a supported Flow Lens and keyboard-operable flow list;
- a non-canvas description of map navigation;
- visible, textual evidence distinctions for static, aggregate, planned, and
  inventory-only entities;
- a clear statement that static relationships are not runtime order;
- responsive and reduced-motion CSS safeguards.

Run it with:

```powershell
node --test test/unit/viewer-observable-qa.test.js
```

This is an automated delivered-asset contract. It does not substitute for a
screen-reader, browser zoom, or human readability observation.

## Current S5 evidence status

The current public Core baseline is commit `7d15b3731bae5a66792aac6ac80829c1fa1a9534`.
Its [six-job CI matrix](https://github.com/badsleepyday/flowpeek/actions/runs/30156326025)
passed on Ubuntu, Windows, and macOS with Node 20 and 22, including the
repository-owned Viewer, package, and clean-room MCP checks.

One engineering observation on a single host also opened the checkout showcase,
advanced its static graph from v1 to v2, inspected the before/current Flow Lens
comparison, recovered the current Flow Lens with the keyboard, and confirmed no
global page overflow at a narrow viewport. It is a reproducible local
observation, not a human-readability, assistive-technology, cross-browser, or
cross-device result.

This is deliberately **not** a cross-browser or accessibility certification.
Screen readers, 200% zoom, touch interaction, other browsers, and other
platforms remain `unknown` until directly observed and recorded.

## Manual session checklist

Use one immutable candidate commit, local repository, graph version, browser
build, operating system, viewport, and assistive-technology setup when
recording a manual review. Do not mix observations from different revisions.

1. Tab from **Find code** to a detected static flow, open it with the keyboard,
   and return through the visible controls.
2. At 200% browser zoom and a narrow viewport, confirm that the Flow Lens,
   level selector, map boundary, omission count, and inspector remain readable.
3. Confirm that solid/static, double-border aggregate, dashed planned, dotted
   inventory-only, and stale/removed states can be distinguished without color.
4. Trigger a bounded refresh, then a failed or cancelled refresh, and confirm
   the last complete evidence projection remains identifiable and recoverable.
5. Change semantic level, select a node, refresh, and confirm that retained
   focus and viewport behavior match the Viewer status.
6. With a screen reader, complete the same flow-opening and recovery journey;
   record any missing name, order, state change, or recovery path as `failed`
   or `unknown` rather than inferring support from the DOM.

Record each outcome as `passed`, `failed`, or `unknown`, with the graph version
and a screenshot or reproducible observation. Store a schema-valid
[`flowpeek-independent-review/v1`](schemas/flowpeek-independent-review.schema.json)
artifact with the actual reviewer, provider/model/run identity, and evidence
references. Missing manual evidence remains `unknown`; it must not be reported
as a release-ready accessibility result. A provider name or reviewer persona
does not prove a distinct-provider quorum.

# Bounded cancellation fixture

Run `npm run qa:viewer-cancellation` for the deterministic local DF-010 fixture. It creates a temporary static TypeScript repository, persists a complete baseline graph, and serves it with a bounded 30-second scan budget plus an eight-second harness-only analysis delay. The fixture is deleted when the process is stopped.

In the Viewer, choose **Scan repository**, verify the `Scanning` badge and visible **Cancel** control, then cancel. The terminal state must retain the complete prior graph and show `stale-unverified`; it must never show a partial graph as current.
