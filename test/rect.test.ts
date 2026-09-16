import { describe, expect, it } from 'vitest';
import {
  containsPoint,
  emptyRect,
  inflate,
  intersects,
  isEmptyRect,
  rectFromPoints,
  union,
  unionAll,
} from '../src/math/rect.js';
import { niceStep } from '../src/renderer/canvas2d.js';

describe('rect', () => {
  it('treats touching edges as intersecting', () => {
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(true);
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10.1, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('is symmetric', () => {
    const a = { x: -5, y: -5, w: 20, h: 3 };
    const b = { x: 2, y: -6, w: 4, h: 40 };
    expect(intersects(a, b)).toBe(intersects(b, a));
  });

  it('unions ignore the empty rect', () => {
    const r = { x: 1, y: 2, w: 3, h: 4 };
    expect(isEmptyRect(emptyRect())).toBe(true);
    expect(union(emptyRect(), r)).toEqual(r);
    expect(unionAll([])).toEqual(emptyRect());
    expect(unionAll([r])).toEqual(r);
  });

  it('builds a rect from any two corners', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 4, y: 20 })).toEqual({ x: 4, y: 10, w: 6, h: 10 });
  });

  it('inflates on every side', () => {
    expect(inflate({ x: 0, y: 0, w: 10, h: 10 }, 2)).toEqual({ x: -2, y: -2, w: 14, h: 14 });
  });

  it('contains points on the boundary', () => {
    expect(containsPoint({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(containsPoint({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0 })).toBe(false);
  });
});

describe('niceStep', () => {
  it('snaps to a 1/2/5 series', () => {
    expect(niceStep(0.9)).toBeCloseTo(1);
    expect(niceStep(1.5)).toBeCloseTo(2);
    expect(niceStep(3)).toBeCloseTo(5);
    expect(niceStep(7)).toBeCloseTo(10);
    expect(niceStep(230)).toBeCloseTo(500);
  });

  it('degrades safely on bad input', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
    expect(niceStep(Infinity)).toBe(1);
  });
});
