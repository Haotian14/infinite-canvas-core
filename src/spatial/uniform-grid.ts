import type { Rect } from '../types.js';

/**
 * Cell coordinates are packed into one float64 as `(cx + BIAS) * STRIDE + (cy + BIAS)`.
 *
 * This is exact rather than a hash, so there are no collisions to guard
 * against, as long as cell indices stay inside +/-BIAS. At the default cell
 * size that is a world roughly 500 million units across, which is far beyond
 * where float64 coordinates stay well-behaved anyway.
 */
const BIAS = 1 << 20;
const STRIDE = 1 << 21;
const MAX_CELL = BIAS - 1;

/**
 * How many cells one item may occupy before it is treated as oversized and
 * parked in a list that every query scans. Without this, one huge rectangle
 * would insert itself into millions of cells.
 */
const OVERSIZED_CELL_LIMIT = 64;

export interface UniformGridOptions {
  /** Cell edge length in world units. Default 256. */
  cellSize?: number;
}

/**
 * What a cell bucket holds.
 *
 * Buckets store the entry, not the item, so the query loop never has to look
 * anything up: bounds and the dedup stamp are one property access away. An
 * item occupying nine cells is nine references to the *same* entry.
 */
interface Entry<T> {
  item: T;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The id of the last query that visited this entry, for O(1) dedup. */
  stamp: number;
  oversized: boolean;
}

/**
 * A uniform grid index over axis-aligned rectangles.
 *
 * Chosen over an R-tree for the first cut because insert and remove are O(1)
 * with no rebalancing, which matters when a drag mutates bounds every frame.
 * The trade-off is sensitivity to cell size: content far denser or far sparser
 * than one item per cell degrades toward a linear scan. An R-tree can replace
 * it behind this same interface if real scenes turn out to cluster badly.
 */
export class UniformGrid<T> {
  readonly cellSize: number;

  #cells = new Map<number, Array<Entry<T>>>();
  #entries = new Map<T, Entry<T>>();
  #oversized: Array<Entry<T>> = [];
  #inverseCellSize: number;
  #stamp = 0;

  constructor(options: UniformGridOptions = {}) {
    const size = options.cellSize ?? 256;
    if (!(size > 0) || !Number.isFinite(size)) {
      throw new Error(`UniformGrid: cellSize must be a positive number, got ${size}`);
    }
    this.cellSize = size;
    this.#inverseCellSize = 1 / size;
  }

  get size(): number {
    return this.#entries.size;
  }

  insert(item: T, bounds: Rect): void {
    const existing = this.#entries.get(item);
    if (existing !== undefined) {
      this.update(item, bounds);
      return;
    }
    const entry: Entry<T> = {
      item,
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.w,
      maxY: bounds.y + bounds.h,
      stamp: -1,
      oversized: false,
    };
    this.#entries.set(item, entry);
    this.#link(entry);
  }

  remove(item: T): boolean {
    const entry = this.#entries.get(item);
    if (entry === undefined) return false;
    this.#unlink(entry);
    this.#entries.delete(item);
    return true;
  }

  /** Re-indexes an item after its bounds changed. Cheap when the cells are unchanged. */
  update(item: T, bounds: Rect): void {
    const entry = this.#entries.get(item);
    if (entry === undefined) {
      this.insert(item, bounds);
      return;
    }

    const minX = bounds.x;
    const minY = bounds.y;
    const maxX = bounds.x + bounds.w;
    const maxY = bounds.y + bounds.h;

    if (this.#sameCells(entry, minX, minY, maxX, maxY)) {
      entry.minX = minX;
      entry.minY = minY;
      entry.maxX = maxX;
      entry.maxY = maxY;
      return;
    }

    this.#unlink(entry);
    entry.minX = minX;
    entry.minY = minY;
    entry.maxX = maxX;
    entry.maxY = maxY;
    this.#link(entry);
  }

  clear(): void {
    this.#cells.clear();
    this.#entries.clear();
    this.#oversized = [];
  }

