export { Camera, clamp } from './camera.js';
export type { CameraOptions } from './camera.js';

export { Scene } from './scene.js';
export type { NodeId, SceneNode, SceneOptions } from './scene.js';

export { UniformGrid } from './spatial/uniform-grid.js';
export type { UniformGridOptions } from './spatial/uniform-grid.js';

export { Canvas2DRenderer, niceStep } from './renderer/canvas2d.js';
export type {
  Canvas2DRendererOptions,
  GridOptions,
  ShapeNode,
} from './renderer/canvas2d.js';
export type { Renderer, RenderStats } from './renderer/types.js';

// Exported for anyone writing their own renderer: the sub-pixel pixel buffer
// is the awkward part of making one fast, and there is no reason to make each
// of them rediscover it.
export { LodBuffer } from './renderer/lod-buffer.js';

export { attachGestures } from './input/gestures.js';
export { attachKeyboard } from './input/keyboard.js';
export type { KeyboardHandle, KeyboardOptions } from './input/keyboard.js';
export type { GestureHandle, GestureOptions, InertiaOptions } from './input/gestures.js';

export { hitTest, hitTestAll, hitTestRect, ellipseContains } from './select/hit-test.js';
export type { HitTestOptions, RectTestOptions } from './select/hit-test.js';
export { Selection } from './select/selection.js';
export { computeSnap } from './select/snap.js';
export type { SnapGuide, SnapOptions, SnapResult } from './select/snap.js';
export { attachSelectTool } from './select/tool.js';
export type { SelectTool, SelectToolOptions } from './select/tool.js';

export { History } from './history/history.js';
export type { HistoryOptions, HistoryStep } from './history/history.js';
export { applyPatch, applyPatches, invertPatch } from './history/patch.js';
export type { Patch } from './history/patch.js';

export {
  serializeScene,
  serializeDocument,
  deserializeScene,
  deserializeInto,
  deserializeDocument,
  deserializeDocumentInto,
} from './persist.js';
export type { DocumentSnapshot, SceneSnapshot } from './persist.js';

export * as rect from './math/rect.js';
export type { Matrix2D, Rect, Vec2 } from './types.js';
