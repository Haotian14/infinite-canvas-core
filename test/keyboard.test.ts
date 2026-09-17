import { beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../src/camera.js';
import { attachKeyboard } from '../src/input/keyboard.js';
import type { KeyboardOptions } from '../src/input/keyboard.js';
import type { Rect } from '../src/types.js';

/** Stands in for the window, so the bindings are testable in plain Node. */
function createTarget() {
  const handlers = new Set<(event: unknown) => void>();
  return {
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (type === 'keydown') handlers.add(handler);
    },
    removeEventListener(_type: string, handler: (event: unknown) => void) {
      handlers.delete(handler);
    },
    press(code: string, init: Record<string, unknown> = {}) {
      let prevented = false;
      const event = {
        code,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: null,
        preventDefault: () => {
          prevented = true;
        },
        ...init,
      };
      for (const handler of handlers) handler(event);
      return prevented;
    },
    count: () => handlers.size,
  };
}

const CONTENT: Rect = { x: 200, y: 100, w: 400, h: 200 };

let camera: Camera;
let target: ReturnType<typeof createTarget>;

function attach(options: KeyboardOptions = {}) {
  return attachKeyboard(camera, {
    target: target as unknown as Window,
    getContentBounds: () => CONTENT,
    ...options,
  });
}

beforeEach(() => {
  camera = new Camera().setViewport(800, 600);
  target = createTarget();
});

describe('attachKeyboard', () => {
  it('returns to 100% on cmd+0 and on ctrl+0', () => {
    attach();
    camera.zoomTo(7.5);
    expect(target.press('Digit0', { metaKey: true })).toBe(true);
    expect(camera.scale).toBe(1);

    camera.zoomTo(0.1);
    target.press('Digit0', { ctrlKey: true });
    expect(camera.scale).toBe(1);
  });

  it('ignores a bare 0', () => {
    attach();
    camera.zoomTo(3);
    expect(target.press('Digit0')).toBe(false);
    expect(camera.scale).toBe(3);
  });

  it('fits the content on shift+1', () => {
    attach();
    camera.zoomTo(9).panBy(4000, 4000);
    expect(target.press('Digit1', { shiftKey: true })).toBe(true);

    const topLeft = camera.worldToScreen(CONTENT);
    const bottomRight = camera.worldToScreen({ x: CONTENT.x + CONTENT.w, y: CONTENT.y + CONTENT.h });
    expect(topLeft.x).toBeGreaterThanOrEqual(48 - 1e-6);
    expect(bottomRight.x).toBeLessThanOrEqual(800 - 48 + 1e-6);
    expect(bottomRight.y).toBeLessThanOrEqual(600 - 48 + 1e-6);
  });

  it('leaves shift+2 inert when nothing supplies a selection', () => {
    attach();
    const before = camera.toJSON();
    // Not handled, so the key is not swallowed either.
    expect(target.press('Digit2', { shiftKey: true })).toBe(false);
    expect(camera.toJSON()).toEqual(before);
  });

  it('fits a selection when one is supplied', () => {
    attach({ getSelectionBounds: () => ({ x: 0, y: 0, w: 100, h: 100 }) });
    expect(target.press('Digit2', { shiftKey: true })).toBe(true);
    expect(camera.screenToWorld({ x: 400, y: 300 })).toEqual({ x: 50, y: 50 });
  });

  it('zooms about the viewport centre', () => {
    attach();
    const centre = camera.screenToWorld({ x: 400, y: 300 });
    target.press('Equal');
    expect(camera.scale).toBeCloseTo(1.25, 6);
    expect(camera.screenToWorld({ x: 400, y: 300 })).toEqual(centre);

    target.press('Minus');
    expect(camera.scale).toBeCloseTo(1, 6);
  });

  it('pans with the arrows, and finely with shift', () => {
    attach();
    target.press('ArrowRight');
    expect(camera.tx).toBe(-80);
    target.press('ArrowLeft', { shiftKey: true });
    expect(camera.tx).toBe(-72);
    target.press('ArrowUp');
    expect(camera.ty).toBe(80);
  });

  it('keeps out of the way while somebody is typing', () => {
    attach();
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const before = camera.toJSON();
      expect(target.press('Digit1', { shiftKey: true, target: { tagName } })).toBe(false);
      expect(camera.toJSON()).toEqual(before);
    }
    const before = camera.toJSON();
    target.press('Equal', { target: { tagName: 'DIV', isContentEditable: true } });
    expect(camera.toJSON()).toEqual(before);

    // A plain element is not typing, so the binding still works.
    target.press('Equal', { target: { tagName: 'DIV', isContentEditable: false } });
    expect(camera.scale).toBeGreaterThan(1);
  });

  it('zooms on the modifier too, taking the browser\'s page zoom', () => {
    // Deliberate, and the one binding here that does not stand down for a
    // modifier: cmd/ctrl + `=` is what people press to zoom a canvas. Pinned
    // by a test so it stays a decision rather than drifting back into an
    // oversight.
    attach();
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      camera.zoomTo(1);
      expect(target.press('Equal', mod)).toBe(true);
      expect(camera.scale).toBeCloseTo(1.25, 9);
      expect(target.press('Minus', mod)).toBe(true);
      expect(camera.scale).toBeCloseTo(1, 9);
    }
  });

  it('ignores anything with alt held, and unbinds on detach', () => {
    const handle = attach();
    expect(target.press('Equal', { altKey: true })).toBe(false);
    expect(camera.scale).toBe(1);

    handle.detach();
    expect(target.count()).toBe(0);
    target.press('Equal');
    expect(camera.scale).toBe(1);
  });
});
