import type { Camera } from '../camera.js';
import type { NodeId, Scene, SceneNode } from '../scene.js';
import type { Rect, Vec2 } from '../types.js';
import { rectFromPoints } from '../math/rect.js';
import { hitTest, hitTestRect } from './hit-test.js';
import type { History } from '../history/history.js';
import type { Patch } from '../history/patch.js';
import type { Selection } from './selection.js';
import { computeSnap } from './snap.js';
import type { SnapGuide } from './snap.js';

export interface SelectToolOptions<T extends SceneNode> {
  element: HTMLElement;
  scene: Scene<T>;
  camera: Camera;
  selection: Selection;
  /** Called whenever the selection, the marquee or a dragged node changes. */
  onChange?: () => void;
  /** Mouse button that selects and drags. Default 0. */
  button?: number;
  /** Hit tolerance in **screen** pixels; converted per event. Default 4. */
  tolerance?: number;
  /** Precise hit test, for content that is not rectangular. */
  contains?: (node: T, point: Vec2) => boolean;
  /** Nodes this rejects cannot be hit or marquee-selected. */
  filter?: (node: T) => boolean;
  /**
   * `'auto'` follows the convention most tools use: dragged rightward the
   * marquee takes only what it encloses, leftward it takes anything it touches.
   * Default `'auto'`.
   */
  marquee?: 'intersect' | 'contain' | 'auto';
  /** Snap distance in **screen** pixels. 0 turns snapping off. Default 6. */
  snapDistance?: number;
  /** How far the pointer must move before a press becomes a drag. Default 3. */
  dragThreshold?: number;
  /**
   * Makes drags undoable.
   *
   * One step per gesture, committed on release. A drag moves nodes on every
   * pointer event; recording each of those would fill the stack with frames of
   * a single movement, so the scene is mutated directly while the pointer is
   * down and the step goes in at the end.
   */
  history?: History<T>;
  /** Label for the recorded step. Default `'move'`. */
  historyLabel?: string;
}

export interface SelectTool {
  detach(): void;
  /** The marquee rectangle in world units while one is being dragged. */
  readonly marquee: Rect | null;
  /** Alignment guides for the current drag, for the host to draw. */
  readonly guides: readonly SnapGuide[];
  readonly isDragging: boolean;
}

type Phase = 'idle' | 'pressing' | 'marquee' | 'dragging';

/**
 * Pointer-driven select, drag and marquee.
 *
 * Everything here is assembled from the headless parts — `hitTest`,
 * `Selection`, `computeSnap` — and none of them needs this to be useful. It
 * exists because wiring them to pointer events has half a dozen decisions in
 * it that are easy to get subtly wrong, and they are the same decisions every
 * time.
 *
 * The tool draws nothing. It reports a marquee rectangle and a set of guides
 * and leaves rendering to the renderer, which is the only part that knows what
 * anything looks like.
 */
