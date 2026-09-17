import { afterEach, describe, expect, it } from 'vitest';
import { setFrameScheduler, watchVersion } from '../src/react/frame.js';
import { Camera } from '../src/index.js';

/**
 * A manual clock. The bindings coalesce on the frame, so a test that could not
 * say when a frame happened could not say anything about the coalescing.
 */
function manualFrames(): { step(): void; pending(): boolean; restore(): void } {
  const queue: (() => void)[] = [];
  const previous = setFrameScheduler(
    (callback) => queue.push(callback),
    () => queue.length = 0,
  );
  return {
    step: () => {
      const due = queue.splice(0, queue.length);
      for (const callback of due) callback();
    },
    pending: () => queue.length > 0,
    restore: () => setFrameScheduler(previous[0], previous[1]),
  };
}

let frames: ReturnType<typeof manualFrames> | null = null;
afterEach(() => {
  frames?.restore();
  frames = null;
});

describe('the shared frame', () => {
  it('notifies only when the number moves', () => {
    frames = manualFrames();
    const camera = new Camera().setViewport(100, 100);
    let calls = 0;
    const stop = watchVersion(() => camera.version, () => calls++);

    frames.step();
    expect(calls).toBe(0);

    camera.panBy(10, 0);
    frames.step();
    expect(calls).toBe(1);

    frames.step();
    expect(calls).toBe(1);
    stop();
  });

  it('collapses a burst of changes into one notification', () => {
    frames = manualFrames();
    const camera = new Camera().setViewport(100, 100);
    let calls = 0;
    const stop = watchVersion(() => camera.version, () => calls++);

    // What a drag does: many mutations between two frames.
    for (let i = 0; i < 50; i++) camera.panBy(1, 0);
    expect(camera.version).toBeGreaterThanOrEqual(50);

    frames.step();
    expect(calls).toBe(1);
    stop();
  });

  it('stops scheduling once the last watcher leaves', () => {
    frames = manualFrames();
    const camera = new Camera().setViewport(100, 100);
    const stop = watchVersion(() => camera.version, () => {});
    expect(frames.pending()).toBe(true);

    stop();
    frames.step();
    expect(frames.pending()).toBe(false);
  });

  it('keeps running for the watchers that remain', () => {
    frames = manualFrames();
    const a = new Camera().setViewport(100, 100);
    const b = new Camera().setViewport(100, 100);
    let aCalls = 0;
    let bCalls = 0;
    const stopA = watchVersion(() => a.version, () => aCalls++);
    const stopB = watchVersion(() => b.version, () => bCalls++);

    stopA();
    b.panBy(5, 0);
    frames.step();
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
    stopB();
  });

  it('survives a watcher that unsubscribes from inside its own notification', () => {
    frames = manualFrames();
    const camera = new Camera().setViewport(100, 100);
    let calls = 0;
    // A component that unmounts in response to the change it was watching:
    // the set is being iterated when this happens.
    const stop = watchVersion(() => camera.version, () => {
      calls++;
      stop();
    });

    camera.panBy(1, 0);
    expect(() => frames!.step()).not.toThrow();
    expect(calls).toBe(1);

    camera.panBy(1, 0);
    frames.step();
    expect(calls).toBe(1);
  });
});
