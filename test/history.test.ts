import { describe, expect, it } from 'vitest';
import { Scene } from '../src/scene.js';
import { History } from '../src/history/history.js';
import { applyPatch, invertPatch } from '../src/history/patch.js';
import type { SceneNode } from '../src/scene.js';

const at = (id: string, x: number, y: number): SceneNode => ({ id, rect: { x, y, w: 10, h: 10 } });

function fresh(): { scene: Scene; history: History<SceneNode> } {
  const scene = new Scene({ cellSize: 32 });
  scene.addAll([at('a', 0, 0), at('b', 100, 0)]);
  return { scene, history: new History(scene) };
}

describe('patches', () => {
  it('inverts a move against the state before it', () => {
    const { scene } = fresh();
    const patch = { op: 'move', id: 'a', rect: { x: 50, y: 50, w: 10, h: 10 } } as const;

    const inverse = invertPatch(scene, patch);
    expect(inverse).toEqual({ op: 'move', id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } });

    applyPatch(scene, patch);
    expect(scene.get('a')?.rect.x).toBe(50);
    applyPatch(scene, inverse!);
    expect(scene.get('a')?.rect.x).toBe(0);
  });

  it('inverts a remove into an add that restores depth', () => {
    const { scene } = fresh();
    scene.bringToFront('a');
    const z = scene.zOf('a');

    const inverse = invertPatch(scene, { op: 'remove', id: 'a' });
    applyPatch(scene, { op: 'remove', id: 'a' });
    expect(scene.get('a')).toBeUndefined();

    applyPatch(scene, inverse!);
    expect(scene.zOf('a')).toBe(z);
    expect(scene.zOrdered().map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('inverts an add over an existing id into a restore, not a remove', () => {
    const { scene } = fresh();
    const replacement = at('a', 900, 900);
    const inverse = invertPatch(scene, { op: 'add', node: replacement });
    expect(inverse).toMatchObject({ op: 'add' });

    applyPatch(scene, { op: 'add', node: replacement });
    applyPatch(scene, inverse!);
    expect(scene.get('a')?.rect.x).toBe(0);
  });

  it('returns null for a patch that would do nothing', () => {
    const { scene } = fresh();
    expect(invertPatch(scene, { op: 'remove', id: 'ghost' })).toBeNull();
    expect(invertPatch(scene, { op: 'move', id: 'ghost', rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
  });
});

describe('History', () => {
  it('runs, undoes and redoes', () => {
    const { scene, history } = fresh();
    history.run('move a', [{ op: 'move', id: 'a', rect: { x: 40, y: 0, w: 10, h: 10 } }]);
    expect(scene.get('a')?.rect.x).toBe(40);
    expect(history.canUndo).toBe(true);

    expect(history.undo()).toBe(true);
    expect(scene.get('a')?.rect.x).toBe(0);
    expect(history.canRedo).toBe(true);

    expect(history.redo()).toBe(true);
    expect(scene.get('a')?.rect.x).toBe(40);
  });

  it('keeps the spatial index correct across undo', () => {
    const { scene, history } = fresh();
    history.run('move a', [{ op: 'move', id: 'a', rect: { x: 500, y: 500, w: 10, h: 10 } }]);
    expect(scene.query({ x: 500, y: 500, w: 1, h: 1 }).map((n) => n.id)).toEqual(['a']);

    history.undo();
    expect(scene.query({ x: 500, y: 500, w: 1, h: 1 })).toHaveLength(0);
    expect(scene.query({ x: 0, y: 0, w: 1, h: 1 }).map((n) => n.id)).toEqual(['a']);
  });

  it('undoes a multi-patch step in the order that puts it back', () => {
    const { scene, history } = fresh();
    history.run('shuffle', [
      { op: 'remove', id: 'a' },
      { op: 'add', node: at('c', 5, 5) },
      { op: 'move', id: 'b', rect: { x: 7, y: 7, w: 10, h: 10 } },
    ]);
    expect(scene.size).toBe(2);

    history.undo();
    expect(scene.size).toBe(2);
    expect(scene.get('a')?.rect.x).toBe(0);
    expect(scene.get('b')?.rect.x).toBe(100);
    expect(scene.get('c')).toBeUndefined();
  });

  it('records a change the caller already made', () => {
    const { scene, history } = fresh();
    // What a drag does: mutate live, commit one step on release.
    scene.setRect('a', { x: 33, y: 0, w: 10, h: 10 });
    history.record(
      'drag',
      [{ op: 'move', id: 'a', rect: { x: 33, y: 0, w: 10, h: 10 } }],
      [{ op: 'move', id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }],
    );

    expect(history.depth).toBe(1);
    history.undo();
    expect(scene.get('a')?.rect.x).toBe(0);
    history.redo();
    expect(scene.get('a')?.rect.x).toBe(33);
  });

  it('groups a transaction into one step, and nests', () => {
    const { scene, history } = fresh();
    history.transact('tidy', () => {
      history.run('one', [{ op: 'move', id: 'a', rect: { x: 1, y: 0, w: 10, h: 10 } }]);
      history.transact('inner', () => {
        history.run('two', [{ op: 'move', id: 'b', rect: { x: 2, y: 0, w: 10, h: 10 } }]);
      });
    });

    expect(history.depth).toBe(1);
    expect(history.undoLabel).toBe('tidy');
    history.undo();
    expect(scene.get('a')?.rect.x).toBe(0);
    expect(scene.get('b')?.rect.x).toBe(100);
  });

  it('drops the redo branch once something new happens', () => {
    const { history } = fresh();
    history.run('one', [{ op: 'move', id: 'a', rect: { x: 1, y: 0, w: 10, h: 10 } }]);
    history.undo();
    expect(history.canRedo).toBe(true);

    history.run('two', [{ op: 'move', id: 'b', rect: { x: 2, y: 0, w: 10, h: 10 } }]);
    expect(history.canRedo).toBe(false);
  });

  it('records nothing for a step that changes nothing', () => {
    const { history } = fresh();
    history.run('ghost', [{ op: 'remove', id: 'nope' }]);
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBe(false);
  });

  it('forgets the oldest steps past the limit', () => {
    const scene = new Scene();
    scene.add(at('a', 0, 0));
    const history = new History(scene, { limit: 3 });
    for (let i = 1; i <= 5; i++) {
      history.run(`m${i}`, [{ op: 'move', id: 'a', rect: { x: i, y: 0, w: 10, h: 10 } }]);
    }
    expect(history.depth).toBe(3);

    while (history.undo());
    // Only the last three are recoverable; it cannot go back past m2's start.
    expect(scene.get('a')?.rect.x).toBe(2);
  });

  it('reports what undo and redo would do', () => {
    const { history } = fresh();
    expect(history.undoLabel).toBeUndefined();
    history.run('nudge', [{ op: 'move', id: 'a', rect: { x: 9, y: 0, w: 10, h: 10 } }]);
    expect(history.undoLabel).toBe('nudge');
    history.undo();
    expect(history.redoLabel).toBe('nudge');
  });

  it('notifies on change', () => {
    const scene = new Scene();
    scene.add(at('a', 0, 0));
    let calls = 0;
    const history = new History(scene, { onChange: () => calls++ });
    history.run('m', [{ op: 'move', id: 'a', rect: { x: 1, y: 0, w: 10, h: 10 } }]);
    history.undo();
    history.redo();
    history.clear();
    expect(calls).toBe(4);
  });
});

describe('an undo record and the objects it came from', () => {
  it('does not alias a node the host still holds', () => {
    const scene = new Scene({ cellSize: 32 });
    const node = at('a', 10, 20);
    scene.add(node);
    const history = new History(scene);

    history.run('cut', [{ op: 'remove', id: 'a' }]);
    // The host kept the object it deleted and reused it - for a paste
    // elsewhere, or out of a pool. The undo record must already have its own.
    node.rect = { x: 999, y: 999, w: 1, h: 1 };

    history.undo();
    expect(scene.get('a')?.rect).toEqual({ x: 10, y: 20, w: 10, h: 10 });
  });

  it('undoes a property change, which is an add over an existing id', () => {
    interface Labelled extends SceneNode {
      label: string;
    }
    const scene = new Scene<Labelled>({ cellSize: 32 });
    scene.add({ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 }, label: 'before' });
    scene.bringToFront('a');
    scene.add({ id: 'b', rect: { x: 40, y: 0, w: 10, h: 10 }, label: 'other' });
    const depth = scene.zOf('a');
    const history = new History(scene);

    const edited = { ...scene.get('a')!, label: 'after' };
    history.run('edit', [{ op: 'add', node: edited }]);
    expect(scene.get('a')?.label).toBe('after');
    // A replacement keeps the node where it was in the stack.
    expect(scene.zOf('a')).toBe(depth);

    history.undo();
    expect(scene.get('a')?.label).toBe('before');
    expect(scene.zOf('a')).toBe(depth);

    history.redo();
    expect(scene.get('a')?.label).toBe('after');
  });
});
