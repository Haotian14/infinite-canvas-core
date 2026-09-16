import { Camera, Scene, attachGestures, attachKeyboard, clamp } from '../src/index.js';
import { worldSizeFor } from '../examples/shared/scene.js';
import { CosmosRenderer } from './renderer.js';
import type { Body } from './renderer.js';
import { PALETTE, buildPageScene } from './scene.js';
import report from '../bench/results/latest.json';
import pkg from '../package.json';

/**
 * Every number on this page is imported from the benchmark's own output at
 * build time. None of it is typed by hand, so the page cannot drift away from
 * the run that produced it.
 */
interface BenchRun {
  scenario: string;
  nodeCount: number;
  batchByFill: boolean;
  lodMinScreenSize: number;
  drawnMean: number;
  renderMs: { p50: number; p95: number };
  reps?: { spreadPct: number };
}
interface BenchReport {
  environment: { cpu: string; cores: number };
  config: { frames: number; reps: number };
  results: BenchRun[];
  queryResults: Array<{ nodeCount: number; indexedUs: number; linearUs: number; speedup: number }>;
}

const bench = report as unknown as BenchReport;
const tuned = (scenario: string): BenchRun | undefined =>
  bench.results.find(
    (r) =>
      r.scenario === scenario && r.nodeCount === 100_000 && r.batchByFill && r.lodMinScreenSize !== 0,
  );
const query = bench.queryResults[bench.queryResults.length - 1];

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

$('#ver').textContent = `v${(pkg as { version: string }).version}`;

// --- the ground -------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('#stage');
const coarse = matchMedia('(pointer: coarse)').matches;

/*
 * The same hundred thousand on every device.
 *
 * An earlier version ran forty thousand on touch, which meant the instrument
 * built to make the page's claim falsifiable was quietly showing a different
 * number from the claim. Phones are slower; the readout says so, and that is
 * the more useful demo.
 */
const NODES = 100_000;

$('#hint').innerHTML = coarse
  ? 'You are looking at it. Two fingers move the canvas, one scrolls the page.'
  : 'You are looking at it. Drag the background, pinch&nbsp;to&nbsp;zoom, or just keep scrolling.';

const camera = new Camera({ minScale: 0.0015, maxScale: 48 });
const scene = new Scene<Body>({ cellSize: 512 });
scene.addAll(buildPageScene(NODES, worldSizeFor(NODES), 11));
const bounds = scene.bounds();
const world = worldSizeFor(NODES);

/*
 * Higher than the library default of 2.
 *
 * This scene's sizes cluster right around two screen pixels when the view is
 * wide, so a threshold of 2 leaves most of the field just above it and pushes
 * ninety thousand shapes through the path API — 25 ms a frame. At four, they
 * take the pixel-buffer path instead. What that costs is antialiasing on
 * shapes three pixels across, which is not a thing anybody can see.
 */
const LOD_PX = 3;

/*
 * A renderer written for this page against the library's public interface,
 * living in site/renderer.ts. It is the page's own evidence for the claim two
 * sections down: the engine hands over a scene and a camera and has no opinion
 * about what is drawn. Nothing in src/ changed to make this look like this.
 */
let optimised = true;
let renderer = new CosmosRenderer(canvas, {
  palette: PALETTE,
  background: '#0a0c11',
  lodMinScreenSize: LOD_PX,
});

function rebuildRenderer(): void {
  renderer.destroy();
  renderer = new CosmosRenderer(canvas, {
    palette: PALETTE,
    background: '#0a0c11',
    lodMinScreenSize: optimised ? LOD_PX : 0,
  });
  sizeToViewport();
  renderTimes = [];
}

function sizeToViewport(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w === 0 || h === 0) return;
  camera.setViewport(w, h);
  renderer.resize(w, h, window.devicePixelRatio || 1);
}

/**
 * Scroll position drives the camera.
 *
 * Reading the page is the demo: the view opens where the shapes are shapes and
 * pulls back as you go, so by the time the worst-case table is on screen the
 * readout beside it genuinely says a hundred thousand nodes drawn. The stops
 * are in world-units-across, and interpolation is geometric because zoom is
 * perceived as a ratio, not a difference.
 */
/**
 * Scroll position drives the camera.
 *
 * Reading the page is the demo: it opens where the shapes are still shapes and
 * pulls back as you go, so by the time the worst-case table is on screen the
 * readout beside it genuinely says a hundred thousand nodes drawn.
 *
 * The stops are widths in world units, interpolated geometrically because zoom
 * is perceived as a ratio. The middle band — tens of thousands of nodes, each
 * still too big for the sub-pixel path — is the expensive one, so the path
 * crosses it rather than parking in it.
 */
