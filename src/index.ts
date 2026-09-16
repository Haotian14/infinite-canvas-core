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

export { attachGestures } from './input/gestures.js';
export type { GestureHandle, GestureOptions } from './input/gestures.js';

export * as rect from './math/rect.js';
export type { Matrix2D, Rect, Vec2 } from './types.js';
