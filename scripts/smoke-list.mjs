// The CLI smoke set, read from test-smoke.txt (one test name per line, `#`
// comments). It used to be one long `node --test ...` line in package.json, and
// every parallel gw session that added a test conflicted on that single line.
// Shared by smoke.mjs (the full gate) and smoke-quick.mjs (the diff-scoped one).
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);

/** Parse the list text; throw on a missing test source, a duplicate, or an unsorted list. */
export function parseSmokeList(text, exists = (name) => existsSync(new URL(`src/__tests__/${name}.test.ts`, ROOT))) {
  const names = text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const problems = [];
  const seen = new Set();
  names.forEach((n, i) => {
    if (seen.has(n)) problems.push(`duplicate: ${n}`);
    seen.add(n);
    if (!exists(n)) problems.push(`no such test file: src/__tests__/${n}.test.ts`);
    if (i > 0 && names[i - 1] > n) problems.push(`out of order: ${n} after ${names[i - 1]}`);
  });
  if (problems.length) throw new Error(`test-smoke.txt:\n  ${problems.join('\n  ')}`);
  return names;
}

export function readSmokeList() {
  return parseSmokeList(readFileSync(new URL('test-smoke.txt', ROOT), 'utf8'));
}

/** dist path of a smoke test name. */
export const distTest = (name) => `dist/__tests__/${name}.test.js`;
