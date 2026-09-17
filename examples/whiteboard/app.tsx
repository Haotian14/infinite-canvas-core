import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  Camera,
  History,
  Scene,
  Selection,
  ellipseContains,
  rect as rectMath,
  hitTest,
  serializeDocument,
  deserializeDocumentInto,
} from '../../src/index.js';
import type { NodeId, Patch, Rect, RenderStats, SelectTool, Vec2 } from '../../src/index.js';
import {
  useCameraState,
  useCanvas,
  useConstant,
  useGestures,
  useHistoryState,
  useKeyboard,
  useSelectTool,
  useSelectionIds,
} from '../../src/react/index.js';
import { DEFAULT_SIZE, makeItem, reserveIds, starterBoard } from './model.js';
import type { Item, Kind } from './model.js';
import { WhiteboardRenderer } from './renderer.js';

type Tool = 'select' | Kind;

const STORAGE_KEY = 'infinite-canvas-core:whiteboard';

export function App(): JSX.Element {
  // The document lives outside React. These are the same objects a vanilla
  // host would hold; the hooks below only watch them.
  const camera = useConstant(() => new Camera());
  const scene = useConstant(() => new Scene<Item>().addAll(starterBoard()));
  const selection = useConstant(() => new Selection());
  const history = useConstant(() => new History(scene));

  const [tool, setTool] = useState<Tool>('select');
  const [editing, setEditing] = useState<NodeId | null>(null);

  const framed = useRef(false);
  const statsRef = useRef<RenderStats | null>(null);

  const { ref, element, renderer, invalidate } = useCanvas<Item, WhiteboardRenderer>({
    scene,
    camera,
    renderer: (canvas) => new WhiteboardRenderer(canvas),
    // The selection is not part of the scene, but it is drawn, so the frame
    // has to know when it moves.
    watch: [selection],
    onRender: (stats) => {
      statsRef.current = stats;
    },
    // The first time the canvas knows how big it is. A camera cannot frame
    // anything before that: `fitToRect` needs a viewport to fit into, and on
    // the first render there is not one yet.
    onResize: (width) => {
      if (framed.current || scene.size === 0) return;
      framed.current = true;
      const bounds = scene.bounds();
      camera.fitToRect(bounds, Math.min(80, width * 0.08));
      // Fitting a wide board into a phone is arithmetically correct and
      // useless: everything lands at a third of its size and the text stops
      // being drawn at all. Below a floor, show part of the board instead.
      if (camera.scale < 0.75) {
        camera.zoomTo(0.75);
        camera.centerOn(rectMath.center(bounds));
      }
    },
  });

  // Per-frame numbers, sampled four times a second. Putting them in state on
  // every frame would re-render the whole app sixty times a second to update a
  // line of text that nobody can read that fast.
  const [stats, setStats] = useState<RenderStats | null>(null);
  useEffect(() => {
    const id = setInterval(() => setStats(statsRef.current), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (renderer) renderer.overlay.selected = selection;
  }, [renderer, selection]);

  useGestures(element, camera, {
    onChange: invalidate,
    // One finger belongs to the tools on a board; two fingers pan.
    singleTouch: 'ignore',
  });

  useKeyboard(camera, {
    onChange: invalidate,
    getContentBounds: () => (scene.size > 0 ? scene.bounds() : null),
    getSelectionBounds: () => (selection.size > 0 ? selection.boundsIn(scene) : null),
  });

  const selectToolRef = useRef<SelectTool | null>(null);
  const selectTool = useSelectTool<Item>(tool === 'select' ? element : null, {
    scene,
    camera,
    selection,
    history,
    historyLabel: 'move',
    contains: (node, point) =>
      node.kind === 'ellipse'
        ? ellipseContains(node, point)
        : rectMath.containsPoint(node.rect, point),
    onChange: () => {
      if (renderer) {
        renderer.overlay.marquee = selectToolRef.current?.marquee ?? null;
        renderer.overlay.guides = selectToolRef.current?.guides ?? [];
      }
      invalidate();
    },
  });
  selectToolRef.current = selectTool;

  // Passing null for the element detaches the tool, so switching away from
  // select needs no separate enable flag - and leaves no stale marquee.
  useEffect(() => {
    if (tool !== 'select' && renderer) {
      renderer.overlay.marquee = null;
      renderer.overlay.guides = [];
      invalidate();
    }
  }, [tool, renderer, invalidate]);

  useEffect(() => {
    if (renderer) {
      renderer.overlay.editing = editing;
      invalidate();
    }
  }, [renderer, editing, invalidate]);

  const worldAt = useCallback(
    (event: { clientX: number; clientY: number }): Vec2 => {
      const box = element?.getBoundingClientRect();
      return camera.screenToWorld({
        x: event.clientX - (box?.left ?? 0),
        y: event.clientY - (box?.top ?? 0),
      });
    },
    [camera, element],
  );

  // --- creating ------------------------------------------------------------
  // An app-specific tool, written with the same pieces the library's own tool
  // uses. Nothing here needed access to anything private.
  const draftRef = useRef<{ pointer: number; origin: Vec2 } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (tool === 'select' || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    draftRef.current = { pointer: event.pointerId, origin: worldAt(event) };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const draft = draftRef.current;
    if (!draft || draft.pointer !== event.pointerId || !renderer) return;
    renderer.overlay.draft = rectMath.rectFromPoints(draft.origin, worldAt(event));
    invalidate();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const draft = draftRef.current;
    if (!draft || draft.pointer !== event.pointerId) return;
    draftRef.current = null;
    if (renderer) renderer.overlay.draft = null;
    if (tool === 'select') return;

    const dragged = rectMath.rectFromPoints(draft.origin, worldAt(event));
    const size = DEFAULT_SIZE[tool];
    // A click rather than a drag still makes something, at a default size.
    const box: Rect =
      dragged.w < 12 || dragged.h < 12
        ? { x: draft.origin.x - size.w / 2, y: draft.origin.y - size.h / 2, ...size }
        : dragged;

    const item = makeItem(tool, box, scene.size);
    history.run(`add ${tool}`, [{ op: 'add', node: item }]);
    selection.set([item.id]);
    setTool('select');
    if (item.kind === 'note') setEditing(item.id);
    invalidate();
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>): void => {
    const hit = hitTest(scene, worldAt(event), {
      tolerance: camera.screenToWorldDistance(4),
      contains: (node, point) =>
        node.kind === 'ellipse'
          ? ellipseContains(node, point)
          : rectMath.containsPoint(node.rect, point),
    });
    if (hit) setEditing(hit.id);
  };

  // --- commands ------------------------------------------------------------
  const remove = useCallback(() => {
    const ids = selection.toArray();
    if (ids.length === 0) return;
    const patches: Patch<Item>[] = ids.map((id) => ({ op: 'remove', id }));
    history.run(`delete ${ids.length}`, patches);
    selection.clear();
  }, [history, selection]);

  const save = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeDocument(scene, camera)));
  }, [scene, camera]);

  const load = useCallback(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    // Into the scene and camera this component already holds. A loader that
    // returned new ones would leave every hook above driving the old document.
    deserializeDocumentInto({ scene, camera }, JSON.parse(raw));
    reserveIds([...scene.all()].map((node) => node.id));
    selection.prune(scene);
    history.clear();
    invalidate();
  }, [scene, camera, selection, history, invalidate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.code === 'KeyZ') {
        event.preventDefault();
        if (event.shiftKey) history.redo();
        else history.undo();
        selection.prune(scene);
      } else if (event.code === 'Delete' || event.code === 'Backspace') {
        event.preventDefault();
        remove();
      } else if (mod && event.code === 'KeyS') {
        event.preventDefault();
        save();
      } else if (mod && event.code === 'KeyO') {
        event.preventDefault();
        load();
      } else if (event.code === 'KeyV') setTool('select');
      else if (event.code === 'KeyN') setTool('note');
      else if (event.code === 'KeyR') setTool('rect');
      else if (event.code === 'KeyE') setTool('ellipse');
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, [history, selection, scene, remove, save, load]);

  // A handle for the verification script, not part of the demo.
  useEffect(() => {
    Object.assign(window, { __wb: { scene, camera, selection, history } });
  }, [scene, camera, selection, history]);

  const view = useCameraState(camera);
  const past = useHistoryState(history);
  const selected = useSelectionIds(selection);
  const editingNode = editing === null ? undefined : scene.get(editing);

  return (
    <>
      <div className="board">
        <canvas
          ref={ref}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
        />
        {editingNode && (
          <TextEditor
            key={editingNode.id}
            box={camera.worldToScreenRect(editingNode.rect)}
            scale={view.scale}
            initial={editingNode.text}
            onCommit={(text) => {
              setEditing(null);
              if (text === editingNode.text) return;
              // A property change is a replacement: adding over an existing id
              // keeps its depth, and undo restores the node that was there.
              history.run('edit text', [{ op: 'add', node: { ...editingNode, text } }]);
              invalidate();
            }}
          />
        )}
      </div>

      <header className="bar">
        <strong>whiteboard</strong>
        <span className="sep" />
        {(['select', 'note', 'rect', 'ellipse'] as const).map((name) => (
          <button
            key={name}
            className={tool === name ? 'on' : ''}
            onClick={() => setTool(name)}
            title={`${name} (${name[0]!.toUpperCase()})`}
          >
            {name}
          </button>
        ))}
        <span className="sep" />
        {/* The step name is a tooltip rather than the label: putting it in the
            button would resize it on every action and shuffle the whole bar. */}
        <button
          disabled={!past.canUndo}
          title={past.undoLabel ? `undo ${past.undoLabel}` : 'nothing to undo'}
          onClick={() => { history.undo(); selection.prune(scene); }}
        >
          undo
        </button>
        <button
          disabled={!past.canRedo}
          title={past.redoLabel ? `redo ${past.redoLabel}` : 'nothing to redo'}
          onClick={() => { history.redo(); selection.prune(scene); }}
        >
          redo
        </button>
        <button disabled={selected.length === 0} onClick={remove}>
          delete
        </button>
        <span className="sep" />
        <button onClick={save}>save</button>
        <button onClick={load}>load</button>
        <span className="sep" />
        <button onClick={() => { camera.zoomTo(1); invalidate(); }}>100%</button>
        <button
          onClick={() => {
            if (scene.size > 0) camera.fitToRect(scene.bounds(), 64);
            invalidate();
          }}
        >
          fit
        </button>
      </header>

      <footer className="readout">
        <span>{Math.round(view.scale * 100)}%</span>
        <span>{scene.size} items</span>
        <span>{selected.length} selected</span>
        <span className="wide">{stats ? `${stats.drawn} drawn / ${stats.culled} culled` : '—'}</span>
        <span>{stats ? `${stats.durationMs.toFixed(2)} ms` : '—'}</span>
        <span className="wide">{past.depth} undo steps</span>
      </footer>
    </>
  );
}

interface TextEditorProps {
  box: Rect;
  scale: number;
  initial: string;
  onCommit: (text: string) => void;
}

/**
 * A textarea laid over the node it edits.
 *
 * `camera.worldToScreenRect` is what makes this possible: the canvas is not
 * a DOM tree, so anything textual has to be positioned by hand, and the camera
 * is the only thing that knows where a world rectangle currently is.
 */
function TextEditor({ box, scale, initial, onCommit }: TextEditorProps): JSX.Element {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <textarea
      ref={ref}
      className="editor"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCommit(initial);
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommit(text);
        }
      }}
      style={{
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.w}px`,
        height: `${box.h}px`,
        padding: `${12 * scale}px`,
        fontSize: `${14 * scale}px`,
        lineHeight: 1.35,
      }}
    />
  );
}
