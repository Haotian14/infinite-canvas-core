/**
 * One animation frame, shared by every subscriber.
 *
 * The engine reports change by incrementing a counter, not by emitting events,
 * and these bindings deliberately keep it that way. A drag moves a hundred
 * nodes per pointer event; if each mutation pushed into React, a gesture would
 * cost hundreds of renders and the frame budget would go to reconciliation
 * rather than to drawing. Polling the counters once per frame collapses all of
 * that into at most one render per subscriber per frame, which is the most a
 * screen can show anyway.
 *
 * The loop runs only while something is watching and stops when the last
 * watcher leaves, so an unmounted canvas costs nothing.
 */

/** Anything that reports change by incrementing a counter. */
export interface Versioned {
  readonly version: number;
}

interface Watcher {
  read: () => number;
  last: number;
  notify: () => void;
}

const watchers = new Set<Watcher>();
let handle = 0;

/** Overridable so tests can step frames without a real display. */
let request: (callback: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (callback) => requestAnimationFrame(() => callback())
    : () => 0;
let cancel: (id: number) => void =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : () => {};

function tick(): void {
  handle = 0;
  if (watchers.size === 0) return;

  // Collect first, notify after. A notify can mount or unmount a component,
  // which adds to or removes from the set we would otherwise be iterating.
  const due: Watcher[] = [];
  for (const watcher of watchers) {
    const value = watcher.read();
    if (value !== watcher.last) {
      watcher.last = value;
      due.push(watcher);
    }
  }

  schedule();
  for (const watcher of due) watcher.notify();
}

function schedule(): void {
  if (handle !== 0 || watchers.size === 0) return;
  handle = request(tick);
}

/**
 * Calls `notify` on the first frame on which `read` returns a different
 * number. Returns the unsubscribe.
 */
export function watchVersion(read: () => number, notify: () => void): () => void {
  const watcher: Watcher = { read, last: read(), notify };
  watchers.add(watcher);
  schedule();

  return () => {
    watchers.delete(watcher);
    if (watchers.size === 0 && handle !== 0) {
      cancel(handle);
      handle = 0;
    }
  };
}

/**
 * Replaces the frame scheduler, for tests. Returns the previous pair so a test
 * can put it back. Not part of the package's public exports.
 */
export function setFrameScheduler(
  nextRequest: (callback: () => void) => number,
  nextCancel: (id: number) => void,
): [typeof request, typeof cancel] {
  const previous: [typeof request, typeof cancel] = [request, cancel];
  request = nextRequest;
  cancel = nextCancel;
  if (handle !== 0) {
    previous[1](handle);
    handle = 0;
  }
  schedule();
  return previous;
}
