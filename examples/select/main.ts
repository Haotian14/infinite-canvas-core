import {
  Camera,
  Canvas2DRenderer,
  Scene,
  Selection,
  attachGestures,
  attachKeyboard,
  attachSelectTool,
} from '../../src/index.js';
import type { ShapeNode } from '../../src/index.js';
import { mulberry32 } from '../shared/scene.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const hint = document.getElementById('hint') as HTMLDivElement;

const camera = new Camera();
const renderer = new Canvas2DRenderer(canvas);
const scene = new Scene<ShapeNode>();
const selection = new Selection();

const palette = ['#6ea8fe', '#7ee7c7', '#f7a5c0', '#ffd36e', '#b39ddb'];
const random = mulberry32(5);
for (let i = 0; i < 160; i++) {
  const w = 60 + Math.round(random() * 90);
  scene.add({
    id: `n${i}`,
    rect: {
      x: Math.round(((i % 16) * 150 + random() * 60) / 10) * 10,
      y: Math.round((Math.floor(i / 16) * 150 + random() * 60) / 10) * 10,
      w,
      h: 50 + Math.round(random() * 70),
    },
    fill: palette[i % palette.length] as string,
  });
}

function resize(): void {
  camera.setViewport(window.innerWidth, window.innerHeight);
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  draw();
}

// Middle-drag and space+drag pan, so the left button is free for selection.
attachGestures(canvas, camera, { onChange: () => draw() });
attachKeyboard(camera, {
  getContentBounds: () => scene.bounds(),
  getSelectionBounds: () => (selection.size > 0 ? selection.boundsIn(scene) : null),
  onChange: () => draw(),
});

const tool = attachSelectTool({
  element: canvas,
  scene,
  camera,
  selection,
  onChange: () => draw(),
});

/**
 * The tool decides what is selected and where the marquee is; it draws nothing,
 * because it does not know what anything looks like. This is the other half.
 */
function draw(): void {
  renderer.render(scene, camera);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.strokeStyle = '#8fb0ff';
  ctx.lineWidth = 1.5;
  for (const id of selection.ids()) {
    const node = scene.get(id);
    if (node === undefined) continue;
    const topLeft = camera.worldToScreen(node.rect);
    ctx.strokeRect(
      Math.round(topLeft.x) - 1.5,
      Math.round(topLeft.y) - 1.5,
      node.rect.w * camera.scale + 3,
      node.rect.h * camera.scale + 3,
    );
  }

  // Alignment guides, in screen space so they stay one pixel at any zoom.
  // Not a colour any node uses, or a guide reads as another shape's edge.
  ctx.strokeStyle = '#ff3d71';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const guide of tool.guides) {
    const a = camera.worldToScreen(
      guide.axis === 'x' ? { x: guide.at, y: guide.from } : { x: guide.from, y: guide.at },
    );
    const b = camera.worldToScreen(
      guide.axis === 'x' ? { x: guide.at, y: guide.to } : { x: guide.to, y: guide.at },
    );
    ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
  }
  ctx.stroke();

  if (tool.marquee !== null) {
    const topLeft = camera.worldToScreen(tool.marquee);
    const w = tool.marquee.w * camera.scale;
    const h = tool.marquee.h * camera.scale;
    ctx.fillStyle = 'rgba(143, 176, 255, 0.12)';
    ctx.fillRect(topLeft.x, topLeft.y, w, h);
    ctx.strokeStyle = '#8fb0ff';
    ctx.strokeRect(Math.round(topLeft.x) + 0.5, Math.round(topLeft.y) + 0.5, w, h);
  }

  hint.innerHTML = `
    <div>selected <b>${selection.size}</b> of ${scene.size}</div>
    <div>click / shift-click · drag to move · drag empty space to marquee</div>
    <div>alt bypasses snapping · esc cancels · shift+1 fit · shift+2 fit selection</div>`;
}

// Exposed so the example can be driven from a test harness.
declare global {
  interface Window {
    __demo: { scene: typeof scene; camera: typeof camera; selection: typeof selection; tool: typeof tool };
  }
}
window.__demo = { scene, camera, selection, tool };

resize();
camera.fitToRect(scene.bounds(), 64);
window.addEventListener('resize', resize);
draw();
