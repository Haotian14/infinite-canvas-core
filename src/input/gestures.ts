import type { Camera } from '../camera.js';
import type { Vec2 } from '../types.js';

export interface GestureOptions {
  /** Called after the camera changes, so the host can schedule a redraw. */
  onChange?: () => void;
  /** Wheel-to-zoom sensitivity. Higher zooms faster. Default 0.01. */
  zoomSpeed?: number;
  /** Buttons that start a pan drag. Default: middle (1) and space+left. */
  panButtons?: number[];
}

export interface GestureHandle {
  detach(): void;
  /** True while a pan drag is in progress; useful for setting a grab cursor. */
  readonly isPanning: boolean;
}

/** One line of wheel delta, in CSS pixels. Matches what browsers use in practice. */
const LINE_HEIGHT = 16;

/**
 * Wires pointer and wheel input on `element` to `camera`, Figma-style:
 *
 * - two-finger scroll / plain wheel pans
 * - ctrl+wheel zooms, which is also how browsers report a trackpad pinch
 * - middle-drag, or space+left-drag, pans
 *
 * Distinguishing a pinch from a scroll is the whole trick here: a trackpad
 * pinch arrives as a `wheel` event with `ctrlKey` synthesised true, and there
 * is no other reliable signal. The event must be non-passive so that
 * `preventDefault` stops the browser's own page zoom.
 */
export function attachGestures(
  element: HTMLElement,
  camera: Camera,
  options: GestureOptions = {},
): GestureHandle {
  const zoomSpeed = options.zoomSpeed ?? 0.01;
  const panButtons = options.panButtons ?? [1];
  const notify = options.onChange ?? (() => {});

  let spaceHeld = false;
  let panPointer: number | null = null;
  let last: Vec2 = { x: 0, y: 0 };

  const localPoint = (e: { clientX: number; clientY: number }): Vec2 => {
    const box = element.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // deltaMode 1 is lines, 2 is pages; normalise everything to CSS pixels.
    const unit = e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? element.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;

    if (e.ctrlKey) {
      // Exponential so each notch is a constant *ratio*: zooming out then back
      // in by the same amount returns to exactly the scale you started at.
      camera.zoomBy(Math.exp(-dy * zoomSpeed), localPoint(e));
    } else {
      camera.panBy(-dx, -dy);
    }
    notify();
  };

  const onPointerDown = (e: PointerEvent): void => {
    const isPanButton = panButtons.includes(e.button) || (spaceHeld && e.button === 0);
    if (!isPanButton || panPointer !== null) return;
    panPointer = e.pointerId;
    last = { x: e.clientX, y: e.clientY };
    element.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== panPointer) return;
    camera.panBy(e.clientX - last.x, e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
    notify();
  };

  const endPan = (e: PointerEvent): void => {
    if (e.pointerId !== panPointer) return;
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    panPointer = null;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space') spaceHeld = true;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') spaceHeld = false;
  };

  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', endPan);
  element.addEventListener('pointercancel', endPan);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return {
    get isPanning() {
      return panPointer !== null;
    },
    detach(): void {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', endPan);
      element.removeEventListener('pointercancel', endPan);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
  };
}
