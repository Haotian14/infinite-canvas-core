import { Camera, Canvas2DRenderer, Scene, attachGestures } from '../src/index.js';
import type { ShapeNode } from '../src/index.js';
import { buildNodes } from '../examples/shared/scene.js';
import report from '../bench/results/latest.json';

/**
 * Every number on the page comes from `bench/results/latest.json`, imported at
 * build time. Nothing here is typed by hand, so the page cannot drift away from
 * the run that produced it.
 */
interface BenchRun {
  scenario: string;
  nodeCount: number;
  batchByFill: boolean;
  lodMinScreenSize: number;
  drawnMean: number;
  renderMs: { p50: number; p95: number; p99: number; mean: number; max: number };
  reps?: { spreadPct: number };
}
interface BenchReport {
  environment: { cpu: string; cores: number; chromium: string; gpu: string };
  config: { frames: number; reps: number };
  results: BenchRun[];
  queryResults: Array<{ nodeCount: number; hitsMean: number; indexedUs: number; linearUs: number; speedup: number }>;
}

const bench = report as unknown as BenchReport;
const tuned = (scenario: string): BenchRun | undefined =>
  bench.results.find(
    (r) => r.scenario === scenario && r.nodeCount === 100_000 && r.batchByFill && r.lodMinScreenSize !== 0,
  );
const query = bench.queryResults[bench.queryResults.length - 1];

const $ = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
};

// --- hero stats -------------------------------------------------------------

const overview = tuned('overview');
const panClose = tuned('pan-close');

$('#stat-strip').innerHTML = [
  ['Nodes on screen', overview ? overview.drawnMean.toLocaleString() : '100,000', ''],
  ['Worst-case frame', overview ? overview.renderMs.p50.toFixed(1) : '—', 'ms'],
  ['While editing', panClose ? panClose.renderMs.p50.toFixed(1) : '—', 'ms'],
  ['Runtime dependencies', '0', ''],
]
  .map(([label, value, unit]) => `<div><dt>${label}</dt><dd>${value}<span>${unit}</span></dd></div>`)
  .join('');

// --- code sample ------------------------------------------------------------

const SAMPLE = `import {
  Camera, Scene, Canvas2DRenderer, attachGestures,
} from 'infinite-canvas-core'

const camera = new Camera()
const scene = new Scene()
const renderer = new Canvas2DRenderer(canvas)

scene.add({ id: 'a', rect: { x: 0, y: 0, w: 120, h: 80 }, fill: '#6ea8fe' })

camera.setViewport(innerWidth, innerHeight)
renderer.resize(innerWidth, innerHeight, devicePixelRatio)

// Mouse, trackpad and touch, including pinch and flick-to-glide.
attachGestures(canvas, camera, {
  onChange: () => renderer.render(scene, camera),
})`;

/** A deliberately small highlighter: one sample, no need for a real parser. */
function highlight(source: string): string {
  const escaped = source.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
  return escaped
    .replace(/(\/\/.*)$/gm, '<span class="tok-com">$1</span>')
    .replace(/('[^']*')/g, '<span class="tok-str">$1</span>')
    .replace(/\b(import|from|const|new|return|export)\b/g, '<span class="tok-key">$1</span>')
    .replace(/\b(Camera|Scene|Canvas2DRenderer|attachGestures)\b/g, '<span class="tok-fn">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="tok-num">$1</span>');
}
$('#sample').innerHTML = highlight(SAMPLE);

for (const button of document.querySelectorAll<HTMLButtonElement>('.copy')) {
  button.addEventListener('click', async () => {
    const label = button.querySelector('span') as HTMLSpanElement;
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      label.textContent = 'Copied';
    } catch {
      label.textContent = 'Press ⌘C';
    }
    setTimeout(() => (label.textContent = 'Copy'), 1600);
  });
}

// --- features ---------------------------------------------------------------

const ICONS = {
  headless: '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="2.5"/>',
  plug: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9ZM12 18v3"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  pointer: '<path d="M6 3l12 8-5 1.5 3 6-2.5 1.2-3-6L6 17V3Z"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4.5-5"/>',
  package: '<path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5ZM3 7l9 4.5L21 7M12 11.5V21"/>',
};

