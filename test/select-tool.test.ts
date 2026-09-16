import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../src/camera.js';
import { Scene } from '../src/scene.js';
import { Selection } from '../src/select/selection.js';
import { attachSelectTool } from '../src/select/tool.js';
import type { SelectTool, SelectToolOptions } from '../src/select/tool.js';
import type { SceneNode } from '../src/scene.js';

function createElement() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const captured = new Set<number>();
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      (listeners.get(type) as Set<(event: unknown) => void>).add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type: string, init: Record<string, unknown> = {}) {
      const event = { type, button: 0, pointerId: 1, shiftKey: false, altKey: false, preventDefault: () => {}, ...init };
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const at = (id: string, x: number, y: number, w = 40, h = 40): SceneNode => ({
  id,
  rect: { x, y, w, h },
});

let element: ReturnType<typeof createElement>;
let scene: Scene;
let camera: Camera;
let selection: Selection;
let tool: SelectTool;
const keyHandlers = new Set<(e: unknown) => void>();

function attach(options: Partial<SelectToolOptions<SceneNode>> = {}): SelectTool {
  return attachSelectTool({
    element: element as unknown as HTMLElement,
    scene,
    camera,
    selection,
    snapDistance: 0,
    ...options,
  });
}

/** Presses at a point, moves through the given points, and releases. */
function drag(from: [number, number], ...through: Array<[number, number]>): void {
  element.dispatch('pointerdown', { clientX: from[0], clientY: from[1] });
  for (const [x, y] of through) element.dispatch('pointermove', { clientX: x, clientY: y });
  const last = through[through.length - 1] ?? from;
  element.dispatch('pointerup', { clientX: last[0], clientY: last[1] });
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    addEventListener: (_t: string, h: (e: unknown) => void) => keyHandlers.add(h),
    removeEventListener: (_t: string, h: (e: unknown) => void) => keyHandlers.delete(h),
  };
  keyHandlers.clear();
  element = createElement();
  scene = new Scene({ cellSize: 64 });
  scene.addAll([at('a', 0, 0), at('b', 200, 0), at('c', 0, 200)]);
  camera = new Camera().setViewport(800, 600);
  selection = new Selection();
});

afterEach(() => {
  tool?.detach();
  delete (globalThis as { window?: unknown }).window;
});

describe('click selection', () => {
  it('selects what was clicked and clears on empty space', () => {
    tool = attach();
    drag([20, 20]);
    expect(selection.toArray()).toEqual(['a']);

    drag([600, 400]);
    expect(selection.size).toBe(0);
  });

  it('shift toggles instead of replacing', () => {
    tool = attach();
    drag([20, 20]);
    drag([220, 20], [220, 20]);
    expect(selection.toArray()).toEqual(['b']);

    drag([20, 20], [20, 20]);
    element.dispatch('pointerdown', { clientX: 220, clientY: 20, shiftKey: true });
    element.dispatch('pointerup', { clientX: 220, clientY: 20, shiftKey: true });
    expect(new Set(selection.toArray())).toEqual(new Set(['a', 'b']));
  });

  it('keeps a multi-selection intact when one of its nodes is pressed', () => {
    tool = attach();
    // Marquee everything, then press one of them and drag.
    drag([-10, -10], [300, 300]);
    expect(selection.size).toBe(3);

    element.dispatch('pointerdown', { clientX: 20, clientY: 20 });
    // Still three: collapsing on press would make dragging a group impossible.
    expect(selection.size).toBe(3);
    element.dispatch('pointermove', { clientX: 60, clientY: 20 });
    expect(selection.size).toBe(3);
    element.dispatch('pointerup', { clientX: 60, clientY: 20 });
  });

  it('collapses to one when a selected node is clicked without dragging', () => {
    tool = attach();
    drag([-10, -10], [300, 300]);
    drag([20, 20], [20, 20]);
    expect(selection.toArray()).toEqual(['a']);
  });
});

