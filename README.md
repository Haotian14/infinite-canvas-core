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
| `pan-close` | 100,000 | 584 | **0.2** | 0.4 | ±50% |
| `pan-mid` | 100,000 | 5,707 | **1.9** | 2.3 | ±11% |
| `zoom-cycle` | 100,000 | 13,922 | **0.8** | 15.7 | ±14% |
| `overview` | 100,000 | 97,619 | **13.8** | 15.1 | ±17% |
| `pan-mid` | 10,000 | 580 | **0.2** | 0.3 | ±0% |

- Viewport query over 100,000 nodes: **48 µs** indexed vs 604 µs for a full
  scan (**13x**), returning ~1,027 hits.
- The worst case — everything on screen at once — went from 44 ms to
  13.8 ms (**3.2x**) via draw-call batching and sub-pixel LOD.

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

**No `#private` class fields.** They cost a WeakMap lookup per access once a
bundler downlevels them, and bundlers downlevel them by default — Vite's default
target includes Safari 14, which predates the syntax. On this project's own
landing page that turned an 11 ms frame into a 36 ms one, a 3.3x regression that
shows up only in a consumer's production build and never in dev. TypeScript's
`private` gives the same encapsulation and compiles to a plain property, so
there is nothing to downlevel. A test enforces it.

**Writing a renderer is meant to be ordinary.** `Renderer` is three methods, and
`LodBuffer` — the pixel buffer that makes sub-pixel shapes cheap — is exported
for the purpose, because that is the part that is awkward to get right. The
landing page's own renderer, which draws lit spheres instead of rectangles,
lives in `site/renderer.ts` and required no change to `src/`.

**The engine owns no render loop.** `Camera` and `Scene` expose a `version`
counter; when to redraw stays the host's decision.

## Status

- [x] **M0** — camera, Canvas2D renderer, mouse/trackpad/touch gestures, inertia
- [x] **M1** — uniform-grid spatial index, viewport culling, benchmark harness
- [x] **M2** — hit testing, selection, drag, marquee, snapping
- [x] **M3** — command stack, undo/redo, serialisation
- [x] **M4** — React bindings, and a whiteboard demo built on the public API
- [ ] **M5** — CRDT collaboration (Yjs or Loro), as a separate package

The spatial index arrived during M0 because the benchmark could not produce a
meaningful number without it. M4 changed five things in `src/` — every one of
them found by building the whiteboard rather than by designing the bindings.

Two caveats on what "done" means above:

- **M1's target was 60 fps at 100k nodes, and p95 does not quite meet it** in
  the two scenarios that pass through full zoom-out — 16.9 ms and 18.6 ms
  against a 16.7 ms budget, on a software rasteriser. p50 clears it everywhere.
  Dirty-rectangle rendering is the fix; see below.
- **The canvas element itself is not keyboard-focusable.** `attachKeyboard`
  binds to the window, so zoom and pan work without focus, but there is no
  roving focus over the content.

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

## Selection

The pieces are headless and usable on their own; `attachSelectTool` is the
wiring, and it draws nothing. It reports a marquee rectangle and a set of
alignment guides, and leaves rendering to the renderer — the only part that
knows what anything looks like. `examples/select` is that other half.

```ts
const selection = new Selection();

const tool = attachSelectTool({
  element: canvas,
  scene,
  camera,
  selection,
  onChange: draw,
  // Content that is not rectangular supplies its own test.
  contains: ellipseContains,
});
```

| | |
| --- | --- |
| click / shift-click | select, add, remove |
| drag a node | move the whole selection |
| drag empty space | marquee — enclosing when dragged right, touching when dragged left |
| `alt` while dragging | bypass snapping |
| `esc` | put the drag back, selection included |

**Hit testing is geometric.** The index narrows the scene to the few nodes
whose bounds could match, and only those pay for the precise test. Rendering
ids into an offscreen buffer and reading pixels back is easy to write and
impossible to run without a canvas, which would tie the engine to a renderer.

**Snapping is measured from the drag's anchor, not accumulated per frame**, so
a snap that takes on one frame and releases on the next leaves no permanent
offset. Only what is on screen is considered: aligning to something a mile away
is not a feature, and it would cost a pass over the whole scene every frame.

**Thresholds are in world units.** `computeSnap` and the hit tolerance both
take world distances, so the caller converts with
`camera.screenToWorldDistance`. A tolerance that is constant in world units
becomes unusable as you zoom out.

## History and persistence

Patches, not snapshots. A snapshot per undo step is unaffordable at the sizes
this is built for — a hundred thousand nodes copied on every nudge — and a
patch is also the shape a collaboration layer needs, so one representation
carries both.

