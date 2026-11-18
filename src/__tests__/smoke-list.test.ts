import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// scripts/smoke-list.mjs reads test-smoke.txt for the smoke gates. Loaded by URL:
// it is a plain .mjs build script outside the TypeScript tree.
const mod = await import(new URL('../../scripts/smoke-list.mjs', import.meta.url).href) as {
  parseSmokeList: (text: string, exists?: (name: string) => boolean) => string[];
  readSmokeList: () => string[];
};

describe('smoke list', () => {
  it('parses names, skipping comments and blanks', () => {
    assert.deepEqual(mod.parseSmokeList('# head\na\n\nb  # note\nc\n', () => true), ['a', 'b', 'c']);
  });

  it('fails on a missing file, a duplicate, or an unsorted list', () => {
    assert.throws(() => mod.parseSmokeList('a\nzz\n', (n) => n !== 'zz'), /no such test file: src\/__tests__\/zz\.test\.ts/);
    assert.throws(() => mod.parseSmokeList('a\na\n', () => true), /duplicate: a/);
    assert.throws(() => mod.parseSmokeList('b\na\n', () => true), /out of order: a after b/);
  });

  it('the checked-in test-smoke.txt is valid and includes this test', () => {
    assert.ok(mod.readSmokeList().includes('smoke-list'));
  });
});
