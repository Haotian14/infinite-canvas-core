// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrictMode, act, createElement, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Camera, Scene, Selection } from '../src/index.js';
import type { RenderStats, Renderer, SceneNode } from '../src/index.js';
import { setFrameScheduler } from '../src/react/frame.js';
import { useCanvas, useSelectTool, useVersion } from '../src/react/index.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no 2d context, which is exactly why `useCanvas` takes a renderer
 * factory rather than drawing anything itself: the lifecycle is testable
 * without a graphics backend.
 */
class FakeRenderer implements Renderer<SceneNode> {
  readonly resizes: [number, number, number][] = [];
  frames = 0;
  destroyed = false;

  resize(width: number, height: number, dpr: number): void {
    this.resizes.push([width, height, dpr]);
  }

  render(): RenderStats {
    this.frames++;
    return { total: 0, drawn: 0, culled: 0, durationMs: 0 };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

let queue: (() => void)[] = [];
let previousScheduler: [unknown, unknown] | null = null;
let host: HTMLDivElement;
let root: Root;

function step(): void {
  act(() => {
    const due = queue.splice(0, queue.length);
    for (const callback of due) callback();
  });
}

function mount(node: ReactNode): void {
  act(() => root.render(node));
}

beforeEach(() => {
  queue = [];
  previousScheduler = setFrameScheduler(
    (callback) => queue.push(callback),
    () => {
      queue = [];
    },
  ) as unknown as [unknown, unknown];

  host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 640, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: 480, configurable: true });
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (previousScheduler) {
    const [request, cancel] = previousScheduler as [
      (callback: () => void) => number,
      (id: number) => void,
    ];
    setFrameScheduler(request, cancel);
  }
});

describe('useCanvas', () => {
  it('sizes the camera and the renderer from the parent, and draws once', () => {
    const scene = new Scene();
    const camera = new Camera();
    const built: FakeRenderer[] = [];

    mount(
      createElement(function Probe() {
        const handle = useCanvas({
          scene,
          camera,
          renderer: () => {
            const renderer = new FakeRenderer();
            built.push(renderer);
            return renderer;
          },
        });
        return createElement('canvas', { ref: handle.ref });
      }),
    );

    expect(built).toHaveLength(1);
    // The renderer writes a pixel size onto the canvas's own style, so the
    // parent's box is the only measurement that means anything.
    expect(built[0]!.resizes).toEqual([[640, 480, 1]]);
    expect(camera.width).toBe(640);
    expect(camera.height).toBe(480);
    expect(built[0]!.frames).toBe(1);
  });

  it('draws nothing while nothing changes', () => {
    const scene = new Scene();
    const camera = new Camera();
    const built: FakeRenderer[] = [];

    mount(
      createElement(function Probe() {
        const handle = useCanvas({
          scene,
          camera,
          renderer: () => {
            const renderer = new FakeRenderer();
            built.push(renderer);
            return renderer;
          },
        });
        return createElement('canvas', { ref: handle.ref });
      }),
    );

    const renderer = built[0]!;
    expect(renderer.frames).toBe(1);

    step();
    step();
    step();
    expect(renderer.frames).toBe(1);

    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } });
    step();
    expect(renderer.frames).toBe(2);

    // Many mutations, one frame, one draw.
    camera.panBy(1, 0);
    camera.panBy(1, 0);
    camera.zoomBy(1.1);
    step();
    expect(renderer.frames).toBe(3);
  });

  it('redraws for a watched counter that is not part of the scene', () => {
    const scene = new Scene();
    const camera = new Camera();
    const selection = new Selection();
    const built: FakeRenderer[] = [];

    mount(
      createElement(function Probe() {
        const handle = useCanvas({
          scene,
          camera,
          watch: [selection],
          renderer: () => {
            const renderer = new FakeRenderer();
            built.push(renderer);
            return renderer;
          },
        });
        return createElement('canvas', { ref: handle.ref });
      }),
    );

    const renderer = built[0]!;
    selection.add('a');
    step();
    expect(renderer.frames).toBe(2);
  });

  it('destroys the renderer on unmount', () => {
    const scene = new Scene();
    const camera = new Camera();
    const built: FakeRenderer[] = [];

    mount(
      createElement(function Probe() {
        const handle = useCanvas({
          scene,
          camera,
          renderer: () => {
            const renderer = new FakeRenderer();
            built.push(renderer);
            return renderer;
          },
        });
        return createElement('canvas', { ref: handle.ref });
      }),
    );
    mount(null);

    expect(built[0]!.destroyed).toBe(true);
  });

  it('builds exactly one renderer under StrictMode', () => {
    const scene = new Scene();
    const camera = new Camera();
    const built: FakeRenderer[] = [];
    let passes = 0;

    mount(
      createElement(
        StrictMode,
        null,
        createElement(function Probe() {
          passes++;
          const handle = useCanvas({
            scene,
            camera,
            renderer: () => {
              const renderer = new FakeRenderer();
              built.push(renderer);
              return renderer;
            },
          });
          return createElement('canvas', { ref: handle.ref });
        }),
      ),
    );

    // StrictMode is doing its job - the component body ran more than once.
    expect(passes).toBeGreaterThan(1);
    // And the canvas still built one renderer, because the element arrives
    // through state: on the commit StrictMode mounts, unmounts and remounts,
    // there is no element yet and the effect has nothing to do.
    expect(built).toHaveLength(1);
    expect(built[0]!.destroyed).toBe(false);

    const before = built[0]!.frames;
    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 1, h: 1 } });
    step();
    expect(built[0]!.frames).toBe(before + 1);
  });

  it('destroys and rebuilds exactly once across a remount', () => {
    const scene = new Scene();
    const camera = new Camera();
    const built: FakeRenderer[] = [];
    const Probe = function Probe() {
      const handle = useCanvas({
        scene,
        camera,
        renderer: () => {
          const renderer = new FakeRenderer();
          built.push(renderer);
          return renderer;
        },
      });
      return createElement('canvas', { ref: handle.ref });
    };

    mount(createElement(Probe));
    mount(null);
    mount(createElement(Probe));

    expect(built).toHaveLength(2);
    expect(built[0]!.destroyed).toBe(true);
    expect(built[1]!.destroyed).toBe(false);

    // The one that was torn down must be off the frame, not just unreferenced.
    const stale = built[0]!.frames;
    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 1, h: 1 } });
    step();
    expect(built[0]!.frames).toBe(stale);
    expect(built[1]!.frames).toBe(2);
  });
});

