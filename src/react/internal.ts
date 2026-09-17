import { useRef } from 'react';

/**
 * Builds the value once, on the first render, and keeps it forever.
 *
 * `useMemo` is documented as a cache that React may drop, so it cannot own a
 * camera or a scene; `useState(factory)` works but reads as state the
 * component never sets. This is the plain version of what every binding needs.
 *
 * The factory runs once, so anything it reads from props is read once. Change
 * an engine object through its own methods, not by passing new options.
 */
export function useConstant<T>(create: () => T): T {
  const box = useRef<{ value: T } | null>(null);
  box.current ??= { value: create() };
  return box.current.value;
}

/**
 * The latest props, readable from inside an effect that must not re-run when
 * they change.
 *
 * A handler written inline in a component body is a new function on every
 * render. Listing it as an effect dependency would tear the pointer listeners
 * down and rebuild them sixty times a second during a drag; ignoring it would
 * leave the listeners calling the first render's closure. Reading it through a
 * ref at call time is the escape from both.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function keyOf(value: unknown): string {
  if (typeof value === 'function') return 'fn';
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return 'opaque';
  }
}

/**
 * A dependency that changes when the *values* of the named options change,
 * rather than when the options object is rebuilt.
 *
 * The keys are named explicitly because the alternative — serialising the
 * whole object — would walk a Scene or a Camera, and those are passed in the
 * same bag as the tuning numbers.
 */
export function useOptionKey<T extends object>(options: T, keys: readonly (keyof T)[]): string {
  let key = '';
  for (const name of keys) key += `${String(name)}:${keyOf(options[name])};`;
  return key;
}
