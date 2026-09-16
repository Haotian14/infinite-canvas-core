import type { Camera } from '../camera.js';
import type { Scene, SceneNode } from '../scene.js';

export interface RenderStats {
  /** Nodes in the scene. */
  total: number;
  /** Nodes actually submitted to the backend. */
  drawn: number;
  /** Nodes rejected by viewport culling. */
  culled: number;
  /** Wall-clock time of the render call, in milliseconds. */
  durationMs: number;
}

/**
 * The seam between the engine and a drawing backend.
 *
 * Nothing in `core` imports a renderer, so the engine runs unchanged in a
 * Worker or in Node — which is what makes headless layout, server-side
 * thumbnails and fast unit tests possible.
 */
export interface Renderer<T extends SceneNode = SceneNode> {
  /** `cssWidth`/`cssHeight` are layout pixels; `dpr` is applied by the renderer. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(scene: Scene<T>, camera: Camera): RenderStats;
  destroy(): void;
}
