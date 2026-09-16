import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * `#private` class fields cost a WeakMap lookup per access once a bundler
 * downlevels them, and bundlers downlevel them by default: Vite's default
 * build target includes Safari 14, which predates the syntax. Measured on this
 * engine's own landing page, that turned an 11 ms frame into a 36 ms one —
 * a 3.3x regression that appears only in a consumer's production build and
 * never in dev, which is close to the worst way for a performance bug to hide.
 *
 * TypeScript's `private` keyword gives the same authoring-time encapsulation
 * and compiles to a plain property, so there is nothing to downlevel.
 */
describe('source hygiene', () => {
  it('uses no #private class fields, which bundlers downlevel to WeakMaps', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // Skip string literals so hex colours like '#0f1115' do not trip this.
        const code = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
        if (/(^|[^\w'"`])#[A-Za-z_]\w*/.test(code)) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
