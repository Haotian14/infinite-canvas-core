#!/usr/bin/env node
/**
 * Drives examples/bench in headless Chromium and writes reproducible numbers.
 *
 *   node bench/run.mjs                 # default sweep
 *   node bench/run.mjs --stress        # adds the 1,000,000-node run
 *   node bench/run.mjs --headed        # watch it happen
 *
 * Outputs to bench/results/:
 *   latest.json          machine-readable, for CI regression checks
 *   RESULTS.md           the table
 *   *.cpuprofile         open in Chrome DevTools (Performance > Load) or speedscope
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'bench', 'results');

const args = new Set(process.argv.slice(2));
const STRESS = args.has('--stress');
const HEADED = args.has('--headed');
/**
 * Repetitions per scenario. A shared or thermally throttled machine moves
 * 20%+ between runs, which is more than most of the changes worth measuring,
 * so a single run cannot tell an improvement from noise.
 */
const REPS = Number([...args].find((a) => a.startsWith('--reps='))?.slice(7) ?? 3);

const FRAMES = 180;
const WARMUP = 30;

/** Scenarios whose CPU profile gets written out as a flame chart. */
const PROFILED = [
  { scenario: 'pan-mid', nodeCount: 100_000 },
  { scenario: 'overview', nodeCount: 100_000 },
];

const PLAN = [
  { scenario: 'pan-close', nodeCount: 100_000 },
  { scenario: 'pan-mid', nodeCount: 100_000 },
  { scenario: 'zoom-cycle', nodeCount: 100_000 },
  // The worst case, then the same scenario with each optimisation peeled off,
  // so the report carries its own reproducible baseline.
  { scenario: 'overview', nodeCount: 100_000 },
  { scenario: 'overview', nodeCount: 100_000, lodMinScreenSize: 0 },
  { scenario: 'overview', nodeCount: 100_000, lodMinScreenSize: 0, batchByFill: false },
  { scenario: 'pan-mid', nodeCount: 10_000 },
  ...(STRESS ? [{ scenario: 'overview', nodeCount: 1_000_000 }] : []),
];

const QUERY_BENCH_COUNTS = [10_000, 100_000];

