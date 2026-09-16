import type { Camera } from '../camera.js';
import type { Scene, SceneNode } from '../scene.js';
import type { Renderer, RenderStats } from './types.js';
import { inflate } from '../math/rect.js';
import { LodBuffer } from './lod-buffer.js';

export interface ShapeNode extends SceneNode {
  fill?: string;
  stroke?: string;
  /** Stroke width in **world** units; screen width is this times the scale. */
  strokeWidth?: number;
}

export interface Canvas2DRendererOptions {
  background?: string;
  grid?: GridOptions | false;
  /**
   * Group same-fill shapes into one path per colour instead of issuing a
   * `fillRect` each. Default true. Turn it off to measure the difference —
   * see `bench/results/RESULTS.md`.
   */
  batchByFill?: boolean;
  /**
   * Shapes whose on-screen box is smaller than this many CSS pixels on both
   * axes are painted straight into a pixel buffer instead of going through the
   * canvas path API. Default 2. Set to 0 to disable.
   */
  lodMinScreenSize?: number;
}

export interface GridOptions {
  color?: string;
  /** Preferred on-screen spacing in CSS pixels; the step snaps to a 1/2/5 series near it. */
  targetSpacing?: number;
}

const DEFAULT_GRID: Required<GridOptions> = {
  color: 'rgba(255, 255, 255, 0.07)',
  targetSpacing: 72,
};

export class Canvas2DRenderer<T extends ShapeNode = ShapeNode> implements Renderer<T> {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #background: string;
  readonly #grid: Required<GridOptions> | null;
  readonly #batchByFill: boolean;
  readonly #lodMinScreenSize: number;
  readonly #lod = new LodBuffer();

  /** Reused across frames so a steady-state render allocates nothing here. */
  readonly #batches = new Map<string, T[]>();

  #dpr = 1;
  #cssWidth = 0;
  #cssHeight = 0;

  constructor(canvas: HTMLCanvasElement, options: Canvas2DRendererOptions = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2DRenderer: could not acquire a 2d context');
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#background = options.background ?? '#0f1115';
    this.#grid = options.grid === false ? null : { ...DEFAULT_GRID, ...options.grid };
    this.#batchByFill = options.batchByFill ?? true;
    this.#lodMinScreenSize = options.lodMinScreenSize ?? 2;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.#cssWidth = cssWidth;
    this.#cssHeight = cssHeight;
    this.#dpr = dpr;
    // The backing store is sized in device pixels; CSS keeps the layout size.
    this.#canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.#canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.#canvas.style.width = `${cssWidth}px`;
    this.#canvas.style.height = `${cssHeight}px`;
    this.#lod.resize(this.#canvas.width, this.#canvas.height);
  }

