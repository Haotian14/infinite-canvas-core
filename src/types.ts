/** A point or vector. Unless a name says `screen`, coordinates are world units. */
export interface Vec2 {
  x: number;
  y: number;
}

/** An axis-aligned rectangle, anchored at its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An affine transform restricted to uniform scale + translation, in the
 * column-major order `ctx.setTransform` expects: `[a, b, c, d, e, f]`.
 *
 * We deliberately do not support viewport rotation or skew. Dropping them
 * keeps every inverse a two-line division instead of a matrix solve, and
 * covers the overwhelming majority of canvas products.
 */
export type Matrix2D = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
];