```ts
const history = new History(scene);

// Applies the patches and records the step, inverses computed from the
// scene as it was before.
history.run('delete', ids.map((id) => ({ op: 'remove', id })));
history.undo();
```

There are two ways in, because interactions come in two shapes. `run` applies
and records, for changes that happen at once. `record` takes a change the
caller has already made plus the patches that undo it — a drag moves nodes on
every pointer event, and recording each of those would fill the stack with
frames of one gesture, so `attachSelectTool` mutates live and commits a single
step on release.

```ts
attachSelectTool({ element, scene, camera, selection, history });
```

`transact` groups several changes into one step and nests, so a routine that
batches internally still merges into its caller's step.

### Saving

```ts
localStorage.setItem('doc', JSON.stringify(serializeDocument(scene, camera)));
deserializeInto(scene, JSON.parse(localStorage.getItem('doc')).scene);
```

Nodes are written back to front and carry no depth field: order **is** depth,
so the format has one representation of it rather than two that can disagree.
The spatial index is not written either — it is derived, and rebuilding it on
load is faster than parsing it.

`deserializeInto` loads into the scene you already have, and is usually what
you want. Returning a fresh instance leaves every reference to the old one —
renderer, tool, history — silently stale, and the symptom is an editor that
looks loaded but is still driving the document you left behind. Validation runs
before anything is cleared, so a bad snapshot throws and leaves the scene
untouched.

## React

```bash
npm i infinite-canvas-core react
```

A separate entry point, with React as an *optional* peer. The engine stays
dependency-free and nothing in here is reachable — or bundled — unless it is
imported: the bindings add 1.6 kB min+gzip on top of the 9.3 kB core.

These are hooks, not components. A component would have to decide the markup
and the styling of a thing whose whole point is that the host draws it.

```tsx
import { Camera, Canvas2DRenderer, History, Scene, Selection } from 'infinite-canvas-core';
import {
  useCanvas, useConstant, useGestures, useHistoryState, useSelectTool,
} from 'infinite-canvas-core/react';

function Board() {
  // The document lives outside React. These are the same objects a vanilla
  // host would hold; the hooks only watch them.
  const camera = useConstant(() => new Camera());
  const scene = useConstant(() => new Scene<Item>());
  const selection = useConstant(() => new Selection());
  const history = useConstant(() => new History(scene));

  const { ref, element, invalidate } = useCanvas({
    scene,
    camera,
    renderer: (canvas) => new Canvas2DRenderer(canvas),
    watch: [selection],
  });

  useGestures(element, camera, { onChange: invalidate });
  useSelectTool(element, { scene, camera, selection, history, onChange: invalidate });

  const past = useHistoryState(history);
  return (
    <div className="board">
      <canvas ref={ref} />
      <button disabled={!past.canUndo} onClick={() => history.undo()}>undo</button>
    </div>
  );
}
```

**React's cadence is the frame, not the mutation.** The engine reports change
by incrementing a counter rather than by emitting events, and the bindings keep
it that way: one shared animation frame polls the counters, so a drag that
moves a hundred nodes per pointer event costs at most one render per subscriber
per frame instead of hundreds. The loop runs only while something is watching.
There is a test that forty camera changes between two frames produce exactly
one render.

**Rendering is on demand.** A frame is drawn when the camera, the scene or
anything in `watch` has moved, or when you call `invalidate` for something the
counters cannot see — a marquee rectangle, an image that finished loading. An
idle board draws nothing at all; the demo measures zero frames over a second of
sitting still.

**Callbacks are read through a ref, value options by their values.** A handler
written inline is a new function on every render; listing it as a dependency
would tear the pointer listeners down and rebuild them sixty times a second
mid-drag, and ignoring it would leave them calling the first render's closure.
Passing a new `onChange` does not re-attach; changing `tolerance` does.

`useCanvas` also owns the parts of the canvas lifecycle that are easy to get
wrong: it measures the *parent*, because the renderer writes a pixel size onto
the canvas's own style and measuring the canvas would measure what it just set;
it watches `devicePixelRatio`, which changes with no resize event when a window
moves between monitors; and it sets `display: block`, because an inline canvas
inside a content-sized parent is a resize loop.

A resize redraws **synchronously**, which is the one place the on-demand loop
does not get to defer. Sizing the backing store wipes it — to opaque black, for
a canvas with `alpha: false` — and a `ResizeObserver` runs *after* the frame
callbacks, so a redraw left to the next frame is one the browser paints the
cleared canvas before. Dragging a window edge flashes black on every step.

The element arrives through state, so it is null on the first render and the
input hooks take null and no-op. That also makes null the enable switch — the
whiteboard detaches the select tool by passing null while a create tool is
active, which leaves no stale marquee behind.

