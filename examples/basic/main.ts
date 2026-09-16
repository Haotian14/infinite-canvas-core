// The whole library in one screen: a camera, a scene, a renderer, gestures.
import { Camera, Canvas2DRenderer, Scene, attachGestures } from '../../src/index.js';
import type { ShapeNode } from '../../src/index.js';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const camera = new Camera();
const renderer = new Canvas2DRenderer(canvas);
const scene = new Scene<ShapeNode>();

const palette = ['#6ea8fe', '#7ee7c7', '#f7a5c0', '#ffd36e'];
for (let i = 0; i < 500; i++) {
  scene.add({
    id: `n${i}`,
    rect: {
      x: (i % 25) * 160 + Math.random() * 40,
      y: Math.floor(i / 25) * 160 + Math.random() * 40,
      w: 60 + Math.random() * 60,
      h: 40 + Math.random() * 40,
    },
    fill: palette[i % palette.length] as string,
  });
}

function resize(): void {
  camera.setViewport(window.innerWidth, window.innerHeight);
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}

resize();
camera.fitToRect(scene.bounds(), 48);
window.addEventListener('resize', resize);

// The camera does not own a render loop, so redraws stay the host's decision.
attachGestures(canvas, camera);

let lastVersion = -1;
function frame(): void {
  // Only redraw when something actually moved.
  const version = camera.version + scene.version;
  if (version !== lastVersion) {
    renderer.render(scene, camera);
    lastVersion = version;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