describe('useVersion', () => {
  it('renders once per frame however many times the source changed', () => {
    const camera = new Camera().setViewport(100, 100);
    let renders = 0;

    mount(
      createElement(function Probe() {
        renders++;
        useVersion(camera);
        return null;
      }),
    );

    const baseline = renders;
    for (let i = 0; i < 40; i++) camera.panBy(1, 0);
    step();
    expect(renders).toBe(baseline + 1);

    step();
    expect(renders).toBe(baseline + 1);
  });

  it('accepts null, for a source that does not exist yet', () => {
    expect(() =>
      mount(
        createElement(function Probe() {
          useVersion(null);
          return null;
        }),
      ),
    ).not.toThrow();
  });
});

describe('useSelectTool', () => {
  function Probe({ tolerance, onChange }: { tolerance: number; onChange: () => void }): ReactNode {
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const scene = sharedScene;
    const tool = useSelectTool(element, {
      scene,
      camera: sharedCamera,
      selection: sharedSelection,
      tolerance,
      onChange,
    });
    seen.push(tool);
    return createElement('div', { ref: setElement });
  }

  let sharedScene: Scene;
  let sharedCamera: Camera;
  let sharedSelection: Selection;
  let seen: (unknown | null)[];

  beforeEach(() => {
    sharedScene = new Scene();
    sharedCamera = new Camera().setViewport(200, 200);
    sharedSelection = new Selection();
    seen = [];
  });

  it('is null until the element exists, then stays the same object', () => {
    mount(createElement(Probe, { tolerance: 4, onChange: () => {} }));
    expect(seen[0]).toBeNull();
    const tool = seen[seen.length - 1];
    expect(tool).not.toBeNull();

    // A new inline handler on every render is the normal case, and it must
    // not tear the pointer listeners down and build them again.
    mount(createElement(Probe, { tolerance: 4, onChange: () => {} }));
    mount(createElement(Probe, { tolerance: 4, onChange: () => {} }));
    expect(seen[seen.length - 1]).toBe(tool);
  });

  it('re-attaches when a value option actually changes', () => {
    mount(createElement(Probe, { tolerance: 4, onChange: () => {} }));
    const tool = seen[seen.length - 1];

    mount(createElement(Probe, { tolerance: 12, onChange: () => {} }));
    expect(seen[seen.length - 1]).not.toBe(tool);
    expect(seen[seen.length - 1]).not.toBeNull();
  });
});
