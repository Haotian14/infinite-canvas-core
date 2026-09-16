import { describe, expect, it } from 'vitest';
import { UniformGrid } from '../src/spatial/uniform-grid.js';
import { intersects } from '../src/math/rect.js';
import type { Rect } from '../src/types.js';

/** Deterministic PRNG so a failure is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  id: number;
  rect: Rect;
}

function makeItems(count: number, seed: number, spread = 5000): Item[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, (_, id) => ({
    id,
    rect: {
      x: (random() - 0.5) * spread,
      y: (random() - 0.5) * spread,
      w: random() * 120,
      h: random() * 120,
    },
  }));
}

const brute = (items: Item[], area: Rect): Item[] =>
  items.filter((item) => intersects(item.rect, area));

const ids = (items: Item[]): number[] => items.map((i) => i.id).sort((a, b) => a - b);

describe('UniformGrid', () => {
  it('matches a brute-force scan over random queries', () => {
    const items = makeItems(2000, 1);
    const grid = new UniformGrid<Item>({ cellSize: 128 });
    for (const item of items) grid.insert(item, item.rect);

    const random = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const area: Rect = {
        x: (random() - 0.5) * 6000,
        y: (random() - 0.5) * 6000,
        w: random() * 1500,
        h: random() * 1500,
      };
      expect(ids(grid.search(area))).toEqual(ids(brute(items, area)));
    }
  });

  it('never returns duplicates for items spanning many cells', () => {
    const grid = new UniformGrid<Item>({ cellSize: 10 });
    const item: Item = { id: 1, rect: { x: 0, y: 0, w: 55, h: 55 } };
    grid.insert(item, item.rect);
    expect(grid.search({ x: -100, y: -100, w: 400, h: 400 })).toEqual([item]);
  });

  it('handles items far larger than the oversized-cell limit', () => {
    const grid = new UniformGrid<Item>({ cellSize: 1 });
    const huge: Item = { id: 1, rect: { x: -1e6, y: -1e6, w: 2e6, h: 2e6 } };
    const small: Item = { id: 2, rect: { x: 0, y: 0, w: 1, h: 1 } };
    grid.insert(huge, huge.rect);
    grid.insert(small, small.rect);

    expect(ids(grid.search({ x: 0, y: 0, w: 1, h: 1 }))).toEqual([1, 2]);
    expect(ids(grid.search({ x: 500000, y: 500000, w: 1, h: 1 }))).toEqual([1]);

    grid.remove(huge);
    expect(ids(grid.search({ x: 500000, y: 500000, w: 1, h: 1 }))).toEqual([]);
  });

  it('keeps results correct after updates and removals', () => {
    const items = makeItems(500, 7);
    const grid = new UniformGrid<Item>({ cellSize: 64 });
    for (const item of items) grid.insert(item, item.rect);

    const random = mulberry32(3);
    const live = [...items];
    for (let step = 0; step < 300; step++) {
      const victim = live[Math.floor(random() * live.length)] as Item;
      if (random() < 0.3) {
        grid.remove(victim);
        live.splice(live.indexOf(victim), 1);
      } else {
        victim.rect = { ...victim.rect, x: (random() - 0.5) * 5000, y: (random() - 0.5) * 5000 };
        grid.update(victim, victim.rect);
      }
    }

    expect(grid.size).toBe(live.length);
    const area: Rect = { x: -800, y: -800, w: 1600, h: 1600 };
    expect(ids(grid.search(area))).toEqual(ids(brute(live, area)));
  });

  it('rejects a non-positive cell size', () => {
    expect(() => new UniformGrid({ cellSize: 0 })).toThrow(/positive/);
  });
});
