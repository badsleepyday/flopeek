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

S5 is `partial`: the automated Viewer contract is current, and scoped manual
observation exists, but it is not an accessibility or cross-platform
certification.

The current product-code evidence target is commit
`beccef32af9b0a978d4463a90806aeb66a8f1a28`.
Its [six-job CI matrix](https://github.com/badsleepyday/flopeek-core/actions/runs/30161751505)
passed on Ubuntu, Windows, and macOS with Node 20 and 22, including the
repository-owned Viewer, package, and clean-room MCP checks.

On 2026-07-25, one browser-assisted engineering observation on a single host
ran the checkout showcase against that target. It activated the detected Flow
Lens with the keyboard after clearing focus, applied the declared disposable
source change, inspected the v1-to-v2 before/current comparison, reset the
workspace to v3, and resolved the v2 Flow Context Ref as `stale`. At a 390 px
wide viewport, the document had no global horizontal overflow. The target
application was not executed.

This is a reproducible local engineering observation, not a human-readability,
assistive-technology, 200%-zoom, touch, cross-browser, cross-device, or
independent-provider result.

On 2026-07-26, the maintainer reported completing manual S5 checking with the
browser application named Chrome on Windows, Linux, Android, and iPhone. No
physical macOS device was available for that session. Browser versions,
viewport and zoom settings, assistive-technology configuration, screenshots,
and the individual outcomes for the checklist below were not captured in the
evidence bundle. This is an attributed maintainer scope report only; it does
not turn the reported platforms into reproducible accessibility, browser-engine,
or release-certification evidence.

This is deliberately **not** a cross-browser or accessibility certification.
Screen readers, 200% zoom, touch interaction, other browsers, macOS, and any
check not directly observed and recorded remain `unknown`.

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
[`flopeek-independent-review/v1`](schemas/flopeek-independent-review.schema.json)
artifact with the actual reviewer, provider/model/run identity, and evidence
references. Missing manual evidence remains `unknown`; it must not be reported
as a release-ready accessibility result. A provider name or reviewer persona
does not prove a distinct-provider quorum.

# Bounded cancellation fixture

Run `npm run qa:viewer-cancellation` for the deterministic local DF-010 fixture. It creates a temporary static TypeScript repository, persists a complete baseline graph, and serves it with a bounded 30-second scan budget plus an eight-second harness-only analysis delay. The fixture is deleted when the process is stopped.

In the Viewer, choose **Scan repository**, verify the `Scanning` badge and visible **Cancel** control, then cancel. The terminal state must retain the complete prior graph and show `stale-unverified`; it must never show a partial graph as current.
