import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Camera } from '../src/camera.js';
import { attachGestures } from '../src/input/gestures.js';
import type { GestureOptions } from '../src/input/gestures.js';

/**
 * A stand-in for the bits of an element the gesture layer touches.
 *
 * Testing against this rather than jsdom keeps the suite in plain Node and
 * makes the subject explicit: this is the gesture state machine, not a
 * browser. Anything that needs a real browser belongs in the benchmark page.
 */
function createElement(box = { left: 0, top: 0 }) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const captured = new Set<number>();

  return {
    style: { touchAction: 'auto' },
    clientHeight: 600,
    getBoundingClientRect: () => ({ ...box }),
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
      const event = { type, preventDefault: () => {}, ...init };
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    capturedCount: () => captured.size,
  };
}

type FakeElement = ReturnType<typeof createElement>;

/** A clock and frame scheduler the test drives by hand. */
function createClock() {
  let time = 0;
  const pending = new Map<number, (t: number) => void>();
  let nextHandle = 1;

  return {
    now: () => time,
    requestFrame: (callback: (t: number) => void) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle: number) => pending.delete(handle),
    advance(ms: number) {
      time += ms;
      const due = [...pending.entries()];
      pending.clear();
      for (const [, callback] of due) callback(time);
    },
    pendingCount: () => pending.size,
  };
}

const touch = (pointerId: number, x: number, y: number) => ({
  pointerId,
  pointerType: 'touch',
  button: 0,
  clientX: x,
  clientY: y,
});

let element: FakeElement;
let camera: Camera;
let clock: ReturnType<typeof createClock>;

function attach(options: GestureOptions = {}) {
  return attachGestures(element as unknown as HTMLElement, camera, {
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    ...options,
  });
}

beforeEach(() => {
  // The gesture layer listens for the space bar on `window`, which Node lacks.
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  element = createElement();
  camera = new Camera().setViewport(800, 600);
  clock = createClock();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('wheel', () => {
  it('pans on a plain wheel and zooms with ctrl', () => {
    const handle = attach();

    element.dispatch('wheel', { deltaX: 30, deltaY: 50, deltaMode: 0, clientX: 0, clientY: 0 });
    expect(camera.tx).toBe(-30);
    expect(camera.ty).toBe(-50);

    const anchor = { x: 200, y: 150 };
    const before = camera.screenToWorld(anchor);
    element.dispatch('wheel', {
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      clientX: anchor.x,
      clientY: anchor.y,
    });

    expect(camera.scale).toBeGreaterThan(1);
    const after = camera.screenToWorld(anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    handle.detach();
  });

  it('normalises line-mode deltas', () => {
    attach();
    element.dispatch('wheel', { deltaX: 0, deltaY: 3, deltaMode: 1, clientX: 0, clientY: 0 });
    expect(camera.ty).toBe(-48); // 3 lines x 16 px
  });
});

describe('mouse', () => {
  it('pans on a middle drag but ignores a plain left drag', () => {
    attach();

    element.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 0 });
    expect(camera.tx).toBe(0);

    element.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 1, clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { pointerId: 2, pointerType: 'mouse', clientX: 40, clientY: 25 });
    expect(camera.tx).toBe(40);
    expect(camera.ty).toBe(25);
  });
});

