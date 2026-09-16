import type { Rect } from '../types.js';

export interface SnapGuide {
  /** `'x'` is a vertical line at `at`; `'y'` is a horizontal one. */
  axis: 'x' | 'y';
  /** Where the line sits, in world units. */
  at: number;
  /** The span to draw it over, so it reaches both the shape and what it matched. */
  from: number;
  to: number;
}

export interface SnapOptions {
  /** How near an alignment has to be to take, in **world** units. */
  threshold: number;
  /** Rectangles to align against. */
  targets: Iterable<Rect>;
  /** Also align centres and middles, not only edges. Default true. */
  centres?: boolean;
}

export interface SnapResult {
  /** Correction to apply, in world units. Zero on an axis that found nothing. */
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/** Left, centre, right — and the same three vertically. */
function lines(r: Rect, axis: 'x' | 'y', centres: boolean): number[] {
  const start = axis === 'x' ? r.x : r.y;
  const size = axis === 'x' ? r.w : r.h;
  return centres ? [start, start + size / 2, start + size] : [start, start + size];
}

/**
 * The nudge that puts a moving rectangle into alignment with its neighbours.
 *
 * Every combination of the three lines on each side is considered, so
 * edge-to-edge adjacency — a shape's left meeting another's right — falls out
 * of the same comparison as centre-to-centre alignment, without being a
 * separate case.
 *
 * The threshold is in world units, which means the caller converts from screen
 * with `camera.screenToWorldDistance`. Snapping that is constant in world units
 * gets unusable as you zoom out, because the same six pixels of hand movement
 * covers more and more ground.
 *
 * Only the targets you pass are considered. Feed it the viewport's contents
 * from the spatial index rather than the whole scene: snapping to something a
 * mile off screen is not a feature, and it costs a pass over everything.
 */
export function computeSnap(moving: Rect, options: SnapOptions): SnapResult {
  const { threshold, centres = true } = options;
  const result: SnapResult = { dx: 0, dy: 0, guides: [] };
  if (!(threshold > 0)) return result;

  let bestX = threshold;
  let bestY = threshold;
  let matchX: { at: number; target: Rect } | null = null;
  let matchY: { at: number; target: Rect } | null = null;

  const movingX = lines(moving, 'x', centres);
  const movingY = lines(moving, 'y', centres);

  for (const target of options.targets) {
    for (const at of lines(target, 'x', centres)) {
      for (const from of movingX) {
        const delta = at - from;
        // Strictly nearer, so the first target to offer a given distance wins
        // and the result does not depend on iteration order.
        if (Math.abs(delta) < bestX) {
          bestX = Math.abs(delta);
          result.dx = delta;
          matchX = { at, target };
        }
      }
    }
    for (const at of lines(target, 'y', centres)) {
      for (const from of movingY) {
        const delta = at - from;
        if (Math.abs(delta) < bestY) {
          bestY = Math.abs(delta);
          result.dy = delta;
          matchY = { at, target };
        }
      }
    }
  }

  // Guides describe where the shape ends up, so they are measured against the
  // snapped rectangle rather than the one that was passed in.
  if (matchX !== null) {
    const top = Math.min(moving.y + result.dy, matchX.target.y);
    const bottom = Math.max(moving.y + result.dy + moving.h, matchX.target.y + matchX.target.h);
    result.guides.push({ axis: 'x', at: matchX.at, from: top, to: bottom });
  }
  if (matchY !== null) {
    const left = Math.min(moving.x + result.dx, matchY.target.x);
    const right = Math.max(moving.x + result.dx + moving.w, matchY.target.x + matchY.target.w);
    result.guides.push({ axis: 'y', at: matchY.at, from: left, to: right });
  }

  return result;
}
