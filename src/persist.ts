import { Camera } from './camera.js';
import { Scene } from './scene.js';
import type { SceneOptions, SceneNode } from './scene.js';

export interface SceneSnapshot<T extends SceneNode> {
  v: 1;
  /** Nodes back to front. Depth is the order itself, not a stored number. */
  nodes: T[];
}

export interface DocumentSnapshot<T extends SceneNode> {
  v: 1;
  scene: SceneSnapshot<T>;
  camera?: { scale: number; tx: number; ty: number };
}

/**
 * A scene as plain JSON.
 *
 * Nodes come out back to front and carry no depth field: order *is* the depth,
 * so the format has one representation of it rather than two that can disagree.
 * The spatial index is not serialised either — it is derived, and rebuilding it
 * on load is faster than parsing it.
 */
export function serializeScene<T extends SceneNode>(scene: Scene<T>): SceneSnapshot<T> {
  return { v: 1, nodes: scene.zOrdered() };
}

export function serializeDocument<T extends SceneNode>(
  scene: Scene<T>,
  camera?: Camera,
): DocumentSnapshot<T> {
  return {
    v: 1,
    scene: serializeScene(scene),
    ...(camera === undefined ? {} : { camera: camera.toJSON() }),
  };
}

/**
 * Rebuilds a scene from a snapshot.
 *
 * Validates rather than trusting: a file on disk or a payload off a wire is
 * not necessarily one this wrote, and a scene half-built from malformed input
 * is much harder to diagnose later than a throw here.
 */
export function deserializeScene<T extends SceneNode>(
  snapshot: SceneSnapshot<T>,
  options: SceneOptions = {},
): Scene<T> {
  return deserializeInto(new Scene<T>(options), snapshot);
}

/**
 * Loads a snapshot into an existing scene, replacing its contents.
 *
 * Usually what you want over `deserializeScene`. Returning a new instance
 * means every reference to the old one — a renderer, a tool, a history, some
 * other module that captured it — is silently stale, and the symptom of that
 * is an editor that looks loaded but is still driving the document you left
 * behind. Loading in place keeps the identity and the references.
 *
 * Validates rather than trusting: a file on disk or a payload off a wire is
 * not necessarily one this wrote, and a scene half-built from malformed input
 * is much harder to diagnose later than a throw here. Nothing is cleared until
 * the whole snapshot has passed, so a bad load leaves the scene untouched.
 */
export function deserializeInto<T extends SceneNode>(
  scene: Scene<T>,
  snapshot: SceneSnapshot<T>,
): Scene<T> {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new TypeError('deserializeScene: snapshot must be an object');
  }
  if (snapshot.v !== 1) {
    throw new TypeError(`deserializeScene: unsupported version ${String(snapshot.v)}`);
  }
  if (!Array.isArray(snapshot.nodes)) {
    throw new TypeError('deserializeScene: snapshot.nodes must be an array');
  }

  for (const [index, node] of snapshot.nodes.entries()) {
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string') {
      throw new TypeError(`deserializeScene: node ${index} has no string id`);
    }
    const rect = (node as { rect?: unknown }).rect as Record<string, unknown> | undefined;
    const numbers = [rect?.['x'], rect?.['y'], rect?.['w'], rect?.['h']];
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new TypeError(`deserializeScene: node ${node.id} has no finite rect`);
    }
  }

  scene.clear();
  // Added in file order, which is z order, so depth needs no separate pass.
  for (const node of snapshot.nodes) scene.add(node);
  return scene;
}

export function deserializeDocument<T extends SceneNode>(
  snapshot: DocumentSnapshot<T>,
  options: SceneOptions = {},
): { scene: Scene<T>; camera: Camera } {
  if (snapshot === null || typeof snapshot !== 'object' || snapshot.v !== 1) {
    throw new TypeError('deserializeDocument: expected a version 1 document');
  }
  const scene = deserializeScene(snapshot.scene, options);
  const camera = new Camera();
  if (snapshot.camera !== undefined) camera.setState(snapshot.camera);
  return { scene, camera };
}
