#!/usr/bin/env node
/**
 * Rewrites the performance block in README.md from bench/results/latest.json,
 * so the headline numbers cannot drift away from the run that produced them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(ROOT, 'README.md');
const START = '<!-- PERF:START -->';
const END = '<!-- PERF:END -->';

const report = JSON.parse(await readFile(path.join(ROOT, 'bench', 'results', 'latest.json'), 'utf8'));
const { environment: env, results, queryResults } = report;

const headline = results.filter((r) => r.batchByFill && r.lodMinScreenSize !== 0);
const rows = headline
  .map(
    (r) =>
      `| \`${r.scenario}\` | ${r.nodeCount.toLocaleString()} | ${r.drawnMean.toLocaleString()} | ` +
      `**${r.renderMs.p50.toFixed(1)}** | ${r.renderMs.p95.toFixed(1)} | ±${(r.reps?.spreadPct ?? 0).toFixed(0)}% |`,
  )
  .join('\n');

const query = queryResults[queryResults.length - 1];
const overview = headline.find((r) => r.scenario === 'overview');
const baseline = results.find(
  (r) => r.scenario === 'overview' && !r.batchByFill && r.lodMinScreenSize === 0,
);

const block = `${START}
## Performance

100,000 nodes, 1600x900, measured inside \`Canvas2DRenderer.render\` — cull query
plus draw calls. Median of ${report.config.reps} runs of ${report.config.frames} frames each.

| scenario | nodes | drawn/frame | render p50 (ms) | p95 | run spread |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

- Viewport query over ${query.nodeCount.toLocaleString()} nodes: **${query.indexedUs.toFixed(0)} µs** indexed vs ${query.linearUs.toFixed(0)} µs for a full
  scan (**${query.speedup.toFixed(0)}x**), returning ~${query.hitsMean.toLocaleString()} hits.
- The worst case — everything on screen at once — went from ${baseline.renderMs.p50.toFixed(0)} ms to
  ${overview.renderMs.p50.toFixed(1)} ms (**${(baseline.renderMs.p50 / overview.renderMs.p50).toFixed(1)}x**) via draw-call batching and sub-pixel LOD.

Measured on ${env.cpu} (${env.cores} cores), headless Chromium ${env.chromium.split('.')[0]}
with **software rasterisation** (\`${env.gpu.includes('SwiftShader') ? 'SwiftShader' : env.gpu}\`), which makes these a lower bound —
a real GPU does better. Run spread is the gap between fastest and slowest
repetition; anything smaller than it is noise.

Full tables, methodology and flame charts: [\`bench/results/RESULTS.md\`](bench/results/RESULTS.md).
Reproduce with \`pnpm bench\`.
${END}`;

const readme = await readFile(README, 'utf8');
const before = readme.slice(0, readme.indexOf(START));
const after = readme.slice(readme.indexOf(END) + END.length);
await writeFile(README, before + block + after);
console.log('README.md performance block updated');
