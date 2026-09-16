#!/usr/bin/env node
/**
 * Fails when a scenario's median render time blows past its budget.
 *
 * Budgets are deliberately loose: a shared CI runner moves 20%+ between runs
 * (see `run spread` in the report), so a tight threshold would just produce
 * flaky failures that teach people to ignore the check. This catches the
 * order-of-magnitude regressions — an accidental O(n) per frame, a lost index.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Scenario at 100k nodes -> maximum acceptable median render time, in ms. */
const BUDGETS = {
  'pan-close': 3,
  'pan-mid': 8,
  'zoom-cycle': 8,
  overview: 45,
};

/** Minimum acceptable speedup of an indexed viewport query over a full scan. */
const MIN_QUERY_SPEEDUP = 4;

const report = JSON.parse(
  await readFile(path.join(ROOT, 'bench', 'results', 'latest.json'), 'utf8'),
);

const failures = [];

for (const result of report.results) {
  // Only the fully optimised configuration is held to a budget; the peeled-back
  // variants exist to document the baseline, not to pass a check.
  if (result.nodeCount !== 100_000 || !result.batchByFill || result.lodMinScreenSize === 0) continue;
  const budget = BUDGETS[result.scenario];
  if (budget === undefined) continue;
  if (result.renderMs.p50 > budget) {
    failures.push(
      `${result.scenario} @ 100k: render p50 ${result.renderMs.p50.toFixed(2)}ms > ${budget}ms budget`,
    );
  }
}

for (const query of report.queryResults) {
  if (query.speedup < MIN_QUERY_SPEEDUP) {
    failures.push(
      `query @ ${query.nodeCount.toLocaleString()}: index only ${query.speedup.toFixed(1)}x ` +
        `faster than a full scan, expected >= ${MIN_QUERY_SPEEDUP}x`,
    );
  }
}

if (failures.length > 0) {
  console.error('\nPerformance budget exceeded:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('');
  process.exit(1);
}
console.log('All performance budgets met.');
