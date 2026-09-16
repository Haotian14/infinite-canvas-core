import type { Camera } from '../camera.js';
import type { Vec2 } from '../types.js';

export interface InertiaOptions {
  /** Speed below which the glide stops, in CSS pixels per second. Default 40. */
  minVelocity?: number;
  /** Fraction of velocity kept per 60th of a second. Default 0.92. */
  friction?: number;
  /** Velocity is estimated over the last this many milliseconds. Default 90. */
  sampleWindowMs?: number;
  /** Ceiling on release speed, in CSS pixels per second. Default 5000. */
  maxVelocity?: number;
}

export interface GestureOptions {
  /** Called after the camera changes, so the host can schedule a redraw. */
  onChange?: () => void;
  /** Wheel-to-zoom sensitivity. Higher zooms faster. Default 0.01. */
  zoomSpeed?: number;
  /** Mouse buttons that start a pan drag. Default: middle only. */
  panButtons?: number[];
  /**
   * What a single finger does. Default `'pan'`, which suits a viewer. An app
   * that puts selection or drawing on one finger should set `'ignore'` and
   * leave panning to two.
   */
  singleTouch?: 'pan' | 'ignore';
  /** Kinetic panning after a flick. Default true. */
  inertia?: boolean | InertiaOptions;
  /** Overridable clock and frame scheduler, so the state machine is testable. */
  now?: () => number;
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface GestureHandle {
  detach(): void;
  /** True while at least one pointer is driving the camera. */
  readonly isPanning: boolean;
  /** True while the camera is coasting after a flick. */
  readonly isGliding: boolean;
  /** Ends a glide early, e.g. because the host started its own animation. */
  stopInertia(): void;
}

/** One line of wheel delta, in CSS pixels. Matches what browsers use in practice. */
const LINE_HEIGHT = 16;

const DEFAULT_INERTIA: Required<InertiaOptions> = {
  minVelocity: 40,
  friction: 0.92,
  sampleWindowMs: 90,
  maxVelocity: 5000,
};

interface Sample {
  time: number;
  x: number;
  y: number;
}

/**
 * Wires pointer and wheel input on `element` to `camera`.
 *
 * Mouse and trackpad, Figma-style:
 * - two-finger scroll, or a plain wheel, pans
 * - ctrl+wheel zooms, which is also how a trackpad pinch arrives
 * - middle-drag, or space+left-drag, pans
 *
 * Touch:
 * - one finger pans (see {@link GestureOptions.singleTouch})
 * - two fingers pinch to zoom and pan together
 * - a flick coasts to a stop
 *
 * Every pointer gesture runs through one model: the centroid of the active
 * pointers is the thing being dragged, and their mean distance from it is the
 * zoom. One pointer simply has a constant spread, so a mouse drag and a
 * two-finger pinch are the same code path rather than two state machines that
 * disagree at the edges.
 */
export function attachGestures(
  element: HTMLElement,
  camera: Camera,
  options: GestureOptions = {},
): GestureHandle {
  const zoomSpeed = options.zoomSpeed ?? 0.01;
  const panButtons = options.panButtons ?? [1];
  const singleTouch = options.singleTouch ?? 'pan';
  const notify = options.onChange ?? (() => {});
  const inertia: Required<InertiaOptions> | null =
    options.inertia === false ? null : { ...DEFAULT_INERTIA, ...(options.inertia === true ? {} : options.inertia) };

  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));

  /** Pointers currently driving the camera, in client coordinates. */
  const pointers = new Map<number, Vec2>();
  let anchor: Vec2 = { x: 0, y: 0 };
  let spread = 0;
  let spaceHeld = false;

  let samples: Sample[] = [];
  let glideHandle: number | null = null;
  let velocity: Vec2 = { x: 0, y: 0 };
  let lastGlideTime = 0;

  const localPoint = (client: Vec2): Vec2 => {
    const box = element.getBoundingClientRect();
    return { x: client.x - box.left, y: client.y - box.top };
  };

  /** Centroid of the active pointers, and their mean distance from it. */
  const measure = (): { center: Vec2; spread: number } => {
    let sumX = 0;
    let sumY = 0;
    for (const p of pointers.values()) {
      sumX += p.x;
      sumY += p.y;
    }
    const count = pointers.size || 1;
    const center = { x: sumX / count, y: sumY / count };

    let total = 0;
    for (const p of pointers.values()) total += Math.hypot(p.x - center.x, p.y - center.y);
    return { center, spread: total / count };
  };

  /** Re-baselines the gesture, so adding or lifting a finger does not jump. */
  const rebase = (): void => {
    const measured = measure();
    anchor = measured.center;
    spread = measured.spread;
  };

  // --- inertia --------------------------------------------------------------

  function stopInertia(): void {
    if (glideHandle !== null) {
      cancelFrame(glideHandle);
      glideHandle = null;
    }
    velocity = { x: 0, y: 0 };
  }

  function recordSample(center: Vec2): void {
    if (inertia === null) return;
    const time = now();
    samples.push({ time, x: center.x, y: center.y });
    // Keep a little more than the estimation window so the oldest sample the
    // estimator needs is still present.
    const cutoff = time - inertia.sampleWindowMs * 2;
    while (samples.length > 2 && (samples[0] as Sample).time < cutoff) samples.shift();
  }

  function launchInertia(): void {
    if (inertia === null || samples.length < 2) return;

    const last = samples[samples.length - 1] as Sample;
    const cutoff = last.time - inertia.sampleWindowMs;
    // The oldest sample still inside the window; anything older describes an
    // earlier part of the drag and would drag the estimate toward zero.
    let first = samples[0] as Sample;
    for (const sample of samples) {
      if (sample.time >= cutoff) {
        first = sample;
        break;
      }
    }

    const elapsed = last.time - first.time;
    // A stationary finger held before release should not coast.
    if (elapsed <= 0 || now() - last.time > inertia.sampleWindowMs) return;

    let vx = ((last.x - first.x) / elapsed) * 1000;
    let vy = ((last.y - first.y) / elapsed) * 1000;
    const speed = Math.hypot(vx, vy);
    if (speed < inertia.minVelocity) return;
    if (speed > inertia.maxVelocity) {
      const limit = inertia.maxVelocity / speed;
      vx *= limit;
      vy *= limit;
    }

    velocity = { x: vx, y: vy };
    lastGlideTime = now();
    glideHandle = requestFrame(glide);
  }

  function glide(): void {
    if (inertia === null) return;
    const time = now();
    // Clamp the step: a backgrounded tab can hand back a delta of seconds,
    // which would teleport the camera on the first frame after it resumes.
    const dt = Math.min(time - lastGlideTime, 64);
    lastGlideTime = time;

    camera.panBy((velocity.x * dt) / 1000, (velocity.y * dt) / 1000);
    notify();

    // Friction is defined per 60th of a second, then raised to the number of
    // those that actually elapsed, so the glide decays at the same rate
    // regardless of frame rate.
    const decay = inertia.friction ** (dt / (1000 / 60));
    velocity = { x: velocity.x * decay, y: velocity.y * decay };

    if (Math.hypot(velocity.x, velocity.y) < inertia.minVelocity) {
      glideHandle = null;
      return;
    }
    glideHandle = requestFrame(glide);
  }

  // --- wheel ----------------------------------------------------------------

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    stopInertia();

    // deltaMode 1 is lines, 2 is pages; normalise everything to CSS pixels.
    const unit =
      event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? element.clientHeight : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;

    if (event.ctrlKey) {
      // Exponential so each notch is a constant ratio: zooming out and back in
      // by the same amount returns to exactly the scale you started at.
      camera.zoomBy(
        Math.exp(-dy * zoomSpeed),
        localPoint({ x: event.clientX, y: event.clientY }),
      );
    } else {
      camera.panBy(-dx, -dy);
    }
    notify();
  };

  // --- pointers -------------------------------------------------------------

  const participates = (event: PointerEvent): boolean => {
    if (event.pointerType === 'touch') return singleTouch === 'pan' || pointers.size >= 1;
    return panButtons.includes(event.button) || (spaceHeld && event.button === 0);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!participates(event)) return;
    stopInertia();
    samples = [];

    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Baseline before capturing. `setPointerCapture` throws when the pointer
    // is no longer active — a synthetic event, or a real one whose pointer was
    // released between dispatch and handler — and an exception here would
    // otherwise leave `anchor` stale, so the next move pans by the pointer's
    // absolute position instead of its delta.
    rebase();
    recordSample(anchor);
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is an optimisation: without it a drag leaving the element
      // stops updating, which beats not dragging at all.
    }
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const { center, spread: nextSpread } = measure();

    // Zoom first, anchored where the fingers were, so the world point under
    // the old centroid stays put; then translate that point to the new one.
    // Together they keep the content locked to the fingers.
    if (pointers.size >= 2 && spread > 0 && nextSpread > 0) {
      camera.zoomTo(camera.scale * (nextSpread / spread), localPoint(anchor));
    }
    camera.panBy(center.x - anchor.x, center.y - anchor.y);

    anchor = center;
    spread = nextSpread;
    recordSample(center);
    notify();
  };

  const endPointer = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;
    try {
      if (element.hasPointerCapture?.(event.pointerId)) {
        element.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // Already released by the browser; nothing to undo.
    }

    if (pointers.size > 0) {
      // Lifting one of several fingers changes the centroid; re-baseline so
      // the remaining fingers do not snap the content across the screen.
      rebase();
      samples = [];
      return;
    }
    if (event.type === 'pointercancel') samples = [];
    launchInertia();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') spaceHeld = true;
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') spaceHeld = false;
  };

  // The browser's own scrolling and pinch-zoom would otherwise swallow touch
  // input before it ever reaches these handlers.
  const previousTouchAction = element.style?.touchAction ?? '';
  if (element.style) element.style.touchAction = 'none';

  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', endPointer);
  element.addEventListener('pointercancel', endPointer);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return {
    get isPanning() {
      return pointers.size > 0;
    },
    get isGliding() {
      return glideHandle !== null;
    },
    stopInertia,
    detach(): void {
      stopInertia();
      pointers.clear();
      if (element.style) element.style.touchAction = previousTouchAction;
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', endPointer);
      element.removeEventListener('pointercancel', endPointer);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
  };
}