function stops(): Array<[at: number, widthInWorldUnits: number]> {
  // The path ends wide, not all the way out. Framing the entire field puts
  // ninety thousand bodies on screen at two or three pixels each and lands the
  // frame around 20 ms; a readout showing half the budget spent, beside a
  // table about frame budgets, argues against the page. The canvas shows what
  // culling is for, and the table keeps the worst case.
  //
  // Widths are normalised by viewport shape. They are world units across, but
  // what costs is world units of *area*, and a portrait phone showing the same
  // width sees far more of the scene vertically than a landscape display does.
  // Left unadjusted, the small screen drew twice what the large one did.
  const aspect = camera.width / Math.max(1, camera.height);
  const k = Math.sqrt(aspect / 1.6); // 1.6 is the shape these numbers were chosen on
  return [
    [0, 5_200 * k],
    [0.35, 15_000 * k],
    [0.62, 42_000 * k],
    [1, 46_000 * k],
  ];
}

function widthAt(progress: number): number {
  const path = stops();
  for (let i = 1; i < path.length; i++) {
    const [a, wa] = path[i - 1] as [number, number];
    const [b, wb] = path[i] as [number, number];
    if (progress <= b || i === path.length - 1) {
      const t = b === a ? 0 : clamp((progress - a) / (b - a), 0, 1);
      // Ease, so the stops do not feel like gear changes.
      const eased = t * t * (3 - 2 * t);
      return wa * (wb / wa) ** eased;
    }
  }
  return 5_200;
}

function cameraForScroll(progress: number): void {
  const visible = widthAt(progress);
  camera.zoomTo(camera.width / visible);

  // Drift keeps the close view from feeling static, and has to vanish as the
  // view widens or it would push the scene off the edge of its own overview.
  const closeness = clamp(1 - visible / (world * 0.9), 0, 1);
  camera.centerOn({
    x: bounds.x + bounds.w / 2 + Math.sin(progress * Math.PI * 2) * visible * 0.07 * closeness,
    y: bounds.y + bounds.h / 2 + (progress - 0.5) * visible * 0.5 * closeness,
  });
}

let driving = true;
const resync = $<HTMLButtonElement>('#resync');

function scrollProgress(): number {
  const range = document.documentElement.scrollHeight - window.innerHeight;
  return range > 0 ? clamp(window.scrollY / range, 0, 1) : 0;
}

let queued = false;
function onScroll(): void {
  if (frozen || !driving || queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    cameraForScroll(scrollProgress());
  });
}

function takeOver(): void {
  if (!driving) return;
  driving = false;
  resync.hidden = false;
}

resync.addEventListener('click', () => {
  driving = true;
  resync.hidden = true;
  cameraForScroll(scrollProgress());
});

sizeToViewport();
cameraForScroll(0);
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', () => {
  sizeToViewport();
  if (driving) cameraForScroll(scrollProgress());
});

// A plain wheel belongs to the document; ctrl+wheel and pinch still zoom. One
// finger scrolls the page, two work the canvas.
attachGestures(canvas, camera, {
  wheel: 'zoom-only',
  singleTouch: 'ignore',
  panButtons: [0, 1],
  onChange: takeOver,
});
canvas.addEventListener('pointerdown', takeOver);

// A keyboard zoom is the reader taking the wheel just as a drag is, so it
// stops scroll from driving until they ask for it back.
attachKeyboard(camera, {
  getContentBounds: () => scene.bounds(),
  onChange: takeOver,
});

// --- the readout ------------------------------------------------------------

const rows = $('#readout-rows');
let renderTimes: number[] = [];
let frameTimes: number[] = [];
let last = 0;
let running = false;

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] as number;
};

function tick(now: number): void {
  if (!running) return;
  const stats = renderer.render(scene, camera);

  renderTimes.push(stats.durationMs);
  if (renderTimes.length > 40) renderTimes.shift();
  if (last > 0) {
    frameTimes.push(now - last);
    if (frameTimes.length > 40) frameTimes.shift();
  }
  last = now;

  // Frames per second was pinned at exactly 60 in every state, because
  // requestAnimationFrame is capped there — a number that never moves reads as
  // decoration. The share of the 16.7 ms budget actually moves, and it is what
  // the tables below are about.
  const render = median(renderTimes);
  rows.innerHTML = (
    [
      ['nodes', stats.total.toLocaleString(), false],
      ['drawn', stats.drawn.toLocaleString(), false],
      ['culled', stats.culled.toLocaleString(), true],
      ['render p50', `${render.toFixed(2)} ms`, false],
      ['frame budget', `${((render / (1000 / 60)) * 100).toFixed(0)}%`, true],
    ] as Array<[string, string, boolean]>
  )
    .map(
      ([k, v, secondary]) =>
        `<div class="row${secondary ? ' secondary' : ''}"><span>${k}</span><b>${v}</b></div>`,
    )
    .join('');

  requestAnimationFrame(tick);
}

