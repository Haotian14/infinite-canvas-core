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

  private _scale = 1;
  private _tx = 0;
  private _ty = 0;
  private _width = 0;
  private _height = 0;
  private _version = 0;

  constructor(options: CameraOptions = {}) {
    this.minScale = options.minScale ?? 0.02;
    this.maxScale = options.maxScale ?? 64;
  }

  get scale(): number {
    return this._scale;
  }

  /** Horizontal translation, in CSS pixels. */
  get tx(): number {
    return this._tx;
  }

  /** Vertical translation, in CSS pixels. */
  get ty(): number {
    return this._ty;
  }

  /** Viewport width in CSS pixels. */
  get width(): number {
    return this._width;
  }

  /** Viewport height in CSS pixels. */
  get height(): number {
    return this._height;
  }

  /**
   * Bumped on every state change. Cheap way for renderers and caches to ask
   * "did anything move since I last drew?" without diffing numbers.
   */
  get version(): number {
    return this._version;
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
    if (width === this._width && height === this._height) return this;

    const initialised = this._width > 0 && this._height > 0;
    if (initialised) {
      this._tx += (width - this._width) / 2;
      this._ty += (height - this._height) / 2;
    }
    this._width = width;
    this._height = height;
    return this._touch();
  }

  worldToScreen(p: Vec2): Vec2 {
    return { x: p.x * this._scale + this._tx, y: p.y * this._scale + this._ty };
  }

  /**
   * A world rectangle in screen coordinates.
   *
   * For putting DOM over the canvas — a text editor on a node, a context menu,
   * a resize handle. Doing it with two `worldToScreen` calls works and is the
   * kind of arithmetic that ends up subtly wrong in every host that writes it.
   */
  worldToScreenRect(r: Rect): Rect {
    return {
      x: r.x * this._scale + this._tx,
      y: r.y * this._scale + this._ty,
      w: r.w * this._scale,
      h: r.h * this._scale,
    };
  }

  screenToWorld(p: Vec2): Vec2 {
    return { x: (p.x - this._tx) / this._scale, y: (p.y - this._ty) / this._scale };
  }

  /** Converts a length, e.g. a hit tolerance of 4 screen px into world units. */
  screenToWorldDistance(d: number): number {
    return d / this._scale;
  }

  /** Moves the view by a screen-space delta. Positive dx moves content right. */
  panBy(dx: number, dy: number): this {
    if (dx === 0 && dy === 0) return this;
    this._tx += dx;
    this._ty += dy;
    return this._touch();
  }

  /**
   * Multiplies the zoom by `factor`, keeping the world point currently under
   * `anchor` (a screen-space point, default: viewport centre) pinned there.
   */
  zoomBy(factor: number, anchor?: Vec2): this {
    return this.zoomTo(this._scale * factor, anchor);
  }

  /** Sets an absolute zoom level, pinning the world point under `anchor`. */
  zoomTo(scale: number, anchor?: Vec2): this {
    const next = clamp(scale, this.minScale, this.maxScale);
    if (next === this._scale) return this;

    const a = anchor ?? { x: this._width / 2, y: this._height / 2 };
    const world = this.screenToWorld(a);
    this._scale = next;
    // Re-solve the translation so `world` lands back on `a`.
    this._tx = a.x - world.x * next;
    this._ty = a.y - world.y * next;
    return this._touch();
  }

  /** Centres the viewport on a world point without changing zoom. */
  centerOn(p: Vec2): this {
    this._tx = this._width / 2 - p.x * this._scale;
    this._ty = this._height / 2 - p.y * this._scale;
    return this._touch();
  }

  /**
   * Frames a world rectangle, leaving `padding` CSS pixels on each side.
   * An empty rectangle (no content) is a no-op rather than a NaN camera.
   */
  fitToRect(target: Rect, padding = 32): this {
    if (isEmptyRect(target) || this._width <= 0 || this._height <= 0) return this;

    const availW = Math.max(1, this._width - padding * 2);
    const availH = Math.max(1, this._height - padding * 2);
    // A zero-width or zero-height target (a single point, a flat line) would
    // divide to Infinity, so only constrain on the axes that have extent.
    const fitW = target.w > 0 ? availW / target.w : Infinity;
    const fitH = target.h > 0 ? availH / target.h : Infinity;
    const fit = Math.min(fitW, fitH);

    this._scale = clamp(Number.isFinite(fit) ? fit : this._scale, this.minScale, this.maxScale);
    return this.centerOn(center(target));
  }

  /** The world-space rectangle currently visible in the viewport. */
  visibleWorldRect(): Rect {
    const topLeft = this.screenToWorld({ x: 0, y: 0 });
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: this._width / this._scale,
      h: this._height / this._scale,
    };
  }

  /** The transform in `ctx.setTransform` order, without device pixel ratio. */
  toMatrix(): Matrix2D {
    return [this._scale, 0, 0, this._scale, this._tx, this._ty];
  }

  /** Snapshot suitable for serialisation or undo. */
  toJSON(): { scale: number; tx: number; ty: number } {
    return { scale: this._scale, tx: this._tx, ty: this._ty };
  }

  /** Restores a snapshot. Viewport size is not part of camera state. */
  setState(state: { scale: number; tx: number; ty: number }): this {
    this._scale = clamp(state.scale, this.minScale, this.maxScale);
    this._tx = state.tx;
    this._ty = state.ty;
    return this._touch();
  }

  private _touch(): this {
    this._version++;
    return this;
  }
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
