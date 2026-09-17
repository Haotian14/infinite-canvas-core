/**
 * React bindings.
 *
 * A separate entry point (`infinite-canvas-core/react`) with React as an
 * optional peer, so the engine itself stays dependency-free and nothing here
 * is reachable — or bundled — unless it is imported.
 *
 * These are hooks, not components. A component would have to decide the markup
 * and the styling of something whose whole point is that the host draws it;
 * hooks hand back a ref and a frame and leave the JSX alone.
 */
export { useConstant } from './internal.js';
export { useVersion, useCameraState, useSelectionIds, useHistoryState } from './use-version.js';
export type { CameraState, HistoryState } from './use-version.js';
export type { Versioned } from './frame.js';
export { useCanvas } from './use-canvas.js';
export type { CanvasHandle, CanvasOptions } from './use-canvas.js';
export { useGestures, useKeyboard, useSelectTool } from './use-input.js';
export type { SelectToolHookOptions } from './use-input.js';
