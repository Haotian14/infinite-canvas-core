# infinite-canvas-core

A headless infinite-canvas engine: camera, spatial index, viewport culling and
gestures, with the renderer behind an interface.

Nothing in `src/` outside `renderer/` and `input/` touches the DOM. The engine
runs unchanged in a Worker or in Node, which is what makes headless layout,
server-side thumbnails and fast unit tests possible — and it is the constraint
that keeps the architecture honest.

<!-- PERF:START -->
## Performance

100,000 nodes, 1600x900, measured inside `Canvas2DRenderer.render` — cull query
plus draw calls. Median of 3 runs of 180 frames each.

| scenario | nodes | drawn/frame | render p50 (ms) | p95 | run spread |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pan-close` | 100,000 | 584 | **0.2** | 0.3 | ±0% |
| `pan-mid` | 100,000 | 5,707 | **1.9** | 2.3 | ±16% |
| `zoom-cycle` | 100,000 | 13,922 | **0.7** | 19.6 | ±14% |
| `overview` | 100,000 | 97,619 | **13.8** | 17.5 | ±14% |
| `pan-mid` | 10,000 | 580 | **0.2** | 0.3 | ±0% |

- Viewport query over 100,000 nodes: **40 µs** indexed vs 589 µs for a full
  scan (**15x**), returning ~1,027 hits.
- The worst case — everything on screen at once — went from 49 ms to
  13.8 ms (**3.6x**) via draw-call batching and sub-pixel LOD.

Measured on Intel(R) Xeon(R) Processor @ 2.10GHz (4 cores), headless Chromium 141
with **software rasterisation** (`SwiftShader`), which makes these a lower bound —
a real GPU does better. Run spread is the gap between fastest and slowest
repetition; anything smaller than it is noise.

Full tables, methodology and flame charts: [`bench/results/RESULTS.md`](bench/results/RESULTS.md).
Reproduce with `pnpm bench`.
<!-- PERF:END -->

## Quick start

```ts
import { Camera, Canvas2DRenderer, Scene, attachGestures } from 'infinite-canvas-core';

const camera = new Camera();
const scene = new Scene();
const renderer = new Canvas2DRenderer(canvas);

scene.add({ id: 'a', rect: { x: 0, y: 0, w: 120, h: 80 }, fill: '#6ea8fe' });

camera.setViewport(window.innerWidth, window.innerHeight);
renderer.resize(window.innerWidth, window.innerHeight, devicePixelRatio);
camera.fitToRect(scene.bounds(), 48);

attachGestures(canvas, camera, { onChange: () => renderer.render(scene, camera) });
renderer.render(scene, camera);
```

`examples/basic` is that program, complete, in about fifty lines.

```bash
pnpm install
pnpm demo     # the basic example
pnpm bench    # the benchmark, interactive at examples/bench
pnpm test
```

## Design decisions

These are the ones that are expensive to change later, so they are settled up
front rather than discovered.

**Scale and translation only — no viewport rotation.** Every inverse is a
division instead of a matrix solve, which keeps `screenToWorld` exact and
trivially testable. Rotation is rare enough in canvas products to not be worth
paying for on every coordinate conversion.

**Screen space is CSS pixels; device pixel ratio belongs to the renderer.**
Folding `dpr` into the camera is how you get hit tests that are off by 2x on a
retina display and blurry output on everything else. `Camera` never sees it.

**World coordinates are plain float64 and never hold pixel-derived values.**
Anything that should keep a constant on-screen size — stroke widths, hit
tolerances, handle sizes — divides by `camera.scale` at the point of use.

**The scene is flat.** A parent/child graph makes every bounds query walk a tree
and every mutation invalidate an ancestor chain. Grouping, when it lands, is a
`parentId` plus a resolved-transform pass, which keeps mutation O(1).

**Hit testing is geometric, not colour-picked.** Rendering ids into an offscreen
buffer and reading pixels back is easy to write and impossible to run headless —
it would tie the engine to a canvas, which is the one thing this design avoids.

**The engine owns no render loop.** `Camera` and `Scene` expose a `version`
counter; when to redraw stays the host's decision.

## Status

- [x] **M0** — camera, Canvas2D renderer, mouse/trackpad/touch gestures, inertia
- [x] **M1** — uniform-grid spatial index, viewport culling, benchmark harness
- [ ] **M2** — hit testing, selection, drag, marquee, snapping
- [ ] **M3** — command stack, undo/redo, serialisation
- [ ] **M4** — React bindings, and a whiteboard demo built on the public API
- [ ] **M5** — CRDT collaboration (Yjs or Loro), as a separate package

The spatial index arrived during M0 because the benchmark could not produce a
meaningful number without it.

Two caveats on what "done" means above:

- **M1's target was 60 fps at 100k nodes, and p95 does not quite meet it** in
  the two scenarios that pass through full zoom-out — 16.9 ms and 18.6 ms
  against a 16.7 ms budget, on a software rasteriser. p50 clears it everywhere.
  Dirty-rectangle rendering is the fix; see below.
- **No keyboard shortcuts yet.** `Camera` has `zoomTo` and `fitToRect`, but
  nothing binds zoom-to-fit or reset-to-100%.

Known gaps, in rough priority order:

- **Dirty-rectangle rendering.** Every frame is a full redraw today. Static
  content on its own layer would make idle frames nearly free, and is what
  closes the p95 gap above.
- **R-tree.** A uniform grid degrades on content much denser or sparser than one
  item per cell. `UniformGrid` is behind an interface so it can be swapped.
- **Sub-pixel LOD drops antialiasing and exact z-order.** Fine for a hundred
  thousand specks; wrong the moment two overlapping shapes must layer exactly.
- **No WebGL renderer.** Deliberately — Canvas2D with culling and LOD gets
  further than people expect, and the `Renderer` interface keeps the door open.

## Input

`attachGestures` covers the three input families from one state machine: the
centroid of the active pointers is what gets dragged, and their mean distance
from it is the zoom. One pointer just has a constant spread, so a mouse drag and
a two-finger pinch are the same code path instead of two that disagree at the
edges.

| input | behaviour |
| --- | --- |
| wheel / two-finger scroll | pan |
| ctrl+wheel, trackpad pinch | zoom, anchored under the cursor |
| middle-drag, space+left-drag | pan |
| one finger | pan (set `singleTouch: 'ignore'` to leave it for selection) |
| two fingers | pinch zoom and pan together |
| flick | coasts to a stop; `inertia: false` turns it off |

It takes over the element's `touch-action` on attach and restores it on detach,
because the browser's native scrolling would otherwise swallow touch input
before any handler sees it.

## Layout

```
src/
  camera.ts            world <-> screen, zoom anchoring, fit-to-content
  scene.ts             flat node store, indexed
  spatial/             uniform grid index
  renderer/            Renderer interface, Canvas2D backend, LOD pixel buffer
  input/gestures.ts    wheel/pinch/drag state machine
  math/rect.ts         rectangle primitives
bench/                 headless benchmark runner and profile tooling
examples/basic         the smallest useful program
examples/bench         100k-node playground, and the harness the runner drives
```

## Development

```bash
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit, strict
pnpm build          # dist/
pnpm bench          # --stress for 1M nodes, --headed to watch, --reps=N
```

The spatial index is property-tested against a brute-force scan: every query
must return exactly what a full scan would. That test is what made it safe to
rewrite the query hot path for a 15x speedup without hand-verifying anything.

MIT.
