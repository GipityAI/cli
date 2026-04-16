import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAliases } from '../flag-aliases.js';

describe('normalizeAliases', () => {
  it('rewrites --out to --output', () => {
    assert.deepEqual(
      normalizeAliases(['node', 'gipity', 'generate', 'image', 'prompt', '--out', 'rice.jpg']),
      ['node', 'gipity', 'generate', 'image', 'prompt', '--output', 'rice.jpg'],
    );
  });

  it('leaves canonical --output unchanged', () => {
    assert.deepEqual(
      normalizeAliases(['--output', 'rice.jpg']),
      ['--output', 'rice.jpg'],
    );
  });

  it('rewrites --out=value equals form', () => {
    assert.deepEqual(
      normalizeAliases(['--out=rice.jpg']),
      ['--output=rice.jpg'],
    );
  });

  it('rewrites --db to --database', () => {
    assert.deepEqual(
      normalizeAliases(['db', 'query', 'select 1', '--db', 'mydb']),
      ['db', 'query', 'select 1', '--database', 'mydb'],
    );
  });

  it('rewrites multiple aliases in one argv', () => {
    assert.deepEqual(
      normalizeAliases(['--proj', 'foo', '--aspect', '16:9', '--out', 'x.png']),
      ['--project', 'foo', '--aspect-ratio', '16:9', '--output', 'x.png'],
    );
  });

  it('leaves unrelated long flags alone', () => {
    assert.deepEqual(
      normalizeAliases(['--quality', 'high', '--unknown-flag', 'v']),
      ['--quality', 'high', '--unknown-flag', 'v'],
    );
  });

  it('does not rewrite short flags', () => {
    assert.deepEqual(normalizeAliases(['-o', 'x.png']), ['-o', 'x.png']);
  });

  it('does not rewrite positional values', () => {
    assert.deepEqual(
      normalizeAliases(['fn', 'call', 'foo', '{"x":"--out"}']),
      ['fn', 'call', 'foo', '{"x":"--out"}'],
    );
  });

  it('does not rewrite a flag whose prefix matches an alias', () => {
    assert.deepEqual(
      normalizeAliases(['--output-dir']),
      ['--output-dir'],
    );
  });
});
