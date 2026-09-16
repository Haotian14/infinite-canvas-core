import type { Scene, SceneNode } from '../scene.js';
import { applyPatches, invertPatch } from './patch.js';
import type { Patch } from './patch.js';

export interface HistoryStep<T extends SceneNode> {
  label: string;
  forward: Patch<T>[];
  inverse: Patch<T>[];
}

export interface HistoryOptions {
  /** How many steps to keep. Older ones fall off the bottom. Default 200. */
  limit?: number;
  /** Called after any change to the stacks or the scene. */
  onChange?: () => void;
}

/**
 * Undo and redo over a scene.
 *
 * Each step holds the patches that made the change and the patches that undo
 * it, so neither direction has to reconstruct anything. Inverses are computed
 * against the scene as it was before the change, which is why `run` takes the
 * patches rather than being handed a finished result.
 *
 * Two ways in, because interactions come in two shapes:
 *
 * - `run` applies patches and records them, for changes that happen at once —
 *   a paste, a delete, a bring-to-front.
 * - `record` takes a change the caller has already made and the patches that
 *   would undo it, for interactions that must be live. A drag moves nodes on
 *   every pointer event; recording each of those would fill the stack with
 *   frames of one gesture, so the tool mutates the scene directly and commits
 *   one step on release.
 */
export class History<T extends SceneNode> {
  private _undo: HistoryStep<T>[] = [];
  private _redo: HistoryStep<T>[] = [];
  private _version = 0;
  private _depth = 0;
  private _open: HistoryStep<T> | null = null;

  readonly limit: number;
  private readonly _notify: () => void;

  constructor(
    private readonly scene: Scene<T>,
    options: HistoryOptions = {},
  ) {
    this.limit = options.limit ?? 200;
    this._notify = options.onChange ?? ((): void => {});
  }

  /** Bumped whenever the stacks or the scene change through this history. */
  get version(): number {
    return this._version;
  }

  get canUndo(): boolean {
    return this._undo.length > 0;
  }

  get canRedo(): boolean {
    return this._redo.length > 0;
  }

  /** The label of the step undo would apply, for a menu item that names it. */
  get undoLabel(): string | undefined {
    return this._undo[this._undo.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this._redo[this._redo.length - 1]?.label;
  }

  get depth(): number {
    return this._undo.length;
  }

  /** Applies patches and records them as one step. */
  run(label: string, patches: readonly Patch<T>[]): void {
    const forward: Patch<T>[] = [];
    const inverse: Patch<T>[] = [];

    for (const patch of patches) {
      const undo = invertPatch(this.scene, patch);
      if (undo === null) continue;
      // Inverses are collected in reverse, so undo replays them in the order
      // that puts the scene back: last change first.
      inverse.unshift(undo);
      forward.push(patch);
      applyPatches(this.scene, [patch]);
    }

    if (forward.length === 0) return;
    this._push({ label, forward, inverse });
  }

  /**
   * Records a change the caller has already applied.
   *
   * `inverse` must describe the state before it. Nothing is applied here.
   */
  record(label: string, forward: readonly Patch<T>[], inverse: readonly Patch<T>[]): void {
    if (forward.length === 0) return;
    this._push({ label, forward: [...forward], inverse: [...inverse] });
  }

  /**
   * Groups everything `body` records into one step.
   *
   * Nests: only the outermost transaction closes a step, so a routine that
   * batches internally still merges into its caller's step.
   */
  transact(label: string, body: () => void): void {
    this._depth++;
    if (this._open === null) this._open = { label, forward: [], inverse: [] };
    try {
      body();
    } finally {
      this._depth--;
      if (this._depth === 0) {
        const open = this._open;
        this._open = null;
        if (open !== null && open.forward.length > 0) this._push(open);
      }
    }
  }

  undo(): boolean {
    const step = this._undo.pop();
    if (step === undefined) return false;
    applyPatches(this.scene, step.inverse);
    this._redo.push(step);
    this._version++;
    this._notify();
    return true;
  }

  redo(): boolean {
    const step = this._redo.pop();
    if (step === undefined) return false;
    applyPatches(this.scene, step.forward);
    this._undo.push(step);
    this._version++;
    this._notify();
    return true;
  }

  clear(): void {
    if (this._undo.length === 0 && this._redo.length === 0) return;
    this._undo = [];
    this._redo = [];
    this._version++;
    this._notify();
  }

  private _push(step: HistoryStep<T>): void {
    if (this._depth > 0 && this._open !== null) {
      // Inside a transaction: merge, keeping the inverse in undo order.
      this._open.forward.push(...step.forward);
      this._open.inverse.unshift(...step.inverse);
      return;
    }

    this._undo.push(step);
    // A new change makes the redo branch unreachable, which is what everyone
    // expects and what keeps the stack a line rather than a tree.
    this._redo = [];
    if (this._undo.length > this.limit) this._undo.splice(0, this._undo.length - this.limit);
    this._version++;
    this._notify();
  }
}
