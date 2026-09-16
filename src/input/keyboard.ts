import type { Camera } from '../camera.js';
import type { Rect } from '../types.js';

export interface KeyboardOptions {
  /** Called after the camera changes, so the host can schedule a redraw. */
  onChange?: () => void;
  /** What `fit content` should frame. Return null when there is nothing to frame. */
  getContentBounds?: () => Rect | null;
  /** What `fit selection` should frame. Omit to leave that binding inert. */
  getSelectionBounds?: () => Rect | null;
  /** Padding for the fit bindings, in CSS pixels. Default 48. */
  fitPadding?: number;
  /** How far an arrow key moves the view, in CSS pixels. Default 80. */
  panStep?: number;
  /** Ratio per zoom keypress. Default 1.25. */
  zoomStep?: number;
  /** Where to listen. Default `window`. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface KeyboardHandle {
  detach(): void;
}

/**
 * Whether a key event is somebody typing rather than working the canvas.
 *
 * Bound to the window, which is what a canvas app wants, the bindings would
 * otherwise fire while the user is filling in a text field — typing `1` in a
 * search box would reframe the view behind it.
 */
function isTyping(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/**
 * Binds the keyboard shortcuts a canvas is expected to have.
 *
 * | keys | effect |
 * | --- | --- |
 * | `cmd/ctrl` + `0` | back to 100% |
 * | `shift` + `1` | fit the content |
 * | `shift` + `2` | fit the selection |
 * | `+` / `-` | zoom about the viewport centre |
 * | arrows | pan; hold `shift` for a tenth of a step |
 *
 * Keys are matched on `event.code`, not `event.key`: with shift held, `1`
 * arrives as `!` on a US layout and as something else again elsewhere, so
 * `key` would make the bindings layout-dependent.
 */
export function attachKeyboard(camera: Camera, options: KeyboardOptions = {}): KeyboardHandle {
  const notify = options.onChange ?? (() => {});
  const fitPadding = options.fitPadding ?? 48;
  const panStep = options.panStep ?? 80;
  const zoomStep = options.zoomStep ?? 1.25;
  const target = options.target ?? window;

  const fit = (bounds: Rect | null | undefined): boolean => {
    if (!bounds) return false;
    camera.fitToRect(bounds, fitPadding);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || isTyping(event)) return;
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;

    switch (event.code) {
      case 'Digit0':
      case 'Numpad0':
        if (!mod) return;
        camera.zoomTo(1);
        break;

      case 'Digit1':
        if (!event.shiftKey || mod) return;
        handled = fit(options.getContentBounds?.());
        break;

      case 'Digit2':
        if (!event.shiftKey || mod) return;
        handled = fit(options.getSelectionBounds?.());
        break;

      case 'Equal':
      case 'NumpadAdd':
        camera.zoomBy(zoomStep);
        break;

      case 'Minus':
      case 'NumpadSubtract':
        camera.zoomBy(1 / zoomStep);
        break;

      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (mod) return;
        // Shift is the fine adjustment here, the opposite of the usual
        // convention, because a canvas nudge wants precision more than reach.
        const step = event.shiftKey ? panStep / 10 : panStep;
        const dx = event.code === 'ArrowLeft' ? step : event.code === 'ArrowRight' ? -step : 0;
        const dy = event.code === 'ArrowUp' ? step : event.code === 'ArrowDown' ? -step : 0;
        camera.panBy(dx, dy);
        break;
      }

      default:
        return;
    }

    // A binding that found nothing to do should not swallow the key: leaving
    // cmd+0 to the browser's own zoom reset is better than eating it and doing
    // nothing visible.
    if (!handled) return;
    event.preventDefault();
    notify();
  };

  target.addEventListener('keydown', onKeyDown as EventListener);

  return {
    detach(): void {
      target.removeEventListener('keydown', onKeyDown as EventListener);
    },
  };
}