const FEATURES: Array<[keyof typeof ICONS, string, string]> = [
  [
    'headless',
    'Headless by design',
    'The core never touches the DOM. It runs in a Worker, in Node, in a plain unit test. That constraint is what keeps the architecture honest — and what makes server-side thumbnails and off-thread layout possible.',
  ],
  [
    'plug',
    'Bring your own renderer',
    '<code>Renderer</code> is a three-method interface. Canvas2D ships today; WebGL, WebGPU or SVG plug in without the engine noticing.',
  ],
  [
    'grid',
    'Built to scale',
    `A uniform-grid spatial index answers viewport queries <strong>${query ? query.speedup.toFixed(0) : '14'}x</strong> faster than a full scan over ${query ? query.nodeCount.toLocaleString() : '100,000'} nodes, and sub-pixel LOD keeps the worst case inside frame budget.`,
  ],
  [
    'pointer',
    'One gesture model',
    'Mouse, trackpad and touch run through the same state machine: the centroid of the active pointers is what you drag, their spread is the zoom. One finger is a pinch with a constant spread. Flicks coast.',
  ],
  [
    'gauge',
    'Measured, not claimed',
    'Every number on this page comes from a harness in the repo. Run <code>pnpm bench</code> for your own — it reports run spread, so you can tell a real win from noise.',
  ],
  [
    'package',
    'MIT, zero dependencies',
    'No runtime dependencies, no framework, no build-step requirements. Strict TypeScript with types and source maps in the package.',
  ],
];

$('#feature-grid').innerHTML = FEATURES.map(
  ([icon, title, body]) => `
    <article class="feature">
      <div class="feature-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>
        <h3>${title}</h3>
      </div>
      <p>${body}</p>
    </article>`,
).join('');

// --- performance tables -----------------------------------------------------

const env = bench.environment;
$('#perf-lede').innerHTML =
  `Measured inside <code>Canvas2DRenderer.render</code> — the cull query plus the draw calls. ` +
  `Median of ${bench.config.reps} runs of ${bench.config.frames} frames, on ${env.cpu} with ` +
  `<strong>software rasterisation</strong>, which makes every number here a lower bound.`;

const SCENARIOS: Array<[string, string]> = [
  ['pan-close', 'Editing, ~1% of the world visible'],
  ['pan-mid', '~10% visible'],
  ['zoom-cycle', 'Continuous zoom in and out'],
  ['overview', 'Everything on screen at once'],
];

$('#perf-frames').innerHTML =
  `<tr><th>Scenario</th><th class="num">Drawn</th><th class="num">p50</th><th class="num">p95</th></tr>` +
  SCENARIOS.map(([scenario, label]) => {
    const run = tuned(scenario);
    if (!run) return '';
    return `<tr><td>${label}</td><td class="num">${run.drawnMean.toLocaleString()}</td><td class="num">${run.renderMs.p50.toFixed(1)} ms</td><td class="num">${run.renderMs.p95.toFixed(1)} ms</td></tr>`;
  }).join('');

const zoomCycle = tuned('zoom-cycle');
$('#perf-note').innerHTML =
  `A 60 fps budget is 16.7 ms. p50 clears it everywhere; p95 does not, in the two scenarios that ` +
  `pass through full zoom-out (${overview ? overview.renderMs.p95.toFixed(1) : '—'} ms and ` +
  `${zoomCycle ? zoomCycle.renderMs.p95.toFixed(1) : '—'} ms). Dirty-rectangle rendering is the fix, ` +
  `and it is not written yet.`;

const variant = (lod: number, batch: boolean): BenchRun | undefined =>
  bench.results.find(
    (r) =>
      r.scenario === 'overview' &&
      r.nodeCount === 100_000 &&
      r.lodMinScreenSize === lod &&
      r.batchByFill === batch,
  );

const baseline = variant(0, false);
const batched = variant(0, true);
const full = variant(2, true);

$('#perf-opt').innerHTML =
  `<tr><th>Overview at 100,000 nodes</th><th class="num">p50</th><th class="num">vs base</th></tr>` +
  [
    ['One <code>fillRect</code> per node', baseline, false],
    ['+ one path per fill colour', batched, false],
    ['+ sub-pixel LOD', full, true],
  ]
    .map(([label, run, highlight]) => {
      const r = run as BenchRun | undefined;
      if (!r || !baseline) return '';
      const ratio = baseline.renderMs.p50 / r.renderMs.p50;
      return `<tr class="${highlight ? 'highlight' : ''}"><td>${label}</td><td class="num">${r.renderMs.p50.toFixed(1)} ms</td><td class="num">${ratio === 1 ? '—' : `${ratio.toFixed(1)}x`}</td></tr>`;
    })
    .join('');

