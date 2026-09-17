import { describe, expect, it } from 'vitest';
import { Scene } from '../src/scene.js';
import type { SceneNode } from '../src/scene.js';

const node = (id: string, x: number, y: number, w = 10, h = 10): SceneNode => ({
  id,
  rect: { x, y, w, h },
});

describe('Scene', () => {
  it('agrees with the linear oracle', () => {
    const scene = new Scene({ cellSize: 32 });
    for (let i = 0; i < 400; i++) scene.add(node(`n${i}`, (i % 20) * 50, Math.floor(i / 20) * 50));

    const area = { x: 120, y: 120, w: 200, h: 200 };
    const indexed = scene
      .query(area)
      .map((n) => n.id)
      .sort();
    const linear = scene
      .queryLinear(area)
      .map((n) => n.id)
      .sort();
    expect(indexed).toEqual(linear);
    expect(indexed.length).toBeGreaterThan(0);
  });

  it('re-indexes on setRect', () => {
    const scene = new Scene({ cellSize: 32 });
    scene.add(node('a', 0, 0));
    expect(scene.query({ x: 900, y: 900, w: 50, h: 50 })).toHaveLength(0);

    scene.setRect('a', { x: 910, y: 910, w: 10, h: 10 });
    expect(scene.query({ x: 900, y: 900, w: 50, h: 50 }).map((n) => n.id)).toEqual(['a']);
    expect(scene.query({ x: 0, y: 0, w: 5, h: 5 })).toHaveLength(0);
  });

  it('drops a replaced node from the index', () => {
    const scene = new Scene({ cellSize: 32 });
    scene.add(node('a', 0, 0));
    scene.add(node('a', 500, 500));
    expect(scene.size).toBe(1);
    expect(scene.query({ x: -10, y: -10, w: 40, h: 40 })).toHaveLength(0);
    expect(scene.query({ x: 490, y: 490, w: 40, h: 40 })).toHaveLength(1);
  });

  it('removes nodes from the index', () => {
    const scene = new Scene();
    scene.add(node('a', 0, 0));
    expect(scene.remove('a')).toBe(true);
    expect(scene.remove('a')).toBe(false);
    expect(scene.query({ x: -100, y: -100, w: 200, h: 200 })).toHaveLength(0);
  });

  it('tracks bounds and invalidates them', () => {
    const scene = new Scene();
    scene.add(node('a', 0, 0, 10, 10));
    scene.add(node('b', 90, 40, 10, 10));
    expect(scene.bounds()).toEqual({ x: 0, y: 0, w: 100, h: 50 });

    scene.remove('b');
    expect(scene.bounds()).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('Scene.queryOrdered', () => {
  it('returns the same nodes as query, back to front', () => {
    const scene = new Scene({ cellSize: 16 });
    // Added in an order the index will not preserve: the grid returns nodes
    // bucket by bucket, which has nothing to do with paint order.
    scene.addAll([node('a', 0, 0, 40, 40), node('b', 60, 0, 40, 40), node('c', 20, 0, 40, 40)]);
    scene.bringToFront('a');
    scene.sendToBack('c');

    const area = { x: -10, y: -10, w: 200, h: 100 };
    const ordered = scene.queryOrdered(area);
    expect(ordered.map((n) => n.id)).toEqual(['c', 'b', 'a']);
    expect(ordered.map((n) => n.id).sort()).toEqual(
      scene.query(area).map((n) => n.id).sort(),
    );
  });

  it('is still culled', () => {
    const scene = new Scene({ cellSize: 16 });
    scene.addAll([node('near', 0, 0, 10, 10), node('far', 5000, 5000, 10, 10)]);
    expect(scene.queryOrdered({ x: -5, y: -5, w: 50, h: 50 }).map((n) => n.id)).toEqual(['near']);
  });
});
