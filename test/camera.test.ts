import { describe, expect, it } from 'vitest';
import { Camera } from '../src/camera.js';

const viewport = (w = 800, h = 600): Camera => new Camera().setViewport(w, h);

describe('Camera', () => {
  it('round-trips world and screen coordinates', () => {
    const camera = viewport().zoomTo(2.5).panBy(37, -91);
    for (const p of [
      { x: 0, y: 0 },
      { x: 123.456, y: -789.012 },
      { x: -1e6, y: 1e6 },
    ]) {
      const back = camera.screenToWorld(camera.worldToScreen(p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('keeps the world point under the zoom anchor pinned', () => {
    const camera = viewport();
    const anchor = { x: 640, y: 120 };
    const before = camera.screenToWorld(anchor);

    camera.zoomBy(3.7, anchor);
    const after = camera.screenToWorld(anchor);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('returns to the original scale after equal zoom out and in', () => {
    const camera = viewport();
    const anchor = { x: 200, y: 400 };
    camera.zoomBy(0.4, anchor).zoomBy(1 / 0.4, anchor);
    expect(camera.scale).toBeCloseTo(1, 12);
  });

  it('clamps scale to the configured range', () => {
    const camera = new Camera({ minScale: 0.5, maxScale: 4 }).setViewport(800, 600);
    expect(camera.zoomTo(100).scale).toBe(4);
    expect(camera.zoomTo(0.001).scale).toBe(0.5);
  });

  it('does not drift when zoom is clamped at the limit', () => {
    const camera = new Camera({ maxScale: 2 }).setViewport(800, 600).zoomTo(2);
    const anchor = { x: 10, y: 10 };
    const before = camera.toJSON();
    camera.zoomBy(4, anchor);
    expect(camera.toJSON()).toEqual(before);
  });

  it('fits a rectangle inside the viewport with padding', () => {
    const camera = viewport(800, 600);
    camera.fitToRect({ x: -50, y: -50, w: 200, h: 100 }, 20);

    const target = { x: -50, y: -50, w: 200, h: 100 };
    const topLeft = camera.worldToScreen(target);
    const bottomRight = camera.worldToScreen({ x: target.x + target.w, y: target.y + target.h });

    expect(topLeft.x).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(topLeft.y).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(bottomRight.x).toBeLessThanOrEqual(800 - 20 + 1e-6);
    expect(bottomRight.y).toBeLessThanOrEqual(600 - 20 + 1e-6);
    // The limiting axis should touch its padding exactly.
    expect(Math.min(topLeft.x, topLeft.y)).toBeCloseTo(20, 6);
  });

  it('survives fitting degenerate rectangles', () => {
    const camera = viewport();
    const before = camera.scale;
    camera.fitToRect({ x: 5, y: 5, w: 0, h: 0 });
    expect(camera.scale).toBe(before);
    expect(Number.isFinite(camera.tx)).toBe(true);
    expect(Number.isFinite(camera.ty)).toBe(true);
  });

  it('reports the visible world rectangle', () => {
    const camera = viewport(800, 600).zoomTo(2).centerOn({ x: 100, y: 50 });
    const view = camera.visibleWorldRect();
    expect(view.w).toBeCloseTo(400, 6);
    expect(view.h).toBeCloseTo(300, 6);
    expect(view.x + view.w / 2).toBeCloseTo(100, 6);
    expect(view.y + view.h / 2).toBeCloseTo(50, 6);
  });

  it('keeps the centre fixed across a resize', () => {
    const camera = viewport(800, 600).centerOn({ x: 42, y: -17 });
    camera.setViewport(1280, 720);
    const centre = camera.screenToWorld({ x: 640, y: 360 });
    expect(centre.x).toBeCloseTo(42, 6);
    expect(centre.y).toBeCloseTo(-17, 6);
  });

  it('bumps version only when state actually changes', () => {
    const camera = viewport();
    const before = camera.version;
    camera.panBy(0, 0).setViewport(800, 600);
    expect(camera.version).toBe(before);
    camera.panBy(1, 0);
    expect(camera.version).toBe(before + 1);
  });
});
