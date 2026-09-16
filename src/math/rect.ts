import type { Rect, Vec2 } from '../types.js';

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** A rectangle that is the identity element of {@link union}. */
export function emptyRect(): Rect {
  return { x: Infinity, y: Infinity, w: -Infinity, h: -Infinity };
}

export function isEmptyRect(r: Rect): boolean {
  return !(r.w >= 0 && r.h >= 0);
}

export function rectFromPoints(a: Vec2, b: Vec2): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function right(r: Rect): number {
  return r.x + r.w;
}

export function bottom(r: Rect): number {
  return r.y + r.h;
}

/** Touching edges count as intersecting, so items exactly on the viewport edge still draw. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function containsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function union(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}

export function unionAll(rects: Iterable<Rect>): Rect {
  let acc = emptyRect();
  for (const r of rects) acc = union(acc, r);
  return acc;
}

/** Grows (or, with a negative amount, shrinks) a rectangle on every side. */
export function inflate(r: Rect, amount: number): Rect {
  return { x: r.x - amount, y: r.y - amount, w: r.w + amount * 2, h: r.h + amount * 2 };
}

export function center(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