describe('marquee', () => {
  it('takes only enclosed nodes when dragged rightward', () => {
    tool = attach();
    drag([-10, -10], [100, 100]);
    expect(selection.toArray()).toEqual(['a']);
  });

  it('takes anything it touches when dragged leftward', () => {
    tool = attach();
    // Right to left across the right edge of 'a'.
    drag([100, 20], [20, 20]);
    expect(selection.toArray()).toEqual(['a']);
  });

  it('adds to the existing selection with shift', () => {
    tool = attach();
    drag([220, 20], [220, 20]);
    element.dispatch('pointerdown', { clientX: -10, clientY: 190, shiftKey: true });
    element.dispatch('pointermove', { clientX: 100, clientY: 300, shiftKey: true });
    element.dispatch('pointerup', { clientX: 100, clientY: 300, shiftKey: true });
    expect(new Set(selection.toArray())).toEqual(new Set(['b', 'c']));
  });

  it('exposes the rectangle while dragging and drops it after', () => {
    tool = attach();
    // Pressing a node drags it; there is no marquee for that.
    element.dispatch('pointerdown', { clientX: 10, clientY: 10 });
    element.dispatch('pointermove', { clientX: 300, clientY: 200 });
    expect(tool.marquee).toBeNull();
    element.dispatch('pointerup', { clientX: 300, clientY: 200 });

    element.dispatch('pointerdown', { clientX: 600, clientY: 400 });
    element.dispatch('pointermove', { clientX: 700, clientY: 500 });
    expect(tool.marquee).toEqual({ x: 600, y: 400, w: 100, h: 100 });
    element.dispatch('pointerup', { clientX: 700, clientY: 500 });
    expect(tool.marquee).toBeNull();
  });
});

describe('drag', () => {
  it('moves the selection and re-indexes it', () => {
    tool = attach();
    drag([20, 20], [120, 70]);
    expect(scene.get('a')?.rect).toEqual({ x: 100, y: 50, w: 40, h: 40 });

    // The index has to have followed, or it vanishes when it scrolls into view.
    expect(scene.query({ x: 100, y: 50, w: 1, h: 1 }).map((n) => n.id)).toEqual(['a']);
    expect(scene.query({ x: 0, y: 0, w: 1, h: 1 })).toHaveLength(0);
  });

  it('moves every selected node by the same delta', () => {
    tool = attach();
    drag([-10, -10], [300, 300]);
    drag([20, 20], [30, 20]);
    expect(scene.get('a')?.rect.x).toBe(10);
    expect(scene.get('b')?.rect.x).toBe(210);
    expect(scene.get('c')?.rect.x).toBe(10);
  });

  it('measures from the anchor, so a released snap does not leave an offset', () => {
    tool = attach({ snapDistance: 6 });
    // 'b' sits at x=200; dragging 'a' near it snaps, then past it releases.
    element.dispatch('pointerdown', { clientX: 20, clientY: 20 });
    element.dispatch('pointermove', { clientX: 218, clientY: 20 });
    expect(scene.get('a')?.rect.x).toBe(200); // snapped to b's left edge
    element.dispatch('pointermove', { clientX: 320, clientY: 20 });
    expect(scene.get('a')?.rect.x).toBe(300); // exactly the pointer delta
    element.dispatch('pointerup', { clientX: 320, clientY: 20 });
  });

  it('reports guides while snapped and clears them after', () => {
    tool = attach({ snapDistance: 6 });
    element.dispatch('pointerdown', { clientX: 20, clientY: 20 });
    element.dispatch('pointermove', { clientX: 218, clientY: 20 });
    expect(tool.guides.length).toBeGreaterThan(0);
    element.dispatch('pointerup', { clientX: 218, clientY: 20 });
    expect(tool.guides).toHaveLength(0);
  });

  it('alt bypasses snapping', () => {
    tool = attach({ snapDistance: 6 });
    element.dispatch('pointerdown', { clientX: 20, clientY: 20, altKey: true });
    element.dispatch('pointermove', { clientX: 218, clientY: 20, altKey: true });
    expect(scene.get('a')?.rect.x).toBe(198);
    element.dispatch('pointerup', { clientX: 218, clientY: 20, altKey: true });
  });

  it('escape puts everything back', () => {
    tool = attach();
    drag([220, 20], [220, 20]);
    const before = selection.toArray();

    element.dispatch('pointerdown', { clientX: 20, clientY: 20 });
    element.dispatch('pointermove', { clientX: 120, clientY: 120 });
    expect(scene.get('a')?.rect.x).toBe(100);

    for (const h of keyHandlers) h({ key: 'Escape' });
    expect(scene.get('a')?.rect).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(selection.toArray()).toEqual(before);
    expect(tool.isDragging).toBe(false);
  });
});

describe('lifecycle', () => {
  it('ignores other buttons and unbinds on detach', () => {
    tool = attach();
    element.dispatch('pointerdown', { clientX: 20, clientY: 20, button: 1 });
    expect(selection.size).toBe(0);

    const before = element.listenerCount();
    expect(before).toBeGreaterThan(0);
    tool.detach();
    expect(element.listenerCount()).toBe(0);
  });
});