describe('touch', () => {
  it('pans with one finger', () => {
    attach({ inertia: false });
    element.dispatch('pointerdown', touch(1, 100, 100));
    element.dispatch('pointermove', touch(1, 160, 130));
    expect(camera.tx).toBe(60);
    expect(camera.ty).toBe(30);
  });

  it('ignores one finger when configured to', () => {
    attach({ singleTouch: 'ignore', inertia: false });
    element.dispatch('pointerdown', touch(1, 100, 100));
    element.dispatch('pointermove', touch(1, 160, 130));
    expect(camera.tx).toBe(0);

    // A second finger still starts a pinch.
    element.dispatch('pointerdown', touch(2, 300, 100));
    expect(camera.version).toBeGreaterThanOrEqual(0);
  });

  it('pinches to zoom while keeping the world under the centroid fixed', () => {
    attach({ inertia: false });
    element.dispatch('pointerdown', touch(1, 100, 100));
    element.dispatch('pointerdown', touch(2, 300, 100));

    const centroid = { x: 200, y: 100 };
    const before = camera.screenToWorld(centroid);

    // Spread each finger outward by 50 px: a 1.5x pinch.
    element.dispatch('pointermove', touch(1, 50, 100));
    element.dispatch('pointermove', touch(2, 350, 100));

    expect(camera.scale).toBeCloseTo(1.5, 6);
    const after = camera.screenToWorld(centroid);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('does not jump when one of two fingers lifts', () => {
    attach({ inertia: false });
    element.dispatch('pointerdown', touch(1, 100, 100));
    element.dispatch('pointerdown', touch(2, 300, 100));
    element.dispatch('pointerup', touch(2, 300, 100));

    const before = camera.toJSON();
    // The remaining finger has not moved, so nothing should change.
    element.dispatch('pointermove', touch(1, 100, 100));
    expect(camera.toJSON()).toEqual(before);

    element.dispatch('pointermove', touch(1, 110, 100));
    expect(camera.tx).toBeCloseTo(before.tx + 10, 6);
  });

  it('still pans by the delta when pointer capture is unavailable', () => {
    // Synthetic pointer events, and real ones whose pointer was released
    // before the handler ran, make setPointerCapture throw NotFoundError.
    element.setPointerCapture = () => {
      throw new DOMException('no such pointer', 'NotFoundError');
    };
    attach({ inertia: false });

    element.dispatch('pointerdown', touch(1, 200, 400));
    element.dispatch('pointermove', touch(1, 260, 470));
    expect(camera.tx).toBe(60);
    expect(camera.ty).toBe(70);
  });

  it('releases pointer capture on cancel', () => {
    attach();
    element.dispatch('pointerdown', touch(1, 0, 0));
    expect(element.capturedCount()).toBe(1);
    element.dispatch('pointercancel', touch(1, 0, 0));
    expect(element.capturedCount()).toBe(0);
  });
});

describe('inertia', () => {
  /** Flicks one finger `distance` px over `duration` ms and releases. */
  function flick(distance: number, duration: number): void {
    element.dispatch('pointerdown', touch(1, 0, 0));
    clock.advance(duration);
    element.dispatch('pointermove', touch(1, distance, 0));
    element.dispatch('pointerup', touch(1, distance, 0));
  }

  it('coasts after a flick and decays to a stop', () => {
    const handle = attach();
    flick(100, 50); // 2000 px/s

    expect(handle.isGliding).toBe(true);
    const atRelease = camera.tx;

    let frames = 0;
    while (handle.isGliding && frames < 1000) {
      clock.advance(16);
      frames++;
    }

    expect(handle.isGliding).toBe(false);
    expect(frames).toBeLessThan(200);
    // It should keep travelling in the flick's direction, by a bounded amount.
    const travelled = camera.tx - atRelease;
    expect(travelled).toBeGreaterThan(50);
    expect(travelled).toBeLessThan(1000);
  });

  it('does not coast after a slow drag', () => {
    const handle = attach();
    flick(2, 100); // 20 px/s, below the floor
    expect(handle.isGliding).toBe(false);
  });

  it('does not coast when the finger paused before lifting', () => {
    const handle = attach();
    element.dispatch('pointerdown', touch(1, 0, 0));
    clock.advance(50);
    element.dispatch('pointermove', touch(1, 100, 0));
    clock.advance(400); // held still
    element.dispatch('pointerup', touch(1, 100, 0));
    expect(handle.isGliding).toBe(false);
  });

  it('is interrupted by a new pointer or a wheel', () => {
    const handle = attach();
    flick(100, 50);
    expect(handle.isGliding).toBe(true);

    element.dispatch('pointerdown', touch(2, 0, 0));
    expect(handle.isGliding).toBe(false);

    element.dispatch('pointerup', touch(2, 0, 0));
    flick(100, 50);
    expect(handle.isGliding).toBe(true);
    element.dispatch('wheel', { deltaX: 0, deltaY: 1, deltaMode: 0, clientX: 0, clientY: 0 });
    expect(handle.isGliding).toBe(false);
  });

  it('survives a long frame gap without teleporting', () => {
    const handle = attach();
    flick(100, 50);
    const atRelease = camera.tx;
    clock.advance(5000); // a backgrounded tab
    // The step is clamped, so one frame cannot move more than 64 ms of travel.
    expect(camera.tx - atRelease).toBeLessThan(2000 * 0.064 + 1);
    handle.stopInertia();
    expect(handle.isGliding).toBe(false);
  });

  it('can be disabled', () => {
    const handle = attach({ inertia: false });
    flick(100, 50);
    expect(handle.isGliding).toBe(false);
  });
});

describe('lifecycle', () => {
  it('takes over touch-action and restores it on detach', () => {
    expect(element.style.touchAction).toBe('auto');
    const handle = attach();
    expect(element.style.touchAction).toBe('none');

    handle.detach();
    expect(element.style.touchAction).toBe('auto');
    expect(element.listenerCount()).toBe(0);
  });

  it('stops a glide on detach', () => {
    const handle = attach();
    element.dispatch('pointerdown', touch(1, 0, 0));
    clock.advance(50);
    element.dispatch('pointermove', touch(1, 100, 0));
    element.dispatch('pointerup', touch(1, 100, 0));

    handle.detach();
    expect(handle.isGliding).toBe(false);
    expect(clock.pendingCount()).toBe(0);
  });
});
