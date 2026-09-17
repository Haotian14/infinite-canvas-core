import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Camera } from '../camera.js';
import type { History } from '../history/history.js';
import type { NodeId, SceneNode } from '../scene.js';
import type { Selection } from '../select/selection.js';
import { watchVersion } from './frame.js';
import type { Versioned } from './frame.js';

const NEVER = (): void => {};

/**
 * Re-renders the component when `source`'s change counter moves.
 *
 * Works on anything the engine versions — `Camera`, `Scene`, `Selection`,
 * `History` — and accepts null so a component can call it before the thing it
 * watches exists.
 */
export function useVersion(source: Versioned | null | undefined): number {
  const read = useCallback(() => source?.version ?? 0, [source]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => (source ? watchVersion(read, onStoreChange) : NEVER),
    [source, read],
  );
  // The server snapshot is the same read: there is no subscription on a
  // server, but the first value is still the right one to render.
  return useSyncExternalStore(subscribe, read, read);
}

export interface CameraState {
  scale: number;
  tx: number;
  ty: number;
  width: number;
  height: number;
}

/** The camera's numbers, for a zoom readout or a minimap. */
export function useCameraState(camera: Camera): CameraState {
  const version = useVersion(camera);
  return useMemo(
    () => ({
      scale: camera.scale,
      tx: camera.tx,
      ty: camera.ty,
      width: camera.width,
      height: camera.height,
    }),
    // The version is the point: it is what makes this recompute.
    [camera, version],
  );
}

/**
 * The selected ids, as an array that keeps its identity until the selection
 * actually changes — so it is safe as a dependency or a memo input.
 */
export function useSelectionIds(selection: Selection): readonly NodeId[] {
  const version = useVersion(selection);
  return useMemo(() => selection.toArray(), [selection, version]);
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
  depth: number;
}

/** What an undo/redo control needs: whether it is live, and what it would do. */
export function useHistoryState<T extends SceneNode>(history: History<T>): HistoryState {
  const version = useVersion(history);
  return useMemo(
    () => ({
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
      depth: history.depth,
    }),
    [history, version],
  );
}