  render(scene: Scene<T>, camera: Camera): RenderStats {
    const started = performance.now();
    const ctx = this.#ctx;
    const dpr = this.#dpr;

    // Screen space: one unit is one CSS pixel, device pixel ratio folded in.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.#background;
    ctx.fillRect(0, 0, this.#cssWidth, this.#cssHeight);
    if (this.#grid) this.#drawGrid(camera, this.#grid);

    // A one-pixel margin keeps shapes straddling the edge from popping.
    const view = inflate(camera.visibleWorldRect(), camera.screenToWorldDistance(1));
    const visible = scene.query(view);

    // World space: the camera transform, again with device pixel ratio folded in.
    const [a, b, c, d, e, f] = camera.toMatrix();
    ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);

    const drawn = this.#lodMinScreenSize > 0 ? this.#splitByLod(visible, camera) : visible;
    if (this.#batchByFill) this.#drawBatched(drawn);
    else this.#drawDirect(drawn);

    if (drawn !== visible) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.#lod.flush(ctx);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return {
      total: scene.size,
      drawn: visible.length,
      culled: scene.size - visible.length,
      durationMs: performance.now() - started,
    };
  }

  /**
   * Routes sub-pixel shapes into the LOD buffer and returns the rest.
   *
   * Returns `nodes` itself when nothing qualifies, so the common zoomed-in
   * case neither allocates nor touches the pixel buffer.
   */
  #splitByLod(nodes: readonly T[], camera: Camera): readonly T[] {
    const scale = camera.scale;
    const threshold = this.#lodMinScreenSize / scale;

    let firstSmall = -1;
    for (let i = 0; i < nodes.length; i++) {
      const { w, h } = (nodes[i] as T).rect;
      if (w < threshold && h < threshold) {
        firstSmall = i;
        break;
      }
    }
    if (firstSmall === -1) return nodes;

    const dpr = this.#dpr;
    const big: T[] = nodes.slice(0, firstSmall);
    this.#lod.beginFrame();

    for (let i = firstSmall; i < nodes.length; i++) {
      const node = nodes[i] as T;
      const { x, y, w, h } = node.rect;
      if (w >= threshold || h >= threshold || node.fill === undefined) {
        big.push(node);
        continue;
      }
      this.#lod.plot(
        (x * scale + camera.tx) * dpr,
        (y * scale + camera.ty) * dpr,
        w * scale * dpr,
        h * scale * dpr,
        node.fill,
      );
    }
    return big;
  }

  destroy(): void {
    this.#batches.clear();
    this.#ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** One `fillRect` per node. Simple, and the control the batched path is measured against. */
  #drawDirect(nodes: readonly T[]): void {
    const ctx = this.#ctx;
    for (const node of nodes) {
      const { x, y, w, h } = node.rect;
      if (node.fill !== undefined) {
        ctx.fillStyle = node.fill;
        ctx.fillRect(x, y, w, h);
      }
      if (node.stroke !== undefined) this.#strokeNode(node);
    }
  }

  /**
   * One path per distinct fill colour.
   *
   * Zoomed out, the frame is bound by the number of draw calls rather than by
   * pixels: a hundred thousand one-pixel `fillRect`s each pay for state
   * validation and a rasteriser dispatch. Collapsing them into a handful of
   * paths turns that into a handful of dispatches over the same geometry.
   *
   * The catch is that a single path cannot express per-node paint order, so
   * this is only correct while same-coloured shapes are interchangeable.
   * Overlapping shapes with different colours still draw in colour-group
   * order, not insertion order — a real z-order needs batching per layer.
   */
  #drawBatched(nodes: readonly T[]): void {
    const ctx = this.#ctx;
    for (const bucket of this.#batches.values()) bucket.length = 0;

    for (const node of nodes) {
      if (node.fill === undefined) continue;
      const bucket = this.#batches.get(node.fill);
      if (bucket === undefined) this.#batches.set(node.fill, [node]);
      else bucket.push(node);
    }

    for (const [fill, bucket] of this.#batches) {
      if (bucket.length === 0) continue;
      ctx.beginPath();
      for (const node of bucket) {
        const { x, y, w, h } = node.rect;
        ctx.rect(x, y, w, h);
      }
      ctx.fillStyle = fill;
      ctx.fill();
    }

    for (const node of nodes) {
      if (node.stroke !== undefined) this.#strokeNode(node);
    }
  }

  #strokeNode(node: T): void {
    const ctx = this.#ctx;
    const { x, y, w, h } = node.rect;
    ctx.strokeStyle = node.stroke as string;
    // Stroke width is authored in world units, so it scales with the content.
    // Swap for `1 / camera.scale` to get a hairline that stays 1px on screen.
    ctx.lineWidth = node.strokeWidth ?? 1;
    ctx.strokeRect(x, y, w, h);
  }

  #drawGrid(camera: Camera, grid: Required<GridOptions>): void {
    const ctx = this.#ctx;
    const step = niceStep(grid.targetSpacing / camera.scale);
    const screenStep = step * camera.scale;
    if (!Number.isFinite(screenStep) || screenStep < 4) return;

    const view = camera.visibleWorldRect();
    const startX = Math.floor(view.x / step) * step;
    const startY = Math.floor(view.y / step) * step;

    ctx.beginPath();
    for (let wx = startX; wx <= view.x + view.w; wx += step) {
      // Half-pixel offset so a 1px line lands on a pixel instead of across two.
      const sx = Math.round(wx * camera.scale + camera.tx) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.#cssHeight);
    }
    for (let wy = startY; wy <= view.y + view.h; wy += step) {
      const sy = Math.round(wy * camera.scale + camera.ty) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(this.#cssWidth, sy);
    }
    ctx.strokeStyle = grid.color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Rounds a spacing up to the nearest 1, 2 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const factor = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return factor * magnitude;
}
