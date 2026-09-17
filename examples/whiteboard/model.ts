import type { NodeId, Rect, SceneNode } from '../../src/index.js';

export type Kind = 'note' | 'rect' | 'ellipse';

/**
 * What this whiteboard puts on the canvas.
 *
 * `SceneNode` asks for an id and a rectangle and nothing else: the engine
 * culls, indexes and hit-tests on the rectangle and has no opinion about what
 * is inside it. Everything below `rect` is this app's business.
 */
export interface Item extends SceneNode {
  kind: Kind;
  fill: string;
  text: string;
}

export const PALETTE = ['#ffd972', '#9ee6c7', '#a8c8ff', '#ffb1c8', '#d4b8ff', '#ffd0a6'];

export const DEFAULT_SIZE: Record<Kind, { w: number; h: number }> = {
  note: { w: 180, h: 140 },
  rect: { w: 220, h: 130 },
  ellipse: { w: 170, h: 170 },
};

let counter = 0;

export function nextId(): NodeId {
  counter += 1;
  return `n${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Keeps generated ids clear of a loaded document's. */
export function reserveIds(ids: Iterable<NodeId>): void {
  for (const id of ids) {
    const n = Number.parseInt(id.slice(1), 10);
    if (Number.isFinite(n) && n > counter) counter = n;
  }
}

export function makeItem(kind: Kind, rect: Rect, seed: number): Item {
  return {
    id: nextId(),
    rect,
    kind,
    fill: PALETTE[seed % PALETTE.length] ?? PALETTE[0]!,
    text: kind === 'note' ? '' : '',
  };
}

const SAMPLE = [
  ['note', 'Camera, scene and history live outside React.', 0],
  ['note', 'Hooks poll their version counters once a frame.', 1],
  ['note', 'Drag me — one undo step per gesture.', 2],
  ['rect', '', 3],
  ['ellipse', '', 4],
  ['note', 'Double-click to edit. Undo covers that too.', 5],
] as const;

/** A board with something on it, so the demo does not open empty. */
export function starterBoard(): Item[] {
  const columns = 3;
  return SAMPLE.map(([kind, text, seed], i) => {
    const size = DEFAULT_SIZE[kind];
    const item = makeItem(kind, {
      x: -320 + (i % columns) * 260,
      y: -180 + Math.floor(i / columns) * 220,
      w: size.w,
      h: size.h,
    }, seed);
    return { ...item, text };
  });
}
