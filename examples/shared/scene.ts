import type { ShapeNode } from '../../src/index.js';

/** Deterministic PRNG, so every run builds byte-identical scenes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE = ['#6ea8fe', '#7ee7c7', '#f7a5c0', '#ffd36e', '#b39ddb', '#8fd3f4'];

/** World edge length that keeps node density constant as the count grows. */
export function worldSizeFor(count: number): number {
  return Math.sqrt(count) * 200;
}

/**
 * Nodes on a jittered grid rather than uniform random positions: real canvases
 * are locally clustered, and a perfectly uniform scatter flatters a grid index.
 */
export function buildNodes(count: number, seed = 1): ShapeNode[] {
  const random = mulberry32(seed);
  const columns = Math.ceil(Math.sqrt(count));
  const spacing = worldSizeFor(count) / columns;
  const nodes: ShapeNode[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const cx = (i % columns) * spacing;
    const cy = Math.floor(i / columns) * spacing;
    const w = 20 + random() * 100;
    const h = 20 + random() * 100;
    nodes[i] = {
      id: `n${i}`,
      rect: {
        x: cx + (random() - 0.5) * spacing * 0.8,
        y: cy + (random() - 0.5) * spacing * 0.8,
        w,
        h,
      },
      fill: PALETTE[i % PALETTE.length] as string,
    };
  }
  return nodes;
}
