import { Camera, Canvas2DRenderer, Scene, attachGestures } from '../../src/index.js';
import type { ShapeNode } from '../../src/index.js';
import { buildNodes, mulberry32, worldSizeFor } from '../shared/scene.js';

/** A single scripted camera path. `t` runs 0..1 across the measured frames. */
type Scenario = 'overview' | 'pan-mid' | 'pan-close' | 'zoom-cycle';

interface RunConfig {
  scenario: Scenario;
  nodeCount: number;
  frames: number;
  warmup: number;
  seed?: number;
  /** Group shapes into one path per fill colour. Default true. */
  batchByFill?: boolean;
  /** Sub-pixel LOD threshold in CSS pixels; 0 disables it. Default 2. */
  lodMinScreenSize?: number;
}

interface FrameSample {
  frameMs: number;
  renderMs: number;
  drawn: number;
}

export interface RunResult {
  scenario: Scenario;
  nodeCount: number;
  batchByFill: boolean;
  lodMinScreenSize: number;
  frames: number;
  viewport: { width: number; height: number; dpr: number };
  drawnMean: number;
  drawnMax: number;
  renderMs: Percentiles;
  frameMs: Percentiles;
  fpsFromFrameP50: number;
  /** How much of a 16.67 ms frame the p95 render takes, as a percentage. */
  budget60P95: number;
}

interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const params = new URLSearchParams(location.search);
const initialCount = Number(params.get('nodes') ?? 100_000);

const camera = new Camera({ minScale: 0.002, maxScale: 64 });
let batchByFill = true;
let lodMinScreenSize = 2;
let renderer = new Canvas2DRenderer(canvas, { batchByFill, lodMinScreenSize });
let scene = new Scene<ShapeNode>({ cellSize: 512 });
let nodeCount = 0;

function configureRenderer(nextBatch: boolean, nextLod: number): void {
  if (nextBatch === batchByFill && nextLod === lodMinScreenSize) return;
  batchByFill = nextBatch;
  lodMinScreenSize = nextLod;
  renderer.destroy();
  renderer = new Canvas2DRenderer(canvas, { batchByFill, lodMinScreenSize });
}

function loadScene(count: number, seed = 1): void {
  scene = new Scene<ShapeNode>({ cellSize: 512 });
  scene.addAll(buildNodes(count, seed));
  nodeCount = count;
  globalThis.__benchSceneCount = count;
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  camera.setViewport(window.innerWidth, window.innerHeight);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
}

/** Positions the camera for a scenario at progress `t` in 0..1. */
function applyScenario(scenario: Scenario, t: number): void {
  const world = worldSizeFor(nodeCount);
  const bounds = scene.bounds();

  if (scenario === 'overview') {
    camera.fitToRect(bounds, 0);
    // Drift slightly so the culling set is not byte-identical every frame.
    camera.panBy(Math.sin(t * Math.PI * 2) * 40, Math.cos(t * Math.PI * 2) * 40);
    return;
  }

  if (scenario === 'zoom-cycle') {
    const closest = camera.width / (world * 0.02);
    const widest = camera.width / world;
    // Geometric interpolation: zoom feels linear when the *ratio* is linear.
    const ratio = (Math.cos(t * Math.PI * 2) + 1) / 2;
    camera.zoomTo(widest * (closest / widest) ** ratio);
    camera.centerOn({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 });
    return;
  }

  // Fraction of the world's edge visible: 10% of area for mid, 1% for close.
  const fraction = scenario === 'pan-mid' ? Math.sqrt(0.1) : Math.sqrt(0.01);
  camera.zoomTo(camera.width / (world * fraction));
  // A Lissajous path covers a wide, non-repeating slice of the scene.
  camera.centerOn({
    x: bounds.x + bounds.w * (0.5 + 0.35 * Math.sin(t * Math.PI * 2)),
    y: bounds.y + bounds.h * (0.5 + 0.35 * Math.sin(t * Math.PI * 6)),
  });
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
  };
}

function runScenario(config: RunConfig): Promise<RunResult> {
  if (config.nodeCount !== nodeCount) loadScene(config.nodeCount, config.seed ?? 1);
  configureRenderer(config.batchByFill ?? true, config.lodMinScreenSize ?? 2);
  resize();

  return new Promise<RunResult>((resolve) => {
    const samples: FrameSample[] = [];
    const total = config.warmup + config.frames;
    let index = 0;
    let previous = 0;

    const step = (now: number): void => {
      const t = index / total;
      applyScenario(config.scenario, t);
      const stats = renderer.render(scene, camera);

      // Warmup frames are discarded: they pay for JIT, first-touch page faults
      // and the initial texture upload, none of which recur in steady state.
      if (index >= config.warmup && previous > 0) {
        samples.push({ frameMs: now - previous, renderMs: stats.durationMs, drawn: stats.drawn });
      }
      previous = now;
      index++;

      if (index < total) {
        requestAnimationFrame(step);
        return;
      }

      const frameMs = percentiles(samples.map((s) => s.frameMs));
      const drawn = samples.map((s) => s.drawn);
      resolve({
        scenario: config.scenario,
        nodeCount,
        batchByFill,
        lodMinScreenSize,
        frames: samples.length,
        viewport: {
          width: camera.width,
          height: camera.height,
          dpr: window.devicePixelRatio || 1,
        },
        drawnMean: Math.round(drawn.reduce((a, b) => a + b, 0) / (drawn.length || 1)),
        drawnMax: Math.max(...drawn),
        renderMs: percentiles(samples.map((s) => s.renderMs)),
        frameMs,
        fpsFromFrameP50: frameMs.p50 > 0 ? 1000 / frameMs.p50 : 0,
        budget60P95: (percentiles(samples.map((s) => s.renderMs)).p95 / (1000 / 60)) * 100,
      });
    };

    requestAnimationFrame(step);
  });
}

