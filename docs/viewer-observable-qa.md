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

## Current local repair evidence

Gate C recorded one isolated local Chromium observation on the dirty
development tree at graph version 637. It verified a visible default Flow Lens,
a readable domain-level projection, non-overlapping controls at 800px, and
keyboard opening of a detected static flow. The paired machine-checkable result
is the focused Viewer suite (9/9) and the full suite (296/296). Review artifacts
are stored in `.agent-team/reviews/iteration-47/`.

This is deliberately **not** a cross-browser or accessibility certification.
Screen readers, 200% zoom, touch interaction, other browsers, and other
platforms remain unknown until directly observed and recorded.

## Manual session checklist

Use the same commit, local repository, graph version, and browser build when
recording a manual review.

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

Record each outcome as `passed`, `failed`, or `unknown`, with the graph version
and a screenshot or reproducible observation. Missing manual evidence remains
`unknown`; it must not be reported as a release-ready accessibility result.

# Bounded cancellation fixture

Run `npm run qa:viewer-cancellation` for the deterministic local DF-010 fixture. It creates a temporary static TypeScript repository, persists a complete baseline graph, and serves it with a bounded 30-second scan budget plus an eight-second harness-only analysis delay. The fixture is deleted when the process is stopped.

In the Viewer, choose **Scan repository**, verify the `Scanning` badge and visible **Cancel** control, then cancel. The terminal state must retain the complete prior graph and show `stale-unverified`; it must never show a partial graph as current.