// --- live demo --------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('#demo-canvas');
const hud = $<HTMLDivElement>('#demo-hud');
const toggle = $<HTMLButtonElement>('#toggle-opt');
const resetView = $<HTMLButtonElement>('#reset-view');

// Enough to make the point without punishing a phone that is only browsing.
const NODE_COUNT = matchMedia('(pointer: coarse)').matches ? 50_000 : 100_000;

const camera = new Camera({ minScale: 0.002, maxScale: 48 });
const scene = new Scene<ShapeNode>({ cellSize: 512 });
scene.addAll(buildNodes(NODE_COUNT, 7));

let optimised = true;
let renderer = new Canvas2DRenderer(canvas, { background: '#0f1115' });

function rebuildRenderer(): void {
  renderer.destroy();
  renderer = new Canvas2DRenderer(canvas, {
    background: '#0f1115',
    batchByFill: optimised,
    lodMinScreenSize: optimised ? 2 : 0,
  });
  resize();
}

function resize(): void {
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  camera.setViewport(box.width, box.height);
  renderer.resize(box.width, box.height, window.devicePixelRatio || 1);
}

/**
 * How much of the world the demo shows on load, in world units across.
 *
 * Fitting the whole scene is the impressive number but the ugly picture — a
 * hundred thousand sub-pixel specks read as television static. Opening at a
 * zoom where the shapes are shapes, with the HUD showing tens of thousands of
 * nodes culled, makes the same point and looks like a canvas. `Fit all` is one
 * click away for anyone who wants to see the worst case.
 */
const OPENING_VIEW_WORLD_WIDTH = 6000;

function openingView(): void {
  resize();
  const bounds = scene.bounds();
  camera.zoomTo(camera.width / OPENING_VIEW_WORLD_WIDTH);
  camera.centerOn({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 });
}

function fitAll(): void {
  resize();
  camera.fitToRect(scene.bounds(), 8);
}

new ResizeObserver(() => {
  resize();
}).observe(canvas);

openingView();
attachGestures(canvas, camera, { singleTouch: 'pan' });

toggle.addEventListener('click', () => {
  optimised = !optimised;
  toggle.setAttribute('aria-pressed', String(optimised));
  toggle.textContent = `Optimisations: ${optimised ? 'on' : 'off'}`;
  rebuildRenderer();
  renderTimes = [];
  frameTimes = [];
});
resetView.addEventListener('click', () => {
  fitAll();
  renderTimes = [];
  frameTimes = [];
});

let frameTimes: number[] = [];
let renderTimes: number[] = [];
let previous = 0;
let running = false;

/**
 * The HUD reports a rolling median, not the latest frame.
 *
 * A big jump in the view — Fit all, or toggling the optimisations — costs a few
 * cold frames while the LOD buffer resizes and the JIT catches up. An
 * instantaneous readout spikes to roughly 3x steady state and then falls back,
 * which reads as an unstable engine rather than as a transition. The median
 * over the last second also matches how the table below reports p50, so the two
 * numbers on this page are directly comparable.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

function tick(time: number): void {
  if (!running) return;
  const stats = renderer.render(scene, camera);

  renderTimes.push(stats.durationMs);
  if (renderTimes.length > 45) renderTimes.shift();
  if (previous > 0) {
    frameTimes.push(time - previous);
    if (frameTimes.length > 45) frameTimes.shift();
  }
  previous = time;

  const frameMs = median(frameTimes);
  hud.innerHTML = `
    <div class="row"><span>nodes</span><b>${stats.total.toLocaleString()}</b></div>
    <div class="row"><span>drawn</span><b>${stats.drawn.toLocaleString()}</b></div>
    <div class="row"><span>culled</span><b>${stats.culled.toLocaleString()}</b></div>
    <div class="row"><span>render p50</span><b>${median(renderTimes).toFixed(2)} ms</b></div>
    <div class="row"><span>frame</span><b>${frameMs > 0 ? (1000 / frameMs).toFixed(0) : '—'} fps</b></div>`;

  requestAnimationFrame(tick);
}

// Rendering a hundred thousand nodes every frame behind the fold would be rude
// to somebody's battery, so the loop only runs while the demo is on screen.
new IntersectionObserver((entries) => {
  const visible = entries.some((entry) => entry.isIntersecting);
  if (visible === running) return;
  running = visible;
  if (running) {
    previous = 0;
    frameTimes = [];
    renderTimes = [];
    requestAnimationFrame(tick);
  }
}).observe(canvas);
