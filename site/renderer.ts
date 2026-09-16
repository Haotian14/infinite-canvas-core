import { LodBuffer } from '../src/index.js';
import type { Camera, Renderer, RenderStats, Scene, SceneNode } from '../src/index.js';

export interface Body extends SceneNode {
  /** Index into the palette. */
  tint: number;
  /** 0 = a speck of light, 1 = a body with a lit limb. */
  mass: number;
}

/**
 * A renderer for the landing page, written against the public `Renderer`
 * interface and living entirely outside the library.
 *
 * It exists to make the page's own claim checkable: the engine hands a
 * renderer a scene and a camera and has no opinion about what comes out the
 * other side. Nothing here required a change to `src/`.
 *
 * Bodies are drawn from a sprite atlas rather than with a gradient per node —
 * `createRadialGradient` a hundred thousand times a frame is not a thing you
 * can do — and anything below a few pixels goes into the same pixel buffer the
 * built-in renderer uses, which is what keeps a starfield cheap.
 */
const SPRITE = 128;
const DISC = 0.74; // Fraction of the sprite the lit body occupies; the rest is glow.

export interface CosmosOptions {
  palette: readonly string[];
  background?: string;
  /** Bodies smaller than this many CSS pixels go to the pixel buffer. */
  lodMinScreenSize?: number;
}

export class CosmosRenderer<T extends Body = Body> implements Renderer<T> {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly palette: readonly string[];
  private readonly background: string;
  private readonly lodMin: number;
  private readonly lod = new LodBuffer();
  private readonly sprites: HTMLCanvasElement[] = [];

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(canvas: HTMLCanvasElement, options: CosmosOptions) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('CosmosRenderer: no 2d context');
    this.canvas = canvas;
    this.ctx = ctx;
    this.palette = options.palette;
    this.background = options.background ?? '#05070c';
    this.lodMin = options.lodMinScreenSize ?? 3;
    for (const colour of this.palette) this.sprites.push(makeSprite(colour));
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.lod.resize(this.canvas.width, this.canvas.height);
  }

  render(scene: Scene<T>, camera: Camera): RenderStats {
    const started = performance.now();
    const ctx = this.ctx;
    const dpr = this.dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    // Not additive. Under 'lighter' a dark pixel contributes nothing, so the
    // shaded limb of every body vanished and each one rendered as a glow.
    // The sprite's surround is transparent, so ordinary compositing does not
    // punch holes either, and bodies occlude each other the way they should.

    const view = camera.visibleWorldRect();
    const visible = scene.query({
      x: view.x - view.w * 0.02,
      y: view.y - view.h * 0.02,
      w: view.w * 1.04,
      h: view.h * 1.04,
    });

    const scale = camera.scale;
    const tx = camera.tx;
    const ty = camera.ty;
    const threshold = this.lodMin;
    const sprites = this.sprites;
    const lod = this.lod;
    lod.beginFrame();

    let plotted = false;
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i] as T;
      const rect = node.rect;
      const w = rect.w * scale;

      if (w < threshold) {
        // A speck of light: one or two pixels, straight into the buffer.
        lod.plot(
          (rect.x * scale + tx) * dpr,
          (rect.y * scale + ty) * dpr,
          w * dpr,
          rect.h * scale * dpr,
          this.palette[node.tint] as string,
        );
        plotted = true;
        continue;
      }

      // The sprite carries its own glow, so it is drawn larger than the body.
      const span = w / DISC;
      const cx = rect.x * scale + tx + w / 2;
      const cy = rect.y * scale + ty + (rect.h * scale) / 2;
      ctx.drawImage(sprites[node.tint] as HTMLCanvasElement, cx - span / 2, cy - span / 2, span, span);
    }

    if (plotted) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      lod.flush(ctx);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return {
      total: scene.size,
      drawn: visible.length,
      culled: scene.size - visible.length,
      durationMs: performance.now() - started,
    };
  }

  destroy(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

/**
 * One body, drawn once at high resolution and then scaled for every instance.
 *
 * The lit side is offset from centre so the whole field reads as lit from one
 * direction, which is most of what makes a disc look spherical rather than
 * like a circle with a gradient in it.
 */
function makeSprite(colour: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE;
  canvas.height = SPRITE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  const mid = SPRITE / 2;
  const radius = (SPRITE * DISC) / 2;
  const { r, g, b } = parse(colour);

  // Halo first, so the body sits on top of it. Kept tight and dim: a wide
  // bright one turns every body into a bokeh blob, which was the first thing
  // wrong with this.
  const halo = ctx.createRadialGradient(mid, mid, radius * 0.94, mid, mid, mid);
  halo.addColorStop(0, `rgb(${r} ${g} ${b} / 0.2)`);
  halo.addColorStop(0.35, `rgb(${r} ${g} ${b} / 0.055)`);
  halo.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, SPRITE, SPRITE);

  const lightX = mid - radius * 0.36;
  const lightY = mid - radius * 0.38;
  const body = ctx.createRadialGradient(lightX, lightY, radius * 0.05, mid, mid, radius);
  body.addColorStop(0, mixToward(r, g, b, 255, 0.78));
  body.addColorStop(0.26, mixToward(r, g, b, 255, 0.3));
  body.addColorStop(0.6, `rgb(${r} ${g} ${b})`);
  // A hard-ish terminator is what separates a sphere from a circle with a
  // gradient in it.
  body.addColorStop(0.86, mixToward(r, g, b, 0, 0.72));
  body.addColorStop(1, mixToward(r, g, b, 0, 0.93));

  ctx.beginPath();
  ctx.arc(mid, mid, radius, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();

  return canvas;
}

function parse(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function mixToward(r: number, g: number, b: number, target: number, amount: number): string {
  const m = (c: number): number => Math.round(c + (target - c) * amount);
  return `rgb(${m(r)} ${m(g)} ${m(b)})`;
}
