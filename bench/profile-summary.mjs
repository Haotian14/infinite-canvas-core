#!/usr/bin/env node
/**
 * Prints the heaviest frames in a .cpuprofile, so a regression can be read in
 * a terminal without opening DevTools.
 *
 *   node bench/profile-summary.mjs bench/results/overview-100000.cpuprofile
 */
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('usage: node bench/profile-summary.mjs <file.cpuprofile> [topN]');
  process.exit(1);
}
const topN = Number(process.argv[3] ?? 15);

const profile = JSON.parse(await readFile(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));

// `samples` names the leaf frame at each tick, so counting them gives self time.
const selfTicks = new Map();
for (const id of profile.samples) selfTicks.set(id, (selfTicks.get(id) ?? 0) + 1);

const totalTicks = profile.samples.length;
const durationMs = (profile.endTime - profile.startTime) / 1000;
const msPerTick = durationMs / totalTicks;

const rows = [...selfTicks.entries()]
  .map(([id, ticks]) => {
    const { functionName, url, lineNumber } = byId.get(id)?.callFrame ?? {};
    const where = url ? `${url.split('/').pop()}:${(lineNumber ?? -1) + 1}` : '';
    return {
      name: functionName || '(anonymous)',
      where,
      ticks,
      selfMs: ticks * msPerTick,
      share: (ticks / totalTicks) * 100,
    };
  })
  .sort((a, b) => b.ticks - a.ticks)
  .slice(0, topN);

console.log(`\n  ${file}`);
console.log(`  ${durationMs.toFixed(0)} ms wall, ${totalTicks} samples\n`);
console.log('  self%   self ms   function');
console.log('  ' + '-'.repeat(64));
for (const row of rows) {
  console.log(
    `  ${row.share.toFixed(1).padStart(5)}%  ${row.selfMs.toFixed(1).padStart(8)}   ` +
      `${row.name}${row.where ? `  ${row.where}` : ''}`,
  );
}
console.log('');
