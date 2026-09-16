import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose.
 *
 * That config sets `root: 'site'` so the landing page builds, and Vitest picks
 * up vite.config.ts when there is no vitest.config.ts — which silently moved
 * the test root into site/, where it found no tests and reported success by
 * finding nothing. Keeping the two configs apart makes the test root explicit.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
});