export function attachSelectTool<T extends SceneNode>(options: SelectToolOptions<T>): SelectTool {
  const { element, scene, camera, selection } = options;
  const notify = options.onChange ?? (() => {});
  const button = options.button ?? 0;
  const tolerancePx = options.tolerance ?? 4;
  const snapPx = options.snapDistance ?? 6;
  const dragThreshold = options.dragThreshold ?? 3;
  const marqueeMode = options.marquee ?? 'auto';

  let phase: Phase = 'idle';
  let pointerId: number | null = null;
  let anchor: Vec2 = { x: 0, y: 0 };
  let anchorWorld: Vec2 = { x: 0, y: 0 };
  let marquee: Rect | null = null;
  let guides: SnapGuide[] = [];
  let additive = false;
  let pressedNode: T | undefined;
  /** Whether the pressed node was already selected, which decides who resolves it. */
  let pressedWasSelected = false;
  /** Where each dragged node was when the drag began. */
  let origins = new Map<NodeId, Rect>();
  let selectionAtPress: NodeId[] = [];

  const localPoint = (event: PointerEvent): Vec2 => {
    const box = element.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const hitAt = (world: Vec2): T | undefined =>
    hitTest(scene, world, {
      tolerance: camera.screenToWorldDistance(tolerancePx),
      ...(options.contains === undefined ? {} : { contains: options.contains }),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
    });

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== button || phase !== 'idle') return;

    anchor = localPoint(event);
    anchorWorld = camera.screenToWorld(anchor);
    additive = event.shiftKey;
    pressedNode = hitAt(anchorWorld);
    selectionAtPress = selection.toArray();
    pointerId = event.pointerId;
    phase = 'pressing';

    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation; a drag that leaves the element stops
      // updating, which beats not dragging at all.
    }

    pressedWasSelected = pressedNode !== undefined && selection.has(pressedNode.id);

    if (pressedNode === undefined) {
      if (!additive) selection.clear();
    } else if (!pressedWasSelected) {
      // Pressing an unselected node selects it, so a drag starting here moves
      // what you pressed. Release must then leave it alone: adding on press and
      // toggling on release would cancel each other out under shift.
      if (additive) selection.add(pressedNode.id);
      else selection.set([pressedNode.id]);
    }
    // Pressing a node that is already selected changes nothing yet: collapsing
    // a multi-selection to one on press would make dragging several nodes
    // impossible. It is resolved on release instead, if no drag happened.

    event.preventDefault();
    notify();
  };

  const beginDrag = (): void => {
    origins = new Map();
    for (const id of selection.ids()) {
      const node = scene.get(id);
      if (node !== undefined) origins.set(id, { ...node.rect });
    }
    phase = origins.size > 0 ? 'dragging' : 'marquee';
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId || phase === 'idle') return;
    const point = localPoint(event);

    if (phase === 'pressing') {
      if (Math.hypot(point.x - anchor.x, point.y - anchor.y) < dragThreshold) return;
      if (pressedNode === undefined) phase = 'marquee';
      else beginDrag();
    }

    if (phase === 'marquee') {
      marquee = rectFromPoints(anchorWorld, camera.screenToWorld(point));
      const mode =
        marqueeMode === 'auto' ? (point.x >= anchor.x ? 'contain' : 'intersect') : marqueeMode;
      const inside = hitTestRect(scene, marquee, {
        mode,
        ...(options.filter === undefined ? {} : { filter: options.filter }),
      }).map((node) => node.id);
      selection.set(additive ? [...selectionAtPress, ...inside] : inside);
      notify();
      return;
    }

    // Dragging. The delta is measured from the anchor rather than accumulated
    // frame to frame, so a snap that takes on one frame and releases on the
    // next does not leave the shape permanently offset.
    const world = camera.screenToWorld(point);
    let dx = world.x - anchorWorld.x;
    let dy = world.y - anchorWorld.y;
    guides = [];

    // Alt is the universal "not this time" for snapping.
    if (snapPx > 0 && !event.altKey) {
      const moved = movedBounds(origins, dx, dy);
      if (moved !== null) {
        const snap = computeSnap(moved, {
          threshold: camera.screenToWorldDistance(snapPx),
          // Only what is on screen. Aligning to something a mile away is not a
          // feature, and it would cost a pass over the whole scene per frame.
          targets: neighbours(scene, camera.visibleWorldRect(), origins),
        });
        dx += snap.dx;
        dy += snap.dy;
        guides = snap.guides;
      }
    }

    for (const [id, origin] of origins) {
      scene.setRect(id, { ...origin, x: origin.x + dx, y: origin.y + dy });
    }
    notify();
  };

  const finish = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    try {
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    } catch {
      // Already released by the browser.
    }

    if (phase === 'dragging' && options.history !== undefined) {
      const forward: Patch<T>[] = [];
      const inverse: Patch<T>[] = [];
      for (const [id, origin] of origins) {
        const node = scene.get(id);
        if (node === undefined) continue;
        const { x, y, w, h } = node.rect;
        // A drag that ended where it started is not a step.
        if (x === origin.x && y === origin.y) continue;
        forward.push({ op: 'move', id, rect: { x, y, w, h } });
        inverse.push({ op: 'move', id, rect: origin });
      }
      if (forward.length > 0) {
        options.history.record(options.historyLabel ?? 'move', forward, inverse);
      }
    }

    // A press that never became a drag is a click. Only the deferred case is
    // resolved here; a node that was not selected was already handled on press.
    if (phase === 'pressing' && pressedNode !== undefined && pressedWasSelected) {
      if (additive) selection.remove(pressedNode.id);
      else selection.set([pressedNode.id]);
    }

    phase = 'idle';
    pointerId = null;
    pressedNode = undefined;
    pressedWasSelected = false;
    marquee = null;
    guides = [];
    origins = new Map();
    notify();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || phase === 'idle') return;
    // Put everything back where it was, including the selection.
    for (const [id, origin] of origins) scene.setRect(id, origin);
    selection.set(selectionAtPress);
    if (pointerId !== null) {
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        // Nothing to release.
      }
    }
    phase = 'idle';
    pointerId = null;
    pressedNode = undefined;
    marquee = null;
    guides = [];
    origins = new Map();
    notify();
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', finish);
  element.addEventListener('pointercancel', finish);
  window.addEventListener('keydown', onKeyDown);

  return {
    get marquee() {
      return marquee;
    },
    get guides() {
      return guides;
    },
    get isDragging() {
      return phase === 'dragging';
    },
    detach(): void {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}

function movedBounds(origins: Map<NodeId, Rect>, dx: number, dy: number): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of origins.values()) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (minX === Infinity) return null;
  return { x: minX + dx, y: minY + dy, w: maxX - minX, h: maxY - minY };
}

function* neighbours<T extends SceneNode>(
  scene: Scene<T>,
  view: Rect,
  moving: Map<NodeId, Rect>,
): Generator<Rect> {
  for (const node of scene.query(view)) {
    if (!moving.has(node.id)) yield node.rect;
  }
}
