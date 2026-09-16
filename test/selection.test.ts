import { describe, expect, it } from 'vitest';
import { Scene } from '../src/scene.js';
import { Selection } from '../src/select/selection.js';
import { computeSnap } from '../src/select/snap.js';
import type { Rect } from '../src/types.js';

describe('Selection', () => {
  it('adds, removes and toggles', () => {
    const s = new Selection();
    s.add('a', 'b');
    expect(s.size).toBe(2);
    expect(s.has('a')).toBe(true);

    s.toggle('a');
    expect(s.has('a')).toBe(false);
    s.toggle('a');
    expect(s.has('a')).toBe(true);

    s.remove('a', 'b');
    expect(s.size).toBe(0);
  });

  it('bumps version only on a real change', () => {
    const s = new Selection();
    s.add('a');
    const v = s.version;

    s.add('a');
    expect(s.version).toBe(v);
    s.remove('missing');
    expect(s.version).toBe(v);
    s.set(['a']);
    expect(s.version).toBe(v);
    s.clear();
    expect(s.version).toBe(v + 1);
    s.clear();
    expect(s.version).toBe(v + 1);
  });

  it('unions the bounds of what is selected, skipping what is gone', () => {
    const scene = new Scene();
    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } });
    scene.add({ id: 'b', rect: { x: 90, y: 40, w: 10, h: 10 } });

    const s = new Selection().add('a', 'b', 'ghost');
    expect(s.boundsIn(scene)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it('prunes ids whose nodes have left', () => {
    const scene = new Scene();
    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } });
    const s = new Selection().add('a', 'gone');

    expect(s.prune(scene)).toBe(1);
    expect(s.toArray()).toEqual(['a']);
    expect(s.prune(scene)).toBe(0);
  });
});

describe('computeSnap', () => {
  const target: Rect = { x: 100, y: 100, w: 100, h: 100 };

  it('aligns a near edge and reports a guide for it', () => {
    const moving: Rect = { x: 103, y: 400, w: 50, h: 50 };
    const snap = computeSnap(moving, { threshold: 6, targets: [target] });

    expect(snap.dx).toBe(-3);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([{ axis: 'x', at: 100, from: 100, to: 450 }]);
  });

  it('finds edge-to-edge adjacency without a special case', () => {
    // The moving shape's left is near the target's right.
    const snap = computeSnap({ x: 202, y: 400, w: 50, h: 50 }, { threshold: 6, targets: [target] });
    expect(snap.dx).toBe(-2);
  });

  it('aligns centres when asked, and not when told otherwise', () => {
    const moving: Rect = { x: 128, y: 400, w: 50, h: 50 }; // centre 153, target centre 150
    expect(computeSnap(moving, { threshold: 6, targets: [target] }).dx).toBe(-3);
    expect(computeSnap(moving, { threshold: 6, targets: [target], centres: false }).dx).toBe(0);
  });

  it('takes the nearest of several candidates', () => {
    const near: Rect = { x: 104, y: 400, w: 10, h: 10 };
    const snap = computeSnap({ x: 105, y: 500, w: 20, h: 20 }, {
      threshold: 10,
      targets: [target, near],
    });
    // 104 is one away; 100 is five.
    expect(snap.dx).toBe(-1);
  });

  it('does nothing outside the threshold, or with none', () => {
    const far: Rect = { x: 140, y: 400, w: 50, h: 50 };
    expect(computeSnap(far, { threshold: 6, targets: [target] })).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
    expect(computeSnap(far, { threshold: 0, targets: [target] }).guides).toEqual([]);
    expect(computeSnap(far, { threshold: 6, targets: [] }).guides).toEqual([]);
  });

  it('snaps both axes at once', () => {
    const snap = computeSnap({ x: 98, y: 97, w: 100, h: 100 }, { threshold: 6, targets: [target] });
    expect(snap.dx).toBe(2);
    expect(snap.dy).toBe(3);
    expect(snap.guides).toHaveLength(2);
  });
});