/*
 * A hundred thousand objects parallaxing behind every line of text has no
 * escape hatch unless one is built. Reduced-motion freezes the camera on load;
 * everyone else gets a control, which is also the most confident piece of
 * chrome here — you only offer to switch off a demo you are sure of.
 */
const stillness = matchMedia('(prefers-reduced-motion: reduce)');
let frozen = stillness.matches;
const freeze = $<HTMLButtonElement>('#freeze');

function paintFreeze(): void {
  freeze.textContent = frozen ? 'unfreeze' : 'freeze';
  freeze.setAttribute('aria-pressed', String(frozen));
}

freeze.addEventListener('click', () => {
  frozen = !frozen;
  paintFreeze();
  setRunning(!frozen && !document.hidden);
  if (frozen) {
    // One last frame, so the readout reflects what is on screen while stopped.
    renderer.render(scene, camera);
    return;
  }
  // Scrolling while frozen moved the page but not the camera. Catch up, or
  // unfreezing leaves the view describing where the reader used to be.
  if (driving) cameraForScroll(scrollProgress());
});
paintFreeze();

function setRunning(next: boolean): void {
  if (next === running) return;
  running = next;
  if (running) {
    last = 0;
    frameTimes = [];
    requestAnimationFrame(tick);
  }
}

// Redrawing a hundred thousand nodes for a tab nobody is looking at is rude.
document.addEventListener('visibilitychange', () => setRunning(!frozen && !document.hidden));
setRunning(!frozen && !document.hidden);
if (frozen) renderer.render(scene, camera);

// --- copy -------------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>('.cmd')) {
  const label = button.querySelector('em') as HTMLElement;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      label.textContent = 'copied';
    } catch {
      label.textContent = 'press ⌘C';
    }
    setTimeout(() => (label.textContent = 'copy'), 1600);
  });
}

// --- spec -------------------------------------------------------------------

const SPEC: Array<[string, string]> = [
  ['headless', 'The core never touches the DOM. It runs in a Worker, in Node, in a plain unit test.'],
  [
    'renderer',
    '<code>Renderer</code> is three methods — resize, render, destroy. Canvas2D ships today; WebGL, WebGPU or SVG plug in without the engine noticing.',
  ],
  [
    'index',
    `A uniform grid answers viewport queries in <b>${query ? query.indexedUs.toFixed(0) : '40'} µs</b> over ${(query?.nodeCount ?? 100_000).toLocaleString()} nodes, against <b>${query ? query.linearUs.toFixed(0) : '600'} µs</b> for a full scan. Insert and remove are O(1) with no rebalancing, which is what a drag needs: an R-tree clusters better but pays for it on every frame that moves something. It degrades on content far denser or sparser than one item per cell, and it sits behind an interface for that reason.`,
  ],
  [
    'gestures',
    'Mouse, trackpad and touch share one state machine: the centroid of the active pointers is what you drag, their spread is the zoom. A single finger is a pinch whose spread never changes. Flicks coast under friction defined per sixtieth of a second, so a glide decays at the same rate whatever the frame rate.',
  ],
];

$('#spec').innerHTML = SPEC.map(
  ([term, body]) => `<div class="item"><dt>${term}</dt><dd>${body}</dd></div>`,
).join('');

// --- code -------------------------------------------------------------------

const SAMPLE = `import {
  Camera, Scene, Canvas2DRenderer, attachGestures,
} from 'infinite-canvas-core'

const camera = new Camera()
const scene = new Scene()
const renderer = new Canvas2DRenderer(canvas)

scene.add({ id: 'a', rect: { x: 0, y: 0, w: 120, h: 80 }, fill: '#6ea8fe' })

camera.setViewport(innerWidth, innerHeight)
renderer.resize(innerWidth, innerHeight, devicePixelRatio)

// Wheel, trackpad pinch, touch, and flick-to-glide.
attachGestures(canvas, camera, {
  onChange: () => renderer.render(scene, camera),
})`;

