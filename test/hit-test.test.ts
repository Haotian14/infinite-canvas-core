import { describe, expect, it } from 'vitest';
import { Scene } from '../src/scene.js';
import { ellipseContains, hitTest, hitTestAll, hitTestRect } from '../src/select/hit-test.js';
import type { SceneNode } from '../src/scene.js';

const node = (id: string, x: number, y: number, w = 100, h = 100): SceneNode => ({
  id,
  rect: { x, y, w, h },
});

function sceneOf(...nodes: SceneNode[]): Scene {
  const scene = new Scene({ cellSize: 64 });
  scene.addAll(nodes);
  return scene;
}

describe('hitTest', () => {
  it('returns the node under the point', () => {
    const scene = sceneOf(node('a', 0, 0), node('b', 300, 300));
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe('a');
    expect(hitTest(scene, { x: 350, y: 350 })?.id).toBe('b');
    expect(hitTest(scene, { x: 200, y: 200 })).toBeUndefined();
  });

  it('returns the topmost of overlapping nodes, and follows z changes', () => {
    const scene = sceneOf(node('under', 0, 0), node('over', 20, 20));
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe('over');

    scene.bringToFront('under');
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe('under');

    scene.sendToBack('under');
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe('over');
  });

  it('keeps a node hittable when it is replaced', () => {
    const scene = sceneOf(node('under', 0, 0), node('over', 20, 20));
    // Re-adding must not promote it above the node that was on top.
    scene.add(node('under', 0, 0));
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe('over');
  });

  it('applies tolerance around the bounds', () => {
    const scene = sceneOf(node('a', 0, 0, 10, 10));
    expect(hitTest(scene, { x: 14, y: 5 })).toBeUndefined();
    expect(hitTest(scene, { x: 14, y: 5 }, { tolerance: 5 })?.id).toBe('a');
  });

  it('defers to a precise test for non-rectangular content', () => {
    const scene = sceneOf(node('disc', 0, 0, 100, 100));
    // The corner is inside the bounds but outside the inscribed disc.
    expect(hitTest(scene, { x: 4, y: 4 })?.id).toBe('disc');
    expect(hitTest(scene, { x: 4, y: 4 }, { contains: ellipseContains })).toBeUndefined();
    expect(hitTest(scene, { x: 50, y: 50 }, { contains: ellipseContains })?.id).toBe('disc');
  });

  it('honours a filter', () => {
    const scene = sceneOf(node('a', 0, 0), node('b', 10, 10));
    expect(hitTest(scene, { x: 50, y: 50 }, { filter: (n) => n.id !== 'b' })?.id).toBe('a');
  });

  it('lists everything under a point, nearest first', () => {
    const scene = sceneOf(node('a', 0, 0), node('b', 10, 10), node('c', 20, 20));
    expect(hitTestAll(scene, { x: 50, y: 50 }).map((n) => n.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('hitTestRect', () => {
  const scene = sceneOf(node('inside', 20, 20, 40, 40), node('straddling', 90, 20, 40, 40));
  const area = { x: 0, y: 0, w: 100, h: 100 };

  it('intersect catches anything it touches', () => {
    expect(hitTestRect(scene, area, { mode: 'intersect' }).map((n) => n.id)).toEqual([
      'inside',
      'straddling',
    ]);
  });

  it('contain takes only what is wholly inside', () => {
    expect(hitTestRect(scene, area, { mode: 'contain' }).map((n) => n.id)).toEqual(['inside']);
  });

  it('returns results back to front', () => {
    const stack = sceneOf(node('a', 0, 0, 10, 10), node('b', 0, 0, 10, 10));
    stack.bringToFront('a');
    expect(hitTestRect(stack, { x: -5, y: -5, w: 30, h: 30 }).map((n) => n.id)).toEqual(['b', 'a']);
  });
});

describe('Scene z-order', () => {
  it('reports and reorders', () => {
    const scene = sceneOf(node('a', 0, 0), node('b', 0, 0), node('c', 0, 0));
    expect(scene.zOrdered().map((n) => n.id)).toEqual(['a', 'b', 'c']);

    scene.bringToFront('a');
    expect(scene.zOrdered().map((n) => n.id)).toEqual(['b', 'c', 'a']);

    scene.sendToBack('c');
    expect(scene.zOrdered().map((n) => n.id)).toEqual(['c', 'b', 'a']);

    expect(scene.bringToFront('missing')).toBe(false);
  });

  it('forgets a removed node, so an id reused later starts on top', () => {
    const scene = sceneOf(node('a', 0, 0), node('b', 0, 0));
    scene.remove('a');
    scene.add(node('a', 0, 0));
    expect(scene.zOrdered().map((n) => n.id)).toEqual(['b', 'a']);
  });
});
