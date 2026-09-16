import type { ShapeNode } from '../src/index.js';
import { mulberry32 } from '../examples/shared/scene.js';

/**
 * The scene the landing page draws.
 *
 * Deliberately not the benchmark's scene. That one is a jittered uniform grid,
 * because uniform density is what makes a spatial-index measurement fair — and
 * uniform density is exactly what looks like television static at any zoom.
 *
 * This one clusters. Pulled back, the clusters read as structure instead of
 * noise; up close, the mix of sizes gives a composition. It also happens to be
 * cheaper: most shapes are small enough to fall to the sub-pixel path when the
 * view is wide, while the few large ones keep their edges.
 *
 * The numbers in the tables still come from the benchmark. The readout in the
 * corner measures whatever is actually on screen, which is this.
 */
const PALETTE = ['#6ea8fe', '#7ee7c7', '#f7a5c0', '#ffd36e', '#b39ddb', '#8fd3f4'];

/** Box–Muller, so clusters fall off smoothly instead of ending at a hard edge. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export function buildPageScene(count: number, extent: number, seed = 11): ShapeNode[] {
  const random = mulberry32(seed);
  const nodes: ShapeNode[] = new Array(count);

  const clusterCount = 54;
  const clusters = Array.from({ length: clusterCount }, () => ({
    x: random() * extent,
    y: random() * extent,
    // A wide spread of radii is what stops the field looking like polka dots.
    radius: extent * (0.018 + random() ** 2 * 0.07),
    weight: 0.25 + random() ** 1.8 * 3,
    hue: Math.floor(random() * PALETTE.length),
  }));

  const total = clusters.reduce((sum, c) => sum + c.weight, 0);
  let index = 0;

  for (const cluster of clusters) {
    // Nearly a third stay loose, so the gaps between clusters still have
    // something in them at close zoom.
    const share = Math.floor((count * 0.7 * cluster.weight) / total);
    for (let i = 0; i < share && index < count; i++, index++) {
      // The size range stays narrow. An earlier version let a few shapes run
      // to several hundred units; zoomed in they filled a third of the screen
      // with flat colour and read as misplaced page elements rather than as
      // canvas content.
      const big = random() > 0.97;
      const size = big ? 130 + random() * 110 : 16 + random() ** 2.2 * 105;
      nodes[index] = {
        id: `n${index}`,
        rect: {
          x: cluster.x + gaussian(random) * cluster.radius,
          y: cluster.y + gaussian(random) * cluster.radius,
          w: size * (0.55 + random() * 0.9),
          h: size * (0.55 + random() * 0.9),
        },
        // Mostly the cluster's hue, with enough strays to avoid flat blocks.
        fill: PALETTE[random() > 0.78 ? Math.floor(random() * PALETTE.length) : cluster.hue] as string,
      };
    }
  }

  for (; index < count; index++) {
    const size = 16 + random() ** 2.2 * 95;
    nodes[index] = {
      id: `n${index}`,
      rect: {
        x: random() * extent,
        y: random() * extent,
        w: size * (0.55 + random() * 0.9),
        h: size * (0.55 + random() * 0.9),
      },
      fill: PALETTE[Math.floor(random() * PALETTE.length)] as string,
    };
  }

  return nodes;
}