### What the demo changed in the engine

`examples/whiteboard` is built only on the public exports. Five things it could
not do cleanly are now in `src/`:

| added | because |
| --- | --- |
| `Camera.worldToScreenRect` | a text editor is DOM over the canvas, and it has to be positioned |
| `Scene.queryOrdered` | `query` returns index order, which is right for culling and wrong for painting |
| `deserializeDocumentInto` | the document loader returned a new camera, which no hook can hold |
| `useCanvas`'s renderer type parameter | a host that wrote its own renderer needs its own methods back, not the interface |
| `invertPatch` copies what it captures | an undo record must not alias an object the host still holds |

A property change — text, colour, anything the engine does not model — is an
`add` over an existing id: the node keeps its depth, and the inverse restores
the node that was there.

```ts
history.run('edit text', [{ op: 'add', node: { ...node, text } }]);
```

The one rule that is easy to get wrong: record the change *before* applying it
in place. Mutating a node and then recording it loses the previous value,
because by then there is nowhere left to read it from.

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
| one finger | pan (set `singleTouch: 'ignore'` to leave it for the host's tools) |
| two fingers | pinch zoom and pan together |
| flick | coasts to a stop; `inertia: false` turns it off |

### Keyboard

`attachKeyboard` binds what a canvas is expected to have. It matches on
`event.code` rather than `event.key`, because with shift held `1` arrives as
`!` on a US layout and as something else elsewhere, and it stays out of the way
while the user is typing in a field.

```ts
attachKeyboard(camera, { getContentBounds: () => scene.bounds() });
```

| keys | effect |
| --- | --- |
| `cmd`/`ctrl` + `0` | back to 100% |
| `shift` + `1` | fit the content |
| `shift` + `2` | fit the selection (needs `getSelectionBounds`) |
| `+` / `-`, with or without `cmd`/`ctrl` | zoom about the viewport centre |
| arrows | pan; hold `shift` for a tenth of a step |

### Embedding in a page that scrolls

A canvas that fills the window inside a scrolling document has to give two
things back, or the page around it stops working:

```ts
attachGestures(canvas, camera, {
  wheel: 'zoom-only',    // an unmodified wheel stays with the document
  singleTouch: 'ignore', // one finger scrolls the page; two work the canvas
});
```

`attachGestures` takes over the element's `touch-action` on attach and restores
it on detach, because the browser's own scrolling would otherwise swallow touch
input before any handler saw it. How much it takes depends on `singleTouch`: a
canvas that ignores a single finger gets `pan-x pan-y` rather than `none`, since
taking `none` there would make the document unscrollable everywhere the element
covers.

That default is for an embedded canvas. A **full-screen app that puts tools on
one finger** wants the opposite and has to say so:

```ts
attachGestures(canvas, camera, {
  singleTouch: 'ignore', // one finger is the select tool's
  touchAction: 'none',   // ...so the browser must not claim it as a scroll
});
```

Without it the browser decides a few events in that the gesture is a scroll,
sends `pointercancel`, and the drag stops after a few pixels. `touchAction`
also takes `false`, which leaves the stylesheet in charge.

`cmd`/`ctrl` + `=` and `-` are taken over too, which is what every canvas tool
does and what people expect — but it does mean page zoom is gone for as long as
`attachKeyboard` is bound to the window. An embedded canvas that should not do
that passes its own `target`.

## Layout

```
src/
  camera.ts            world <-> screen, zoom anchoring, fit-to-content
  scene.ts             flat node store, indexed
  spatial/             uniform grid index
  renderer/            Renderer interface, Canvas2D backend, LOD pixel buffer
  input/gestures.ts    wheel/pinch/drag state machine
  input/keyboard.ts    zoom and pan shortcuts
  select/              hit testing, selection, snapping, the pointer tool
  history/             patches, undo and redo
  persist.ts           scene and document snapshots
  react/               hooks: canvas lifecycle, the shared frame, input
  math/rect.ts         rectangle primitives
bench/                 headless benchmark runner and profile tooling
examples/basic         the smallest useful program
examples/select        select, drag, marquee, snap, undo and save/load
examples/bench         100k-node playground, and the harness the runner drives
examples/whiteboard    a React whiteboard on the public API — notes, text, undo
site/                  the landing page, including a renderer of its own
```

## Development

```bash
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit, strict
pnpm build          # dist/
pnpm bench          # --stress for 1M nodes, --headed to watch, --reps=N
pnpm whiteboard     # the React demo
pnpm select         # the vanilla select/drag/undo demo
```

The spatial index is property-tested against a brute-force scan: every query
must return exactly what a full scan would. That test is what made it safe to
rewrite the query hot path for a 15x speedup without hand-verifying anything.

MIT.
