import { mulberry32 } from '../examples/shared/scene.js';
import type { Body } from './renderer.js';

/**
 * The field the landing page draws.
 *
 * Deliberately not the benchmark's scene. That one is a jittered uniform grid,
 * because uniform density is what makes a spatial-index measurement fair — and
 * uniform density looks like television static at every zoom.
 *
 * Here the mass distribution does the work: overwhelmingly specks, a minority
 * of bodies, a handful large enough to read as lit. Pulled back, the clusters
 * are the structure; up close, the large bodies are the composition. It is
 * also what keeps the frame cheap, since almost everything falls to the
 * renderer's pixel path until you are close enough for it to matter.
 *
 * The tables still come from the benchmark. The readout measures this.
 */
export const PALETTE = [
  '#cfe2ff', // stars
  '#8fb8ff', // blue
  '#7ee7c7', // cyan
  '#ffd08a', // amber
  '#f7a5c0', // rose
  '#b39ddb', // violet
] as const;

/** Box–Muller, so a cluster falls off instead of ending at a hard edge. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export function buildPageScene(count: number, extent: number, seed = 11): Body[] {
  const random = mulberry32(seed);
  const nodes: Body[] = new Array(count);

  const clusters = Array.from({ length: 46 }, () => ({
    x: random() * extent,
    y: random() * extent,
    radius: extent * (0.02 + random() ** 2 * 0.075),
    weight: 0.3 + random() ** 1.7 * 3,
    // A cluster mostly shares a hue, the way a real one shares an age.
    tint: 1 + Math.floor(random() * (PALETTE.length - 1)),
  }));

  const total = clusters.reduce((sum, c) => sum + c.weight, 0);
  let index = 0;

  const place = (x: number, y: number, tint: number): void => {
    const roll = random();
    // Almost everything is a speck. The rare large bodies are what give a
    // close view something to be composed around.
    const size = roll > 0.988 ? 190 + random() * 330 : roll > 0.9 ? 40 + random() * 120 : 6 + random() ** 1.8 * 26;
    const mass = size > 180 ? 1 : size > 40 ? 0.6 : 0;
    // Square bounds: the renderer inscribes a disc, so anything else would
    // hand it an ellipse.
    nodes[index] = {
      id: `n${index}`,
      rect: { x, y, w: size, h: size },
      tint: mass === 0 && random() > 0.45 ? 0 : tint,
      mass,
    };
    index++;
  };

  for (const cluster of clusters) {
    const share = Math.floor((count * 0.72 * cluster.weight) / total);
    for (let i = 0; i < share && index < count; i++) {
      place(
        cluster.x + gaussian(random) * cluster.radius,
        cluster.y + gaussian(random) * cluster.radius,
        random() > 0.78 ? 1 + Math.floor(random() * (PALETTE.length - 1)) : cluster.tint,
      );
    }
  }

  // The rest are loose, so the space between clusters is not empty.
  while (index < count) {
    place(random() * extent, random() * extent, 1 + Math.floor(random() * (PALETTE.length - 1)));
  }

  return nodes;
}
