import type { Matrix2D, Rect, Vec2 } from './types.js';
import { center, isEmptyRect } from './math/rect.js';

export interface CameraOptions {
  /** Smallest allowed scale. Default 0.02 (2%). */
  minScale?: number;
  /** Largest allowed scale. Default 64 (6400%). */
  maxScale?: number;
}

/**
 * Maps between world space and screen space.
 *
 * The whole model is `screen = world * scale + translation`, with `scale`
 * uniform on both axes. Screen space is measured in **CSS pixels**: device
 * pixel ratio belongs to the renderer, not here. Mixing the two is the single
 * most common source of blurry-at-2x, off-by-a-factor hit-testing bugs.
 *
 * World coordinates are plain float64 and never store pixel-derived values.
 * Anything that should keep a constant on-screen size (stroke widths, hit
 * tolerances, handle sizes) is divided by {@link Camera.scale} at use time.
 */
export class Camera {
  readonly minScale: number;
  readonly maxScale: number;

  #scale = 1;
  #tx = 0;
  #ty = 0;
  #width = 0;
  #height = 0;
  #version = 0;

  constructor(options: CameraOptions = {}) {
    this.minScale = options.minScale ?? 0.02;
    this.maxScale = options.maxScale ?? 64;
  }

  get scale(): number {
    return this.#scale;
  }

  /** Horizontal translation, in CSS pixels. */
  get tx(): number {
    return this.#tx;
  }

  /** Vertical translation, in CSS pixels. */
  get ty(): number {
    return this.#ty;
  }

  /** Viewport width in CSS pixels. */
  get width(): number {
    return this.#width;
  }

  /** Viewport height in CSS pixels. */
  get height(): number {
    return this.#height;
  }

  /**
   * Bumped on every state change. Cheap way for renderers and caches to ask
   * "did anything move since I last drew?" without diffing numbers.
   */
  get version(): number {
    return this.#version;
  }

  /**
   * Sets the viewport size in CSS pixels.
   *
   * A later resize anchors on the centre, so growing or shrinking the window
   * does not slide the content sideways. The *first* call is not a resize
   * though — there is no content on screen to hold still — and anchoring it
   * would leave a fresh camera translated by half a viewport, which is a
   * surprising thing for `tx` to be.
   */
  setViewport(width: number, height: number): this {
    if (width === this.#width && height === this.#height) return this;

    const initialised = this.#width > 0 && this.#height > 0;
    if (initialised) {
      this.#tx += (width - this.#width) / 2;
      this.#ty += (height - this.#height) / 2;
    }
    this.#width = width;
    this.#height = height;
    return this.#touch();
  }

  worldToScreen(p: Vec2): Vec2 {
    return { x: p.x * this.#scale + this.#tx, y: p.y * this.#scale + this.#ty };
  }

  screenToWorld(p: Vec2): Vec2 {
    return { x: (p.x - this.#tx) / this.#scale, y: (p.y - this.#ty) / this.#scale };
  }

  /** Converts a length, e.g. a hit tolerance of 4 screen px into world units. */
  screenToWorldDistance(d: number): number {
    return d / this.#scale;
  }

  /** Moves the view by a screen-space delta. Positive dx moves content right. */
  panBy(dx: number, dy: number): this {
    if (dx === 0 && dy === 0) return this;
    this.#tx += dx;
    this.#ty += dy;
    return this.#touch();
  }

  /**
   * Multiplies the zoom by `factor`, keeping the world point currently under
   * `anchor` (a screen-space point, default: viewport centre) pinned there.
   */
  zoomBy(factor: number, anchor?: Vec2): this {
    return this.zoomTo(this.#scale * factor, anchor);
  }

  /** Sets an absolute zoom level, pinning the world point under `anchor`. */
  zoomTo(scale: number, anchor?: Vec2): this {
    const next = clamp(scale, this.minScale, this.maxScale);
    if (next === this.#scale) return this;

    const a = anchor ?? { x: this.#width / 2, y: this.#height / 2 };
    const world = this.screenToWorld(a);
    this.#scale = next;
    // Re-solve the translation so `world` lands back on `a`.
    this.#tx = a.x - world.x * next;
    this.#ty = a.y - world.y * next;
    return this.#touch();
  }

  /** Centres the viewport on a world point without changing zoom. */
  centerOn(p: Vec2): this {
    this.#tx = this.#width / 2 - p.x * this.#scale;
    this.#ty = this.#height / 2 - p.y * this.#scale;
    return this.#touch();
  }

  /**
   * Frames a world rectangle, leaving `padding` CSS pixels on each side.
   * An empty rectangle (no content) is a no-op rather than a NaN camera.
   */
  fitToRect(target: Rect, padding = 32): this {
    if (isEmptyRect(target) || this.#width <= 0 || this.#height <= 0) return this;

    const availW = Math.max(1, this.#width - padding * 2);
    const availH = Math.max(1, this.#height - padding * 2);
    // A zero-width or zero-height target (a single point, a flat line) would
    // divide to Infinity, so only constrain on the axes that have extent.
    const fitW = target.w > 0 ? availW / target.w : Infinity;
    const fitH = target.h > 0 ? availH / target.h : Infinity;
    const fit = Math.min(fitW, fitH);

    this.#scale = clamp(Number.isFinite(fit) ? fit : this.#scale, this.minScale, this.maxScale);
    return this.centerOn(center(target));
  }

  /** The world-space rectangle currently visible in the viewport. */
  visibleWorldRect(): Rect {
    const topLeft = this.screenToWorld({ x: 0, y: 0 });
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: this.#width / this.#scale,
      h: this.#height / this.#scale,
    };
  }

  /** The transform in `ctx.setTransform` order, without device pixel ratio. */
  toMatrix(): Matrix2D {
    return [this.#scale, 0, 0, this.#scale, this.#tx, this.#ty];
  }

  /** Snapshot suitable for serialisation or undo. */
  toJSON(): { scale: number; tx: number; ty: number } {
    return { scale: this.#scale, tx: this.#tx, ty: this.#ty };
  }

  /** Restores a snapshot. Viewport size is not part of camera state. */
  setState(state: { scale: number; tx: number; ty: number }): this {
    this.#scale = clamp(state.scale, this.minScale, this.maxScale);
    this.#tx = state.tx;
    this.#ty = state.ty;
    return this.#touch();
  }

  #touch(): this {
    this.#version++;
    return this;
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
