# ADR-018: Keep Canvas as the bounded-map default; expose WebGL only as a preview

**Status:** Accepted  
**Date:** 2026-07-18

## Context

Flopeek deliberately renders bounded technical projections, not whole-repository
canvases. Its current Cytoscape.js Canvas renderer preserves Flow Lens selection,
directional focus, visible relationship labels, and the inspector/Context Ref
workflow.

Cytoscape.js offers an experimental WebGL preview. Its documented constraints
matter to Flopeek: sprite-backed labels can take time to buffer; `taxi` and
`segments` edge styles fall back poorly; and several visual features are not yet
equivalent to Canvas. A faster renderer would not justify hiding evidence labels,
changing a selected Context Ref, or widening the map beyond its projection budget.

Sources: [Cytoscape.js 3.31 release](https://blog.js.cytoscape.org/2025/01/13/3.31.0-release/)
and [WebGL preview notes](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/).

## Decision

- Canvas remains the supported default renderer.
- The local Viewer offers an explicit **WebGL preview** selector for bounded maps.
- WebGL preview uses Bezier edges rather than the Canvas `taxi` edges, because
  `taxi` is outside the preview's reliable feature set.
- A WebGL construction failure immediately falls back to Canvas and tells the
  person why. Node IDs, Context Refs, inspector data, selection, and graph facts
  do not change with the renderer.
- The selector is an exploration aid, not a performance claim or automatic
  renderer choice.

## Local observation

On 2026-07-18, the local Viewer loaded the same bounded Flopeek projection in
Canvas and then in WebGL preview. The selector retained the graph and controls;
the Viewer marked the map `WebGL preview: experimental`. This confirms only
available local construction and selection parity. It is not a cross-device
benchmark, a first-paint result, a memory measurement, or a readability result.

## Consequences

Flopeek gains a safe way to evaluate WebGL without presenting it as current
dense-map support. Canvas accessibility and evidence-focused interaction remain
the product baseline. Any default-renderer migration needs all of the following:

1. pinned small, medium, and dense bounded projection fixtures;
2. reproducible Canvas-versus-WebGL load, focus, interaction, stable-frame, and
   memory measurements;
3. completed human readability and accessibility review; and
4. no regression in Context Ref, selection, label, screenshot, or keyboard
   navigation behavior.

Until then, WebGL remains an optional preview and not a supported performance
guarantee.
