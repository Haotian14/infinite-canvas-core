import { niceStep } from '../../src/index.js';
import type {
  Camera,
  NodeId,
  Rect,
  RenderStats,
  Renderer,
  Scene,
  Selection,
  SnapGuide,
} from '../../src/index.js';
import type { Item } from './model.js';

export interface Overlay {
  /** The live selection, not a copy: it changes on every pointer event. */
  selected: Selection | null;
  marquee: Rect | null;
  guides: readonly SnapGuide[];
  /** The rectangle a create tool is dragging out. */
  draft: Rect | null;
  /** Hidden here because a DOM text editor is showing it instead. */
  editing: NodeId | null;
}

const GROUND = '#f2f3f5';
const GRID = 'rgba(15, 22, 41, 0.055)';
const INK = '#151a24';
const ACCENT = '#2f6bff';
const GUIDE = '#ff3d71';

/**
 * A whiteboard renderer, written against the same three-method interface the
 * engine ships one implementation of.
 *
 * `Renderer` asks for `resize`, `render` and `destroy`. Everything else here —
 * the overlay, the text layout — is this renderer's own API, which is the
 * point of keeping the interface that small.
 */
export class WhiteboardRenderer implements Renderer<Item> {
  readonly overlay: Overlay = {
    selected: null,
    marquee: null,
    guides: [],
    draft: null,
    editing: null,
  };

  private readonly _canvas: HTMLCanvasElement;
  private readonly _ctx: CanvasRenderingContext2D;
  private _dpr = 1;
  private _w = 0;
  private _h = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('WhiteboardRenderer: no 2d context');
    this._canvas = canvas;
    this._ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this._w = cssWidth;
    this._h = cssHeight;
    this._dpr = dpr;
    this._canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this._canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this._canvas.style.width = `${cssWidth}px`;
    this._canvas.style.height = `${cssHeight}px`;
  }

  render(scene: Scene<Item>, camera: Camera): RenderStats {
    const started = performance.now();
    const ctx = this._ctx;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, this._w, this._h);

    const view = camera.visibleWorldRect();
    this._drawGrid(camera, view);

    // Back to front: on a board the overlaps are the content, so index order
    // is not good enough here.
    const visible = scene.queryOrdered(view);
    for (const item of visible) this._drawItem(item, camera);

    this._drawOverlay(scene, camera);

    return {
      total: scene.size,
      drawn: visible.length,
      culled: scene.size - visible.length,
      durationMs: performance.now() - started,
    };
  }

  destroy(): void {
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private _drawGrid(camera: Camera, view: Rect): void {
    const ctx = this._ctx;
    const step = niceStep(72 / camera.scale);
    const screenStep = step * camera.scale;
    if (screenStep < 6) return;

    ctx.beginPath();
    for (let x = Math.ceil(view.x / step) * step; x < view.x + view.w; x += step) {
      const sx = Math.round(x * camera.scale + camera.tx) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this._h);
    }
    for (let y = Math.ceil(view.y / step) * step; y < view.y + view.h; y += step) {
      const sy = Math.round(y * camera.scale + camera.ty) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(this._w, sy);
    }
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private _drawItem(item: Item, camera: Camera): void {
    const ctx = this._ctx;
    const r = camera.worldToScreenRect(item.rect);

    ctx.fillStyle = item.fill;
    if (item.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const radius = item.kind === 'note' ? Math.min(6 * camera.scale, 10) : 3;
      roundRect(ctx, r, radius);
      if (item.kind === 'note') {
        // A sticky note reads as one because of the shadow, not the colour.
        ctx.shadowColor = 'rgba(15, 22, 41, 0.18)';
        ctx.shadowBlur = 10 * Math.min(camera.scale, 1.5);
        ctx.shadowOffsetY = 2 * Math.min(camera.scale, 1.5);
      }
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }

    if (item.text && item.id !== this.overlay.editing) this._drawText(item, r, camera.scale);
  }

  private _drawText(item: Item, r: Rect, scale: number): void {
    const size = 14 * scale;
    // Below this the glyphs are noise, and laying them out is the most
    // expensive thing on the frame.
    if (size < 6) return;

    const ctx = this._ctx;
    const pad = 12 * scale;
    ctx.fillStyle = INK;
    ctx.font = `${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';

    const lines = wrap(ctx, item.text, r.w - pad * 2);
    const lineHeight = size * 1.35;
    let y = r.y + pad;
    for (const line of lines) {
      if (y + lineHeight > r.y + r.h - pad + lineHeight) break;
      ctx.fillText(line, r.x + pad, y);
      y += lineHeight;
    }
  }

  private _drawOverlay(scene: Scene<Item>, camera: Camera): void {
    const ctx = this._ctx;
    const { selected, guides, marquee, draft } = this.overlay;

    if (selected && selected.size > 0) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      for (const id of selected.ids()) {
        const node = scene.get(id);
        if (!node) continue;
        const r = camera.worldToScreenRect(node.rect);
        ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3);
      }
    }

    if (guides.length > 0) {
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const guide of guides) {
        const at = Math.round(
          guide.axis === 'x' ? guide.at * camera.scale + camera.tx : guide.at * camera.scale + camera.ty,
        ) + 0.5;
        const from = guide.axis === 'x' ? guide.from * camera.scale + camera.ty : guide.from * camera.scale + camera.tx;
        const to = guide.axis === 'x' ? guide.to * camera.scale + camera.ty : guide.to * camera.scale + camera.tx;
        if (guide.axis === 'x') {
          ctx.moveTo(at, from);
          ctx.lineTo(at, to);
        } else {
          ctx.moveTo(from, at);
          ctx.lineTo(to, at);
        }
      }
      ctx.stroke();
    }

    for (const [box, dashed] of [
      [marquee, true],
      [draft, false],
    ] as const) {
      if (!box) continue;
      const r = camera.worldToScreenRect(box);
      ctx.save();
      if (dashed) ctx.setLineDash([4, 3]);
      ctx.fillStyle = 'rgba(47, 107, 255, 0.10)';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      ctx.restore();
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const k = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  ctx.beginPath();
  ctx.moveTo(r.x + k, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, k);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, k);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, k);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, k);
  ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}
