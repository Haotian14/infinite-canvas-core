import { defineConfig } from 'vite';

// The landing page. It imports the engine from source rather than from dist,
// so the live demo on the page is always the code in this commit.
export default defineConfig({
  root: 'site',
  // GitHub Pages serves a project site from /<repo>/, not from the domain root.
  base: process.env.SITE_BASE ?? '/infinite-canvas-core/',
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
    target: 'es2022',
  },
});
