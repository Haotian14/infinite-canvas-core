import { useCallback, useEffect, useRef, useState } from 'react';
import type { Camera } from '../camera.js';
import type { Scene, SceneNode } from '../scene.js';
import type { Renderer, RenderStats } from '../renderer/types.js';
import { useLatest } from './internal.js';
import { watchVersion } from './frame.js';
import type { Versioned } from './frame.js';

export interface CanvasOptions<T extends SceneNode, R extends Renderer<T> = Renderer<T>> {
  scene: Scene<T>;
  camera: Camera;
  /**
   * Builds the renderer for the mounted canvas.
   *
   * A factory rather than an instance, so the hook owns the lifetime: it
   * constructs on mount and calls `destroy` on unmount, which is the part
   * people forget. It is read once per element — to change renderer options,
   * give the canvas a new `key`.
   */
  renderer: (canvas: HTMLCanvasElement) => R;
  /** Extra change counters that should trigger a redraw, e.g. a `Selection`. */
  watch?: readonly Versioned[];
  onRender?: (stats: RenderStats) => void;
  onResize?: (width: number, height: number, dpr: number) => void;
  /**
   * Ceiling on the device pixel ratio. Default 2: a phone reporting 3 costs
   * 2.25x the fill of 2 for a difference almost nobody can see.
   */
  maxDpr?: number;
}

export interface CanvasHandle<R> {
  /** Put this on the `<canvas>`. */
  ref: (node: HTMLCanvasElement | null) => void;
  /** The mounted canvas, or null before mount. Pass it to the input hooks. */
  element: HTMLCanvasElement | null;
  /**
   * The live renderer, or null before mount, at the type the factory returned
   * rather than flattened to the interface — a host that wrote its own
   * renderer needs its own methods back.
   */
  renderer: R | null;
  /**
   * Ask for a redraw on the next frame.
   *
   * Only needed for changes the engine's counters cannot see — a marquee
   * rectangle, alignment guides, an image that finished loading. Moving the
   * camera or the scene already redraws. Stable across renders.
   */
  invalidate: () => void;
}

const EMPTY: readonly Versioned[] = [];

/**
 * Owns the canvas element: its backing store, its renderer, and its frame.
 *
 * Nothing here is React-specific engine behaviour; it is the imperative
 * lifecycle that every host has to get right and that is easy to get wrong.
 * The three that bite:
 *
 * - The renderer writes an explicit pixel size onto the canvas's own style, so
 *   measuring the canvas would measure what we just set. The parent's content
 *   box is the size that means anything.
 * - `devicePixelRatio` changes when a window moves between monitors, and no
 *   resize event fires for it.
 * - A canvas is `display: inline` by default, so it sits on a text baseline and
 *   leaves a gap under it. In a parent sized by its content that gap is added
 *   to the height we measure, which we then set on the canvas, which grows the
 *   parent again.
 *
 * Rendering is on demand. A frame is drawn when the camera, the scene, or
 * anything in `watch` has changed, or when `invalidate` was called; a canvas
 * nobody is touching draws nothing.
 */
export function useCanvas<T extends SceneNode, R extends Renderer<T> = Renderer<T>>(
  options: CanvasOptions<T, R>,
): CanvasHandle<R> {
  const { scene, camera } = options;
  const maxDpr = options.maxDpr ?? 2;
  const latest = useLatest(options);

  const [element, setElement] = useState<HTMLCanvasElement | null>(null);
  const [renderer, setRenderer] = useState<R | null>(null);

  // `watch` is usually written as a literal, so it is a new array on every
  // render. Hold the last one whose members are the same objects.
  const watchRef = useRef<readonly Versioned[]>(EMPTY);
  const incoming = options.watch ?? EMPTY;
  if (
    incoming.length !== watchRef.current.length ||
    incoming.some((source, i) => source !== watchRef.current[i])
  ) {
    watchRef.current = incoming;
  }
  const watched = watchRef.current;

  const invalidateRef = useRef<() => void>(() => {});
  const invalidate = useCallback(() => invalidateRef.current(), []);

  useEffect(() => {
    if (element === null) return;

    // See the note above: inline canvas plus a content-sized parent is a
    // resize loop.
    element.style.display = 'block';

    const backend = latest.current.renderer(element);
    setRenderer(backend);

    let dirty = 0;
    let width = 0;
    let height = 0;
    let dpr = 0;

    const draw = (): void => {
      if (width <= 0 || height <= 0) return;
      const stats = backend.render(scene, camera);
      latest.current.onRender?.(stats);
    };

    const currentDpr = (): number => {
      const raw = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
      return Math.min(raw, maxDpr);
    };

    const apply = (nextWidth: number, nextHeight: number): void => {
      const nextDpr = currentDpr();
      // A detached or not-yet-laid-out parent measures zero. Keeping the last
      // real size beats resizing the camera to nothing and back.
      if (nextWidth <= 0 || nextHeight <= 0) return;
      if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;
      width = nextWidth;
      height = nextHeight;
      dpr = nextDpr;
      camera.setViewport(width, height);
      backend.resize(width, height, dpr);
      latest.current.onResize?.(width, height, dpr);
      dirty++;
    };

    const host = element.parentElement;
    const measure = (): void => {
      if (host) apply(host.clientWidth, host.clientHeight);
      else apply(window.innerWidth, window.innerHeight);
    };

    let observer: ResizeObserver | null = null;
    if (host && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) apply(box.width, box.height);
      });
      observer.observe(host);
    } else if (typeof addEventListener === 'function') {
      addEventListener('resize', measure);
    }

    // `(resolution: Ndppx)` matches exactly one ratio, so the query stops
    // matching the moment the ratio changes and has to be rebuilt each time.
    let query: MediaQueryList | null = null;
    const onRatioChange = (): void => {
      watchRatio();
      // A ratio no measurement can produce, so the equality guard in `apply`
      // lets the new one through even though the size has not moved.
      dpr = -1;
      apply(width, height);
    };
    const watchRatio = (): void => {
      query?.removeEventListener('change', onRatioChange);
      query = null;
      if (typeof matchMedia !== 'function') return;
      try {
        query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
        query.addEventListener('change', onRatioChange);
      } catch {
        query = null;
      }
    };
    watchRatio();

    measure();
    // Draw the first frame now rather than a frame later, so the canvas is
    // never briefly blank.
    dirty = 0;
    draw();

    // One counter for everything worth redrawing for. Versions only ever go
    // up, so their sum moves whenever any of them does, and the whole canvas
    // needs a single watcher rather than one per source.
    const unwatch = watchVersion(
      () => {
        let total = dirty + camera.version + scene.version;
        for (const source of watched) total += source.version;
        return total;
      },
      // Called from inside the shared frame, so this draws in the frame the
      // change was noticed rather than scheduling another one.
      draw,
    );
    invalidateRef.current = () => {
      dirty++;
    };

    return () => {
      invalidateRef.current = () => {};
      unwatch();
      observer?.disconnect();
      if (!observer && typeof removeEventListener === 'function') {
        removeEventListener('resize', measure);
      }
      query?.removeEventListener('change', onRatioChange);
      backend.destroy();
      setRenderer(null);
    };
  }, [element, scene, camera, watched, maxDpr, latest]);

  return { ref: setElement, element, renderer, invalidate };
}
