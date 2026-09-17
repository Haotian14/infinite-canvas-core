import { describe, expect, it } from 'vitest';
import { Camera } from '../src/camera.js';
import { Scene } from '../src/scene.js';
import {
  deserializeDocument,
  deserializeDocumentInto,
  deserializeScene,
  serializeDocument,
  serializeScene,
} from '../src/persist.js';
import type { SceneNode } from '../src/scene.js';

interface Shape extends SceneNode {
  fill: string;
}

function build(): Scene<Shape> {
  const scene = new Scene<Shape>({ cellSize: 32 });
  scene.addAll([
    { id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 }, fill: '#111' },
    { id: 'b', rect: { x: 40, y: 20, w: 30, h: 15 }, fill: '#222' },
    { id: 'c', rect: { x: -80, y: -80, w: 5, h: 5 }, fill: '#333' },
  ]);
  return scene;
}

describe('serialize / deserialize', () => {
  it('round-trips a scene through JSON', () => {
    const before = build();
    const after = deserializeScene<Shape>(
      JSON.parse(JSON.stringify(serializeScene(before))),
      { cellSize: 32 },
    );

    expect(after.size).toBe(before.size);
    expect(after.bounds()).toEqual(before.bounds());
    expect(after.get('b')).toEqual(before.get('b'));
  });

  it('keeps depth, because order is the depth', () => {
    const before = build();
    before.bringToFront('a');
    before.sendToBack('b');
    const order = before.zOrdered().map((n) => n.id);

    const after = deserializeScene<Shape>(JSON.parse(JSON.stringify(serializeScene(before))));
    expect(after.zOrdered().map((n) => n.id)).toEqual(order);
  });

  it('rebuilds a working index rather than storing one', () => {
    const after = deserializeScene<Shape>(serializeScene(build()), { cellSize: 8 });
    expect(after.query({ x: 40, y: 20, w: 1, h: 1 }).map((n) => n.id)).toEqual(['b']);

    // And it still updates.
    after.setRect('b', { x: 500, y: 500, w: 30, h: 15 });
    expect(after.query({ x: 40, y: 20, w: 1, h: 1 })).toHaveLength(0);
    expect(after.query({ x: 500, y: 500, w: 1, h: 1 }).map((n) => n.id)).toEqual(['b']);
  });

  it('carries the camera in a document', () => {
    const scene = build();
    const camera = new Camera().setViewport(800, 600).zoomTo(2.5).panBy(31, -17);

    const doc = deserializeDocument<Shape>(
      JSON.parse(JSON.stringify(serializeDocument(scene, camera))),
    );
    expect(doc.camera.toJSON()).toEqual(camera.toJSON());
    expect(doc.scene.size).toBe(3);
  });

  it('omits the camera when none is given', () => {
    expect(serializeDocument(build()).camera).toBeUndefined();
    expect(deserializeDocument(serializeDocument(build())).camera.toJSON()).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
  });

  it('throws on input it did not write, rather than half-building a scene', () => {
    expect(() => deserializeScene(null as never)).toThrow(/must be an object/);
    expect(() => deserializeScene({ v: 2, nodes: [] } as never)).toThrow(/unsupported version/);
    expect(() => deserializeScene({ v: 1, nodes: 'nope' } as never)).toThrow(/must be an array/);
    expect(() => deserializeScene({ v: 1, nodes: [{ rect: { x: 0, y: 0, w: 1, h: 1 } }] } as never)).toThrow(
      /no string id/,
    );
    expect(() => deserializeScene({ v: 1, nodes: [{ id: 'a' }] } as never)).toThrow(/no finite rect/);
    expect(() =>
      deserializeScene({ v: 1, nodes: [{ id: 'a', rect: { x: 0, y: 0, w: NaN, h: 1 } }] } as never),
    ).toThrow(/no finite rect/);
    expect(() => deserializeDocument({ v: 1 } as never)).toThrow();
  });
});

describe('deserializeInto', () => {
  it('replaces the contents of an existing scene, keeping its identity', async () => {
    const { deserializeInto } = await import('../src/persist.js');
    const live = build();
    const snapshot = JSON.parse(JSON.stringify(serializeScene(live)));

    live.setRect('a', { x: 900, y: 900, w: 10, h: 10 });
    live.remove('c');
    expect(live.size).toBe(2);

    const same = deserializeInto(live, snapshot);
    expect(same).toBe(live);
    expect(live.size).toBe(3);
    expect(live.get('a')?.rect.x).toBe(0);
    expect(live.query({ x: 900, y: 900, w: 1, h: 1 })).toHaveLength(0);
    expect(live.query({ x: -80, y: -80, w: 1, h: 1 }).map((n) => n.id)).toEqual(['c']);
  });

  it('leaves the scene untouched when the snapshot is bad', async () => {
    const { deserializeInto } = await import('../src/persist.js');
    const live = build();
    expect(() =>
      deserializeInto(live, { v: 1, nodes: [{ id: 'ok', rect: { x: 0, y: 0, w: 1, h: 1 } }, { id: 'bad' }] } as never),
    ).toThrow(/no finite rect/);
    // Validation runs before anything is cleared.
    expect(live.size).toBe(3);
    expect(live.get('a')).toBeDefined();
  });
});

describe('deserializeDocumentInto', () => {
  it('loads into the scene and camera the caller already holds', () => {
    const source = new Scene();
    source.addAll([
      { id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 'b', rect: { x: 50, y: 20, w: 30, h: 30 } },
    ]);
    const sourceCamera = new Camera().setViewport(800, 600).zoomTo(2).panBy(40, 12);
    const snapshot = serializeDocument(source, sourceCamera);

    const scene = new Scene({ cellSize: 64 });
    scene.add({ id: 'stale', rect: { x: 0, y: 0, w: 1, h: 1 } });
    const camera = new Camera().setViewport(800, 600);

    deserializeDocumentInto({ scene, camera }, snapshot);

    // Same objects, new contents. This is the whole point: a hook or a
    // renderer holding either of these is still holding the live one.
    expect(scene.size).toBe(2);
    expect(scene.get('stale')).toBeUndefined();
    expect(camera.toJSON()).toEqual(sourceCamera.toJSON());
    // The index came back with the nodes.
    const area = scene.bounds();
    expect(scene.query(area)).toHaveLength(scene.queryLinear(area).length);
  });

  it('leaves the camera alone when the snapshot has none', () => {
    const scene = new Scene();
    const camera = new Camera().setViewport(800, 600).zoomTo(3);
    const before = camera.toJSON();

    deserializeDocumentInto({ scene, camera }, serializeDocument(new Scene()));
    expect(camera.toJSON()).toEqual(before);
  });

  it('refuses anything that is not a version 1 document', () => {
    const scene = new Scene();
    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(() =>
      deserializeDocumentInto({ scene }, { v: 2, scene: { v: 1, nodes: [] } } as never),
    ).toThrow(TypeError);
    // And left the scene as it was.
    expect(scene.size).toBe(1);
  });
});