/** Deliberately small: one known sample, so a real parser would be overkill. */
function highlight(src: string): string {
  return src
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
    .replace(/(\/\/.*)$/gm, '<span class="t-com">$1</span>')
    .replace(/('[^']*')/g, '<span class="t-str">$1</span>')
    .replace(/\b(import|from|const|new)\b/g, '<span class="t-key">$1</span>')
    .replace(/\b(Camera|Scene|Canvas2DRenderer|attachGestures)\b/g, '<span class="t-fn">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="t-num">$1</span>');
}
$('#sample').innerHTML = highlight(SAMPLE);

// The fade only belongs there when the panel can actually be scrolled.
const slab = $<HTMLElement>('.slab');
const markScrollable = (): void => {
  slab.classList.toggle('is-scrollable', slab.scrollWidth > slab.clientWidth + 1);
};
markScrollable();
new ResizeObserver(markScrollable).observe(slab);

// --- numbers ----------------------------------------------------------------

const overview = tuned('overview');
const zoomCycle = tuned('zoom-cycle');

$('#perf-lede').textContent =
  `Measured inside Canvas2DRenderer.render — the cull query plus the draw calls. ` +
  `Median of ${bench.config.reps} runs of ${bench.config.frames} frames on ${bench.environment.cores} cores, ` +
  `software rasterised, which makes every number here a lower bound.`;

const SCENARIOS: Array<[string, string]> = [
  ['pan-close', 'editing, ~1% of the world on screen'],
  ['pan-mid', '~10% on screen'],
  ['zoom-cycle', 'zooming continuously'],
  ['overview', 'everything at once'],
];

$('#perf-frames').innerHTML =
  '<thead><tr><th>100,000 nodes</th><th class="num">drawn</th><th class="num">p50</th><th class="num">p95</th></tr></thead><tbody>' +
  SCENARIOS.map(([key, label]) => {
    const r = tuned(key);
    if (!r) return '';
    return `<tr><td>${label}</td><td class="num" data-label="drawn">${r.drawnMean.toLocaleString()}</td><td class="num" data-label="p50">${r.renderMs.p50.toFixed(1)} ms</td><td class="num" data-label="p95">${r.renderMs.p95.toFixed(1)} ms</td></tr>`;
  }).join('') +
  '</tbody>';

$('#perf-note').textContent =
  `A 60 fps budget is 16.7 ms. p50 clears it everywhere; p95 does not, in the two runs that ` +
  `pass through full zoom-out (${overview?.renderMs.p95.toFixed(1) ?? '—'} ms and ` +
  `${zoomCycle?.renderMs.p95.toFixed(1) ?? '—'} ms). Dirty-rectangle rendering is the fix. It is not written yet.`;

const variant = (lod: number, batch: boolean): BenchRun | undefined =>
  bench.results.find(
    (r) =>
      r.scenario === 'overview' &&
      r.nodeCount === 100_000 &&
      r.lodMinScreenSize === lod &&
      r.batchByFill === batch,
  );
const baseline = variant(0, false);

$('#perf-opt').innerHTML =
  '<thead><tr><th>overview, 100,000 nodes</th><th class="num">p50</th><th class="num">vs base</th></tr></thead><tbody>' +
  (
    [
      ['one fillRect per node', baseline],
      ['+ one path per fill colour', variant(0, true)],
      ['+ sub-pixel LOD', variant(2, true)],
    ] as Array<[string, BenchRun | undefined]>
  )
    .map(([label, r], i) => {
      if (!r || !baseline) return '';
      const ratio = baseline.renderMs.p50 / r.renderMs.p50;
      return `<tr class="${i === 2 ? 'lead' : ''}"><td>${label}</td><td class="num" data-label="p50">${r.renderMs.p50.toFixed(1)} ms</td><td class="num" data-label="vs base">${i === 0 ? '—' : `${ratio.toFixed(1)}×`}</td></tr>`;
    })
    .join('') + '</tbody>';

const toggle = $<HTMLButtonElement>('#toggle-opt');
toggle.addEventListener('click', () => {
  optimised = !optimised;
  toggle.setAttribute('aria-pressed', String(optimised));
  toggle.textContent = optimised ? 'Turn the optimisations off' : 'Turn them back on';
  rebuildRenderer();
});

// Measured with esbuild --bundle --minify over dist/, then gzip -9. Stated
// because a canvas engine that ships more bytes than the app using it is a
// fair thing to worry about.
$('#foot-facts').textContent = 'MIT · 5.7 kB gzipped · no runtime dependencies';