  /** Every indexed item whose bounds overlap `area`. Order is unspecified. */
  search(area: Rect): T[] {
    const out: T[] = [];
    const queryMinX = area.x;
    const queryMinY = area.y;
    const queryMaxX = area.x + area.w;
    const queryMaxY = area.y + area.h;

    // A fresh id per query makes dedup a single integer compare, with no set to
    // allocate and no per-candidate hash lookup.
    const stamp = ++this.#stamp;

    for (let i = 0; i < this.#oversized.length; i++) {
      const entry = this.#oversized[i] as Entry<T>;
      entry.stamp = stamp;
      if (
        entry.minX <= queryMaxX &&
        queryMinX <= entry.maxX &&
        entry.minY <= queryMaxY &&
        queryMinY <= entry.maxY
      ) {
        out.push(entry.item);
      }
    }

    const minCX = this.#cellIndex(queryMinX);
    const minCY = this.#cellIndex(queryMinY);
    const maxCX = this.#cellIndex(queryMaxX);
    const maxCY = this.#cellIndex(queryMaxY);

    for (let cx = minCX; cx <= maxCX; cx++) {
      const column = (cx + BIAS) * STRIDE + BIAS;
      for (let cy = minCY; cy <= maxCY; cy++) {
        const bucket = this.#cells.get(column + cy);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const entry = bucket[i] as Entry<T>;
          if (entry.stamp === stamp) continue;
          entry.stamp = stamp;
          // Inlined rather than calling `intersects`: this is the whole query.
          if (
            entry.minX <= queryMaxX &&
            queryMinX <= entry.maxX &&
            entry.minY <= queryMaxY &&
            queryMinY <= entry.maxY
          ) {
            out.push(entry.item);
          }
        }
      }
    }
    return out;
  }

  #link(entry: Entry<T>): void {
    const minCX = this.#cellIndex(entry.minX);
    const minCY = this.#cellIndex(entry.minY);
    const maxCX = this.#cellIndex(entry.maxX);
    const maxCY = this.#cellIndex(entry.maxY);

    if ((maxCX - minCX + 1) * (maxCY - minCY + 1) > OVERSIZED_CELL_LIMIT) {
      entry.oversized = true;
      this.#oversized.push(entry);
      return;
    }
    entry.oversized = false;
    for (let cx = minCX; cx <= maxCX; cx++) {
      const column = (cx + BIAS) * STRIDE + BIAS;
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = column + cy;
        const bucket = this.#cells.get(key);
        if (bucket === undefined) this.#cells.set(key, [entry]);
        else bucket.push(entry);
      }
    }
  }

  #unlink(entry: Entry<T>): void {
    if (entry.oversized) {
      const at = this.#oversized.indexOf(entry);
      if (at !== -1) swapRemove(this.#oversized, at);
      entry.oversized = false;
      return;
    }

    const minCX = this.#cellIndex(entry.minX);
    const minCY = this.#cellIndex(entry.minY);
    const maxCX = this.#cellIndex(entry.maxX);
    const maxCY = this.#cellIndex(entry.maxY);

    for (let cx = minCX; cx <= maxCX; cx++) {
      const column = (cx + BIAS) * STRIDE + BIAS;
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = column + cy;
        const bucket = this.#cells.get(key);
        if (bucket === undefined) continue;
        const at = bucket.indexOf(entry);
        if (at !== -1) swapRemove(bucket, at);
        if (bucket.length === 0) this.#cells.delete(key);
      }
    }
  }

  #sameCells(entry: Entry<T>, minX: number, minY: number, maxX: number, maxY: number): boolean {
    return (
      this.#cellIndex(entry.minX) === this.#cellIndex(minX) &&
      this.#cellIndex(entry.minY) === this.#cellIndex(minY) &&
      this.#cellIndex(entry.maxX) === this.#cellIndex(maxX) &&
      this.#cellIndex(entry.maxY) === this.#cellIndex(maxY)
    );
  }

  #cellIndex(coordinate: number): number {
    if (!Number.isFinite(coordinate)) return coordinate > 0 ? MAX_CELL : -MAX_CELL;
    const index = Math.floor(coordinate * this.#inverseCellSize);
    return index < -MAX_CELL ? -MAX_CELL : index > MAX_CELL ? MAX_CELL : index;
  }
}

/** Order inside a bucket carries no meaning, so swap-and-pop beats splice. */
function swapRemove<T>(list: T[], index: number): void {
  const last = list[list.length - 1] as T;
  list[index] = last;
  list.pop();
}
