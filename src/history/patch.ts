import type { NodeId, Scene, SceneNode } from '../scene.js';
import type { Rect } from '../types.js';

/**
 * The smallest description of a change to a scene.
 *
 * Patches, not snapshots. A snapshot per undo step is unaffordable at the sizes
 * this engine is built for — a hundred thousand nodes copied on every nudge —
 * and a patch is also the shape a collaboration layer needs, so the same
 * representation carries both.
 */
export type Patch<T extends SceneNode = SceneNode> =
  | { op: 'add'; node: T; z?: number }
  | { op: 'remove'; id: NodeId }
  | { op: 'move'; id: NodeId; rect: Rect }
  | { op: 'order'; id: NodeId; z: number };

export function applyPatch<T extends SceneNode>(scene: Scene<T>, patch: Patch<T>): boolean {
  switch (patch.op) {
    case 'add':
      scene.add(patch.node);
      if (patch.z !== undefined) scene.setZ(patch.node.id, patch.z);
      return true;
    case 'remove':
      return scene.remove(patch.id);
    case 'move':
      return scene.setRect(patch.id, patch.rect);
    case 'order':
      return scene.setZ(patch.id, patch.z);
  }
}

export function applyPatches<T extends SceneNode>(
  scene: Scene<T>,
  patches: readonly Patch<T>[],
): void {
  for (const patch of patches) applyPatch(scene, patch);
}

/**
 * The patch that undoes another, computed against the scene **before** it is
 * applied. Returns null when the patch would not change anything, so a no-op
 * never lands on the undo stack pretending to be a step.
 */
export function invertPatch<T extends SceneNode>(
  scene: Scene<T>,
  patch: Patch<T>,
): Patch<T> | null {
  switch (patch.op) {
    case 'add': {
      const existing = scene.get(patch.node.id);
      // Adding over an existing id is a replacement, so undoing it restores
      // the node that was there rather than removing anything.
      return existing === undefined
        ? { op: 'remove', id: patch.node.id }
        : { op: 'add', node: existing, z: scene.zOf(existing.id) };
    }
    case 'remove': {
      const existing = scene.get(patch.id);
      return existing === undefined ? null : { op: 'add', node: existing, z: scene.zOf(patch.id) };
    }
    case 'move': {
      const existing = scene.get(patch.id);
      return existing === undefined ? null : { op: 'move', id: patch.id, rect: { ...existing.rect } };
    }
    case 'order': {
      const existing = scene.get(patch.id);
      return existing === undefined ? null : { op: 'order', id: patch.id, z: scene.zOf(patch.id) };
    }
  }
}
