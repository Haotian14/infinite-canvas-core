import type { Rect } from './types.js';
import { emptyRect, intersects, union } from './math/rect.js';
import { UniformGrid } from './spatial/uniform-grid.js';

export type NodeId = string;

/** The minimum a renderer and the culler need to know about anything on the canvas. */
export interface SceneNode {
  readonly id: NodeId;
  rect: Rect;
}

export interface SceneOptions {
  /** Spatial index cell size in world units. Default 256. */
  cellSize?: number;
}

/**
 * A flat store of nodes keyed by id, indexed for viewport queries.
 *
 * Flat on purpose: a real parent/child scene graph makes every bounds query
 * walk a tree and every mutation invalidate an ancestor chain. Grouping, when
 * it arrives, can be a `parentId` field plus a resolved-transform pass — that
 * keeps the store itself O(1) to mutate.
 */
export class Scene<T extends SceneNode = SceneNode> {
  private _nodes = new Map<NodeId, T>();
  private _index: UniformGrid<T>;
  private _bounds: Rect | null = null;
  private _version = 0;

  constructor(options: SceneOptions = {}) {
    this._index = new UniformGrid<T>(
      options.cellSize === undefined ? {} : { cellSize: options.cellSize },
    );
  }

  get size(): number {
    return this._nodes.size;
  }

  /** Bumped on every mutation, for renderers and caches to compare against. */
  get version(): number {
    return this._version;
  }

  add(node: T): this {
    const existing = this._nodes.get(node.id);
    if (existing !== undefined && existing !== node) this._index.remove(existing);
    this._nodes.set(node.id, node);
    this._index.insert(node, node.rect);
    return this._invalidate();
  }

  addAll(nodes: Iterable<T>): this {
    for (const node of nodes) this.add(node);
    return this;
  }

  remove(id: NodeId): boolean {
    const node = this._nodes.get(id);
    if (node === undefined) return false;
    this._index.remove(node);
    this._nodes.delete(id);
    this._invalidate();
    return true;
  }

  get(id: NodeId): T | undefined {
    return this._nodes.get(id);
  }

  clear(): this {
    this._nodes.clear();
    this._index.clear();
    return this._invalidate();
  }

  all(): IterableIterator<T> {
    return this._nodes.values();
  }

  /**
   * Moves or resizes a node and re-indexes it.
   *
   * Mutating `node.rect` directly leaves the index stale, which shows up as
   * items vanishing when they scroll into view. Go through here instead.
   */
  setRect(id: NodeId, next: Rect): boolean {
    const node = this._nodes.get(id);
    if (node === undefined) return false;
    node.rect = next;
    this._index.update(node, next);
    this._invalidate();
    return true;
  }

  /** Every node whose bounds overlap `area`. Order is unspecified. */
  query(area: Rect): T[] {
    return this._index.search(area);
  }

  /**
   * The same result as {@link query} by brute force.
   *
   * Kept as the benchmark's control and as the oracle the index is
   * property-tested against — not for production use.
   */
  queryLinear(area: Rect): T[] {
    const out: T[] = [];
    for (const node of this._nodes.values()) {
      if (intersects(node.rect, area)) out.push(node);
    }
    return out;
  }

  /** Union of every node's bounds. Empty when the scene is. */
  bounds(): Rect {
    if (this._bounds === null) {
      let acc = emptyRect();
      for (const node of this._nodes.values()) acc = union(acc, node.rect);
      this._bounds = acc;
    }
    return this._bounds;
  }

  private _invalidate(): this {
    this._bounds = null;
    this._version++;
    return this;
  }
}