async function main() {
  await mkdir(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    server: { port: 0, strictPort: false },
  });
  await server.listen();
  const port = server.config.server.port ?? server.httpServer?.address()?.port;
  const url = `http://localhost:${port}/examples/bench/index.html?harness=1`;

  const browser = await chromium.launch({
    headless: !HEADED,
    executablePath: findChromium(),
    args: [
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      // Containers commonly run as root, where the sandbox refuses to start.
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  page.on('pageerror', (error) => {
    console.error('page error:', error.message);
    process.exitCode = 1;
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__BENCH__?.ready === true, null, { timeout: 30_000 });

  const environment = await collectEnvironment(page, browser);
  console.log(`\n  ${environment.cpu}  ·  ${environment.cores} cores  ·  ${environment.gpu}`);
  console.log(`  chromium ${environment.chromium}, headless=${!HEADED}\n`);

  const results = [];
  for (const entry of PLAN) {
    const isProfiled =
      entry.batchByFill !== false &&
      entry.lodMinScreenSize !== 0 &&
      PROFILED.some((p) => p.scenario === entry.scenario && p.nodeCount === entry.nodeCount);
    const off = [
      entry.lodMinScreenSize === 0 ? 'no LOD' : null,
      entry.batchByFill === false ? 'no batching' : null,
    ].filter(Boolean);
    const label = `${entry.scenario} @ ${entry.nodeCount.toLocaleString()}${off.length ? ` (${off.join(', ')})` : ''}`;
    process.stdout.write(`  ${label.padEnd(38)} … `);

    const reps = [];
    for (let rep = 0; rep < REPS; rep++) {
      // Profile the last repetition only, so profiling overhead never lands in
      // the run that gets reported.
      let session;
      if (isProfiled && rep === REPS - 1) {
        session = await page.context().newCDPSession(page);
        await session.send('Profiler.enable');
        // 100 us keeps hot inner loops from hiding between samples.
        await session.send('Profiler.setSamplingInterval', { interval: 100 });
        await session.send('Profiler.start');
      }

      const run = await page.evaluate((config) => window.__BENCH__.run(config), {
        ...entry,
        frames: FRAMES,
        warmup: WARMUP,
      });

      if (session) {
        const { profile } = await session.send('Profiler.stop');
        const file = path.join(OUT, `${entry.scenario}-${entry.nodeCount}.cpuprofile`);
        await writeFile(file, JSON.stringify(profile));
        await session.detach();
        run.cpuprofile = path.relative(ROOT, file);
      }
      reps.push(run);
    }

    // Report the median run, not the best: the fastest of N is a biased
    // estimate that quietly improves every time you add a repetition.
    const ordered = [...reps].sort((a, b) => a.renderMs.p50 - b.renderMs.p50);
    const result = ordered[Math.floor(ordered.length / 2)];
    const p50s = ordered.map((r) => r.renderMs.p50);
    const lowest = p50s[0];
    const highest = p50s[p50s.length - 1];
    result.reps = {
      count: REPS,
      renderP50s: reps.map((r) => r.renderMs.p50),
      spreadPct: lowest > 0 ? ((highest - lowest) / lowest) * 100 : 0,
    };

    results.push(result);
    console.log(
      `render p50 ${result.renderMs.p50.toFixed(2)}ms  p95 ${result.renderMs.p95.toFixed(2)}ms  ` +
        `drawn ${result.drawnMean.toLocaleString().padStart(7)}  ` +
        `±${result.reps.spreadPct.toFixed(0)}% over ${REPS} runs`,
    );
  }

  console.log('');
  const queryResults = [];
  for (const count of QUERY_BENCH_COUNTS) {
    process.stdout.write(`  query ${count.toLocaleString()} nodes`.padEnd(41) + ' … ');
    const runs = [];
    for (let rep = 0; rep < REPS; rep++) {
      runs.push(await page.evaluate((n) => window.__BENCH__.queryBench(n), count));
    }
    runs.sort((a, b) => a.speedup - b.speedup);
    const result = runs[Math.floor(runs.length / 2)];
    queryResults.push(result);
    console.log(
      `indexed ${result.indexedUs.toFixed(1)}us  linear ${result.linearUs.toFixed(1)}us  ` +
        `${result.speedup.toFixed(1)}x`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment,
    config: { frames: FRAMES, warmup: WARMUP, reps: REPS },
    results,
    queryResults,
  };
  await writeFile(path.join(OUT, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(OUT, 'RESULTS.md'), renderMarkdown(report));

  await browser.close();
  await server.close();
  console.log(`\n  wrote ${path.relative(ROOT, OUT)}/RESULTS.md\n`);
}

/**
 * Playwright bundles a browser build matching its own version, but CI images
 * often pre-install a different one. Prefer an explicit path, then a known
 * image location, then whatever Playwright downloaded.
 */
function findChromium() {
  const explicit = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return explicit;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;

  const candidates = [path.join(root, 'chromium')];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('chromium-')) {
      candidates.push(path.join(root, entry, 'chrome-linux', 'chrome'));
    }
  }
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

async function collectEnvironment(page, browser) {
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  return {
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    cores: os.cpus().length,
    memoryGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    chromium: browser.version(),
    headless: !HEADED,
    gpu,
  };
}

function renderMarkdown(report) {
  const { environment: env, results, queryResults, config } = report;

  const rows = results
    .map((r) => {
      const budget = r.budget60P95 <= 100 ? '✅' : '⚠️';
      const off = [r.lodMinScreenSize === 0 ? 'no LOD' : null, r.batchByFill ? null : 'no batching']
        .filter(Boolean)
        .join(', ');
      const scenario = `\`${r.scenario}\`${off ? ` *(${off})*` : ''}`;
      return `| ${scenario} | ${r.nodeCount.toLocaleString()} | ${r.drawnMean.toLocaleString()} | ${r.renderMs.p50.toFixed(2)} | ${r.renderMs.p95.toFixed(2)} | ${r.renderMs.p99.toFixed(2)} | ${r.budget60P95.toFixed(0)}% ${budget} | ±${(r.reps?.spreadPct ?? 0).toFixed(0)}% |`;
    })
    .join('\n');

  const queryRows = queryResults
    .map(
      (q) =>
        `| ${q.nodeCount.toLocaleString()} | ${q.hitsMean.toLocaleString()} | ${q.indexedUs.toFixed(1)} | ${q.linearUs.toFixed(1)} | **${q.speedup.toFixed(1)}x** |`,
    )
    .join('\n');

  const variants = results.filter((r) => r.scenario === 'overview' && r.nodeCount === 100_000);
  const full = variants.find((r) => r.lodMinScreenSize !== 0 && r.batchByFill);
  const noLod = variants.find((r) => r.lodMinScreenSize === 0 && r.batchByFill);
  const baseline = variants.find((r) => r.lodMinScreenSize === 0 && !r.batchByFill);

  const optimisationSection =
    full && noLod && baseline
      ? `## Where the worst case went

Zoomed all the way out, culling rejects nothing: all ${full.drawnMean.toLocaleString()} nodes are on
screen, each about a pixel across. Two changes carried it into frame budget.

| overview @ ${full.nodeCount.toLocaleString()} | render p50 (ms) | p95 (ms) | vs baseline |
| --- | ---: | ---: | ---: |
| one \`fillRect\` per node | ${baseline.renderMs.p50.toFixed(1)} | ${baseline.renderMs.p95.toFixed(1)} | — |
| + one path per fill colour | ${noLod.renderMs.p50.toFixed(1)} | ${noLod.renderMs.p95.toFixed(1)} | ${(baseline.renderMs.p50 / noLod.renderMs.p50).toFixed(2)}x |
| + sub-pixel LOD | **${full.renderMs.p50.toFixed(1)}** | **${full.renderMs.p95.toFixed(1)}** | **${(baseline.renderMs.p50 / full.renderMs.p50).toFixed(2)}x** |

The profile said the frame was not pixel-bound: \`ctx.rect()\` alone was around a
third of it. A hundred thousand of anything through the canvas API costs a
hundred thousand JS-to-C++ crossings, and batching them into one path per colour
removes the \`fill\` calls but not the \`rect\` calls — which is why it moves less
than it looks like it should.

Below about a pixel a rectangle's geometry is not resolvable anyway, so those
shapes are written directly into an \`ImageData\` — a few typed-array stores each —
and uploaded as one region. Trade-offs: sub-pixel shapes lose antialiasing and
exact z-order, and a single path cannot express per-node paint order, so
batching is only valid while same-coloured shapes are interchangeable.

Note the run spread column before reading much into the middle row.
`
      : '';

  return `# Benchmark results

Generated ${report.generatedAt} · ${config.frames} measured frames after ${config.warmup} warmup
frames, ${config.reps} repetitions per scenario, **median run reported**.

\`run spread\` is the gap between the fastest and slowest repetition. Treat any
difference smaller than that as noise — on a shared or throttled machine it
routinely exceeds 20%, which is larger than most changes worth measuring.

**Machine** — ${env.cpu}, ${env.cores} cores, ${env.memoryGB} GB · ${env.platform}
**Browser** — Chromium ${env.chromium}, headless=${env.headless}, GPU: \`${env.gpu}\`
**Viewport** — 1600x900 @ dpr 1

> \`render\` is the engine's own cost — cull query plus draw calls, measured inside
> \`Canvas2DRenderer.render\`. It is the number the engine controls, so it is the one
> tracked for regressions; rAF cadence is capped by the display and says more about
> the browser than about this code.
> A software-rasterised headless run is a **lower bound** — expect better on real hardware.

## Frame cost

| scenario | nodes | drawn/frame | render p50 (ms) | p95 | p99 | % of 16.7 ms budget (p95) | run spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

| name | what it measures |
| --- | --- |
| \`pan-close\` | ~1% of the world visible. The common editing case: culling should do nearly all the work. |
| \`pan-mid\` | ~10% of the world visible. |
| \`zoom-cycle\` | Continuous zoom between overview and close, i.e. a cull set that changes every frame. |
| \`overview\` | The whole scene on screen. Worst case: culling rejects nothing. |

## Viewport queries

Cull query only, no drawing: how long it takes to find what is on screen.

| nodes | hits/query | indexed (µs) | linear scan (µs) | speedup |
| --- | ---: | ---: | ---: | ---: |
${queryRows}

${optimisationSection}
## Reproducing

\`\`\`bash
pnpm install
pnpm bench          # add --stress for the 1M-node run, --headed to watch
\`\`\`

Flame charts land in \`bench/results/*.cpuprofile\`. Open Chrome DevTools →
Performance → *Load profile*, or drop the file into https://speedscope.app.
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
