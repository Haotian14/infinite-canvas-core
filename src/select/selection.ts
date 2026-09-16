import type { NodeId, Scene, SceneNode } from '../scene.js';
import type { Rect } from '../types.js';
import { emptyRect, union } from '../math/rect.js';

/**
 * A set of selected ids.
 *
 * Ids rather than nodes, so a selection survives a node being replaced, and so
 * it can be serialised, sent over a wire or restored from an undo entry without
 * dragging the scene along with it. It carries a version for the same reason
 * `Scene` and `Camera` do: a host that wants to know whether to redraw should
 * not have to diff a set.
 */
export class Selection {
  private _ids = new Set<NodeId>();
  private _version = 0;

  get size(): number {
    return this._ids.size;
  }

  get version(): number {
    return this._version;
  }

  has(id: NodeId): boolean {
    return this._ids.has(id);
  }

  ids(): IterableIterator<NodeId> {
    return this._ids.values();
  }

  toArray(): NodeId[] {
    return [...this._ids];
  }

  add(...ids: NodeId[]): this {
    let changed = false;
    for (const id of ids) {
      if (this._ids.has(id)) continue;
      this._ids.add(id);
      changed = true;
    }
    return changed ? this._touch() : this;
  }

  remove(...ids: NodeId[]): this {
    let changed = false;
    for (const id of ids) changed = this._ids.delete(id) || changed;
    return changed ? this._touch() : this;
  }

  toggle(id: NodeId): this {
    if (!this._ids.delete(id)) this._ids.add(id);
    return this._touch();
  }

  /** Replaces the whole selection. No-op, and no version bump, if it matches. */
  set(ids: Iterable<NodeId>): this {
    const next = new Set(ids);
    if (next.size === this._ids.size && [...next].every((id) => this._ids.has(id))) return this;
    this._ids = next;
    return this._touch();
  }

  clear(): this {
    if (this._ids.size === 0) return this;
    this._ids.clear();
    return this._touch();
  }

  /**
   * The union of the selected nodes' bounds, for zoom-to-selection and for
   * anything that draws a bounding box. Ids no longer in the scene are skipped.
   */
  boundsIn<T extends SceneNode>(scene: Scene<T>): Rect {
    let acc = emptyRect();
    for (const id of this._ids) {
      const node = scene.get(id);
      if (node !== undefined) acc = union(acc, node.rect);
    }
    return acc;
  }

  /** Drops ids whose nodes have left the scene. Returns how many went. */
  prune<T extends SceneNode>(scene: Scene<T>): number {
    let dropped = 0;
    for (const id of [...this._ids]) {
      if (scene.get(id) === undefined && this._ids.delete(id)) dropped++;
    }
    if (dropped > 0) this._touch();
    return dropped;
  }

  private _touch(): this {
    this._version++;
    return this;
  }
}