// --- spatial index microbenchmark -------------------------------------------

export interface QueryBenchResult {
  nodeCount: number;
  queries: number;
  /** Mean hits per query, i.e. how much work a perfect index could not avoid. */
  hitsMean: number;
  indexedUs: number;
  linearUs: number;
  speedup: number;
}

/**
 * Times viewport queries against the index versus a full scan of the same
 * scene. This is the part of a frame that culling is supposed to make cheap,
 * isolated from any drawing.
 */
function runQueryBench(nodeCount: number, queries = 2000, seed = 1): QueryBenchResult {
  if (nodeCount !== globalThis.__benchSceneCount) loadScene(nodeCount, seed);
  const world = worldSizeFor(nodeCount);
  const bounds = scene.bounds();
  const view = { w: world * Math.sqrt(0.01), h: world * Math.sqrt(0.01) };

  const random = mulberry32(7);
  const areas = Array.from({ length: queries }, () => ({
    x: bounds.x + random() * (bounds.w - view.w),
    y: bounds.y + random() * (bounds.h - view.h),
    w: view.w,
    h: view.h,
  }));

  // Warm both paths so neither pays for first-call JIT in the measured loop.
  let hits = 0;
  for (const area of areas.slice(0, 50)) hits += scene.query(area).length + scene.queryLinear(area).length;

  const indexStart = performance.now();
  let indexHits = 0;
  for (const area of areas) indexHits += scene.query(area).length;
  const indexedUs = ((performance.now() - indexStart) / queries) * 1000;

  const linearStart = performance.now();
  for (const area of areas) hits += scene.queryLinear(area).length;
  const linearUs = ((performance.now() - linearStart) / queries) * 1000;

  return {
    nodeCount,
    queries,
    hitsMean: Math.round(indexHits / queries),
    indexedUs,
    linearUs,
    speedup: linearUs / indexedUs,
  };
}

// --- interactive mode -------------------------------------------------------

// The benchmark page is meant to be opened on a phone as often as a laptop,
// so the hint has to describe the input the reader actually has.
const HINT = matchMedia('(pointer: coarse)').matches
  ? 'drag to pan · pinch to zoom · flick to glide'
  : 'scroll to pan · ctrl+scroll or pinch to zoom · middle or space+drag to pan';

let frameTimes: number[] = [];
let lastFrame = 0;

function interactiveFrame(now: number): void {
  const stats = renderer.render(scene, camera);
  if (lastFrame > 0) {
    frameTimes.push(now - lastFrame);
    if (frameTimes.length > 60) frameTimes.shift();
  }
  lastFrame = now;

  const meanFrame = frameTimes.reduce((a, b) => a + b, 0) / (frameTimes.length || 1);
  hud.innerHTML = `
    <div class="row"><span>nodes</span><b>${stats.total.toLocaleString()}</b></div>
    <div class="row"><span>drawn / culled</span><b>${stats.drawn.toLocaleString()} / ${stats.culled.toLocaleString()}</b></div>
    <div class="row"><span>render</span><b>${stats.durationMs.toFixed(2)} ms</b></div>
    <div class="row"><span>frame</span><b>${meanFrame.toFixed(2)} ms (${(1000 / (meanFrame || 1)).toFixed(0)} fps)</b></div>
    <div class="row"><span>zoom</span><b>${(camera.scale * 100).toFixed(1)}%</b></div>
    <div class="hint">${HINT}</div>`;
  requestAnimationFrame(interactiveFrame);
}

loadScene(initialCount);
resize();
camera.fitToRect(scene.bounds(), 40);
window.addEventListener('resize', resize);
attachGestures(canvas, camera);

declare global {
  // eslint-disable-next-line no-var
  var __benchSceneCount: number | undefined;
  interface Window {
    __BENCH__: {
      ready: boolean;
      run(config: RunConfig): Promise<RunResult>;
      queryBench(nodeCount: number, queries?: number): QueryBenchResult;
      /** Exposed so the harness can assert on camera state directly. */
      camera: Camera;
    };
  }
}

window.__BENCH__ = {
  ready: true,
  run: (config) => {
    frameTimes = [];
    return runScenario(config);
  },
  queryBench: (count, queries) => runQueryBench(count, queries),
  camera,
};

if (!params.has('harness')) requestAnimationFrame(interactiveFrame);
