import { useEffect, useState } from 'react';
import type { Camera } from '../camera.js';
import type { SceneNode } from '../scene.js';
import { attachGestures } from '../input/gestures.js';
import type { GestureHandle, GestureOptions } from '../input/gestures.js';
import { attachKeyboard } from '../input/keyboard.js';
import type { KeyboardOptions } from '../input/keyboard.js';
import { attachSelectTool } from '../select/tool.js';
import type { SelectTool, SelectToolOptions } from '../select/tool.js';
import { useLatest, useOptionKey } from './internal.js';

/**
 * Every hook here follows the same rule, because pointer listeners are
 * expensive to rebuild and disastrous to rebuild mid-gesture:
 *
 * - callbacks are read through a ref at call time, so an inline handler does
 *   not detach and reattach the listeners on every render
 * - value options re-attach when their *values* change, not when the object
 *   holding them is rebuilt
 *
 * An option that is neither — a `contains` predicate you only sometimes pass,
 * a clock you only pass in tests — is read when the listeners are attached.
 */

const GESTURE_KEYS = ['zoomSpeed', 'panButtons', 'wheel', 'singleTouch', 'inertia'] as const;

/** Pan, zoom, pinch and inertia on a mounted element. Null until it mounts. */
export function useGestures(
  element: HTMLElement | null,
  camera: Camera,
  options: GestureOptions = {},
): GestureHandle | null {
  const latest = useLatest(options);
  const key = useOptionKey(options, GESTURE_KEYS);
  const [handle, setHandle] = useState<GestureHandle | null>(null);

  useEffect(() => {
    if (element === null) return;
    const attached = attachGestures(element, camera, {
      ...latest.current,
      onChange: () => latest.current.onChange?.(),
    });
    setHandle(attached);
    return () => {
      attached.detach();
      setHandle(null);
    };
  }, [element, camera, key, latest]);

  return handle;
}

const KEYBOARD_KEYS = ['fitPadding', 'panStep', 'zoomStep'] as const;

/**
 * The canvas keyboard shortcuts, bound to the window by default.
 *
 * Nothing is returned: the handle only carries `detach`, and the hook owns
 * that. Bindings already stand down while the user is typing in a field, so a
 * text editor over the canvas needs no extra handling.
 */
export function useKeyboard(camera: Camera, options: KeyboardOptions = {}): void {
  const latest = useLatest(options);
  const key = useOptionKey(options, KEYBOARD_KEYS);
  const target = options.target;

  useEffect(() => {
    const attached = attachKeyboard(camera, {
      ...latest.current,
      onChange: () => latest.current.onChange?.(),
      getContentBounds: () => latest.current.getContentBounds?.() ?? null,
      getSelectionBounds: () => latest.current.getSelectionBounds?.() ?? null,
    });
    return () => attached.detach();
  }, [camera, key, target, latest]);
}

const SELECT_KEYS = [
  'button',
  'tolerance',
  'marquee',
  'snapDistance',
  'dragThreshold',
  'historyLabel',
] as const;

export type SelectToolHookOptions<T extends SceneNode> = Omit<SelectToolOptions<T>, 'element'>;

/**
 * Click, shift-click, marquee and drag, with snapping and one undo step per
 * gesture. Null until the element mounts.
 *
 * The returned tool carries the marquee rectangle and the alignment guides for
 * the host to draw; neither is versioned, so wire `onChange` to the canvas's
 * `invalidate`.
 */
export function useSelectTool<T extends SceneNode>(
  element: HTMLElement | null,
  options: SelectToolHookOptions<T>,
): SelectTool | null {
  const latest = useLatest(options);
  const key = useOptionKey(options, SELECT_KEYS);
  const [tool, setTool] = useState<SelectTool | null>(null);
  const { scene, camera, selection, history } = options;

  useEffect(() => {
    if (element === null) return;
    const current = latest.current;
    const attached: SelectToolOptions<T> = {
      ...current,
      element,
      onChange: () => latest.current.onChange?.(),
    };
    // Installed only if one was passed: the tool treats an absent `contains`
    // as "the node's rectangle is the node", and a forwarder that always
    // exists would take that default away.
    if (current.contains) {
      attached.contains = (node, point) => latest.current.contains?.(node, point) ?? false;
    }
    if (current.filter) {
      attached.filter = (node) => latest.current.filter?.(node) ?? true;
    }

    const instance = attachSelectTool(attached);
    setTool(instance);
    return () => {
      instance.detach();
      setTool(null);
    };
  }, [element, scene, camera, selection, history, key, latest]);

  return tool;
}
