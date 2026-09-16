import type { Scene, SceneNode } from '../scene.js';
import type { Rect, Vec2 } from '../types.js';
import { containsPoint, inflate, intersects } from '../math/rect.js';

export interface HitTestOptions<T extends SceneNode> {
  /**
   * Extra reach in **world** units. Convert from screen with
   * `camera.screenToWorldDistance(4)`, or a thin shape becomes unclickable the
   * moment you zoom out.
   */
  tolerance?: number;
  /**
   * A precise test, run only on nodes whose bounds already matched. Default is
   * the bounds themselves. This is the seam for non-rectangular content: a
   * renderer that draws discs supplies the disc test here.
   */
  contains?: (node: T, point: Vec2) => boolean;
  /** Nodes this rejects are invisible to the test. */
  filter?: (node: T) => boolean;
}

export interface RectTestOptions<T extends SceneNode> {
  /** `'intersect'` catches anything the rectangle touches; `'contain'` only what is inside it. */
  mode?: 'intersect' | 'contain';
  filter?: (node: T) => boolean;
}

/**
 * The node under a point, or undefined.
 *
 * Two layers on purpose. The index narrows a world of nodes to the few whose
 * bounds could match, and only those pay for the precise test — which is the
 * expensive one, and the only one that knows what the node actually looks like.
 *
 * Geometric, not colour-picked. Rendering ids into an offscreen buffer and
 * reading pixels back is easy to write and impossible to run without a canvas,
 * which would tie the engine to a renderer.
 */
export function hitTest<T extends SceneNode>(
  scene: Scene<T>,
  point: Vec2,
  options: HitTestOptions<T> = {},
): T | undefined {
  let best: T | undefined;
  let bestZ = -Infinity;

  for (const node of candidates(scene, point, options)) {
    const z = scene.zOf(node.id);
    if (z > bestZ) {
      best = node;
      bestZ = z;
    }
  }
  return best;
}

/** Everything under a point, nearest the viewer first. */
export function hitTestAll<T extends SceneNode>(
  scene: Scene<T>,
  point: Vec2,
  options: HitTestOptions<T> = {},
): T[] {
  return candidates(scene, point, options).sort((a, b) => scene.zOf(b.id) - scene.zOf(a.id));
}

function candidates<T extends SceneNode>(
  scene: Scene<T>,
  point: Vec2,
  options: HitTestOptions<T>,
): T[] {
  const tolerance = options.tolerance ?? 0;
  const contains = options.contains;
  const filter = options.filter;

  const area: Rect = {
    x: point.x - tolerance,
    y: point.y - tolerance,
    w: tolerance * 2,
    h: tolerance * 2,
  };

  const out: T[] = [];
  for (const node of scene.query(area)) {
    if (filter !== undefined && !filter(node)) continue;
    // The broad phase already applied the tolerance; the precise test gets the
    // real point, so `contains` never has to know it exists.
    if (contains === undefined) {
      if (!containsPoint(inflate(node.rect, tolerance), point)) continue;
    } else if (!contains(node, point)) {
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * Everything a rectangle selects, back to front.
 *
 * `'intersect'` is what a marquee dragged right-to-left does in most tools and
 * `'contain'` what one dragged left-to-right does; which to use is the caller's
 * decision, not this function's.
 */
export function hitTestRect<T extends SceneNode>(
  scene: Scene<T>,
  area: Rect,
  options: RectTestOptions<T> = {},
): T[] {
  const wantsContain = options.mode === 'contain';
  const filter = options.filter;
  const out: T[] = [];

  for (const node of scene.query(area)) {
    if (filter !== undefined && !filter(node)) continue;
    if (wantsContain ? !rectContainsRect(area, node.rect) : !intersects(area, node.rect)) continue;
    out.push(node);
  }
  return out.sort((a, b) => scene.zOf(a.id) - scene.zOf(b.id));
}

function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** The disc inscribed in a node's bounds. For renderers that draw round things. */
export function ellipseContains<T extends SceneNode>(node: T, point: Vec2): boolean {
  const { x, y, w, h } = node.rect;
  if (w <= 0 || h <= 0) return false;
  const nx = (point.x - (x + w / 2)) / (w / 2);
  const ny = (point.y - (y + h / 2)) / (h / 2);
  return nx * nx + ny * ny <= 1;
}
