import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { plan, formatPlan, walkLocal, type BaselineEntry } from '../sync.js';

type L = { size: number; mtime: string; sha256?: string };
type R = { path: string; size: number; sha256: string | null; serverVersion: number; modified: string };

function remote(path: string, sha: string | null, sv = 1, size = 100): R {
  return { path, size, sha256: sha, serverVersion: sv, modified: '2024-01-01' };
}
function local(size = 100, sha?: string): L {
  return { size, mtime: '2024-01-01', sha256: sha };
}
function baselineOf(sha: string, sv = 1, size = 100): BaselineEntry {
  return { size, mtime: '2024-01-01', sha256: sha, serverVersion: sv };
}

describe('plan() - 9-cell decision table', () => {
  it('unchanged × unchanged → noop (no action)', () => {
    const p = plan(
      new Map([['foo', local(100, 'h1')]]),
      new Map([['foo', remote('foo', 'h1', 5)]]),
      { foo: baselineOf('h1', 5) },
    );
    assert.equal(p.actions.length, 0);
  });

  it('unchanged × modified → download', () => {
    const p = plan(
      new Map([['foo', local(100, 'h1')]]),
      new Map([['foo', remote('foo', 'h2', 6)]]),
      { foo: baselineOf('h1', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'download');
  });

  it('unchanged × deleted → delete-local', () => {
    const p = plan(
      new Map([['foo', local(100, 'h1')]]),
      new Map(),
      { foo: baselineOf('h1', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'delete-local');
  });

  it('modified × unchanged → upload with CAS=baseline.serverVersion', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-local-new')]]),
      new Map([['foo', remote('foo', 'h1', 5)]]),
      { foo: baselineOf('h1', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'upload');
    assert.equal(p.actions[0].expectedServerVersion, 5);
  });

  it('modified × modified (shas differ) → conflict', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-local')]]),
      new Map([['foo', remote('foo', 'h-remote', 6)]]),
      { foo: baselineOf('h-base', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'conflict');
    assert.ok(p.actions[0].renamedLocalTo);
    assert.ok(p.actions[0].renamedLocalTo!.includes('conflict from'));
  });

  it('modified × modified (shas happen to match) → noop', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-new')]]),
      new Map([['foo', remote('foo', 'h-new', 6)]]),
      { foo: baselineOf('h-base', 5) },
    );
    assert.equal(p.actions.length, 0);
  });

  it('modified × deleted → re-upload as new (expected=null)', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-local')]]),
      new Map(),
      { foo: baselineOf('h-base', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'upload');
    assert.equal(p.actions[0].expectedServerVersion, null);
  });

  it('added × absent → upload as new (expected=null)', () => {
    const p = plan(
      new Map([['foo', local(100, 'h1')]]),
      new Map(),
      {},
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'upload');
    assert.equal(p.actions[0].expectedServerVersion, null);
  });

  it('added × added (shas match) → noop', () => {
    const p = plan(
      new Map([['foo', local(100, 'h1')]]),
      new Map([['foo', remote('foo', 'h1', 1)]]),
      {},
    );
    assert.equal(p.actions.length, 0);
  });

  it('added × added (shas differ) → conflict', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-local')]]),
      new Map([['foo', remote('foo', 'h-remote', 1)]]),
      {},
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'conflict');
  });

  it('deleted × unchanged → delete-remote with CAS=baseline.serverVersion', () => {
    const p = plan(
      new Map(),
      new Map([['foo', remote('foo', 'h1', 5)]]),
      { foo: baselineOf('h1', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'delete-remote');
    assert.equal(p.actions[0].expectedServerVersion, 5);
  });

  it('deleted × modified → download (remote preserved)', () => {
    const p = plan(
      new Map(),
      new Map([['foo', remote('foo', 'h-new', 6)]]),
      { foo: baselineOf('h-base', 5) },
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'download');
  });

  it('deleted × deleted → noop (baseline dropped silently)', () => {
    const p = plan(new Map(), new Map(), { foo: baselineOf('h1', 5) });
    assert.equal(p.actions.length, 0);
  });

  it('absent × added → download (remote added since last sync)', () => {
    const p = plan(
      new Map(),
      new Map([['foo', remote('foo', 'h1', 1)]]),
      {},
    );
    assert.equal(p.actions.length, 1);
    assert.equal(p.actions[0].kind, 'download');
  });
});

describe('plan() - summary counts', () => {
  it('counts uploads, downloads, conflicts, deletes correctly', () => {
    const p = plan(
      new Map([
        ['add', local(100, 'a1')],                 // → upload
        ['mod', local(100, 'm2')],                 // → upload (CAS)
        ['keep', local(100, 'k1')],                // unchanged
        ['conflict', local(100, 'cL')],            // → conflict
        ['delremote', local(100, 'd1')],           // unchanged, remote deletes → delete-local
      ]),
      new Map([
        ['mod', remote('mod', 'm1', 5)],
        ['keep', remote('keep', 'k1', 3)],
        ['conflict', remote('conflict', 'cR', 7)],
        ['remote-new', remote('remote-new', 'r1', 1)],  // → download
      ]),
      {
        mod: baselineOf('m1', 5),
        keep: baselineOf('k1', 3),
        conflict: baselineOf('cBase', 6),
        delremote: baselineOf('d1', 4),
      },
    );
    assert.equal(p.uploads, 2);
    assert.equal(p.downloads, 1);
    assert.equal(p.deletesLocal, 1);
    assert.equal(p.conflicts, 1);
  });
});

describe('formatPlan', () => {
  it('returns "Up to date." for empty plan', () => {
    const p = plan(new Map(), new Map(), {});
    assert.equal(formatPlan(p), 'Up to date.');
  });

  it('includes action counts in the summary line', () => {
    const p = plan(
      new Map([['foo', local(100, 'h1')]]),
      new Map(),
      {},
    );
    const out = formatPlan(p);
    assert.ok(out.includes('1 upload'));
    assert.ok(out.includes('↑ foo'));
  });
});

describe('walkLocal - nested-project boundary', () => {
  it('does not descend into a subdirectory carrying its own .gipity.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-walk-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'a');
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'b.txt'), 'b');
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', '.gipity.json'), '{}');
      writeFileSync(join(root, 'nested', 'c.txt'), 'c');

      const result = walkLocal(root, [], {});

      assert.ok(result.has('a.txt'));
      assert.ok(result.has('sub/b.txt'), 'ordinary subdirectories are still walked');
      assert.equal(
        result.has('nested/c.txt'), false,
        'files of a nested Gipity project must not be scooped by the parent',
      );
      assert.equal(result.has('nested/.gipity.json'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still walks a project root that has its own .gipity.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-walk-'));
    try {
      writeFileSync(join(root, '.gipity.json'), '{}');
      writeFileSync(join(root, 'a.txt'), 'a');

      const result = walkLocal(root, ['.gipity.json'], {});

      assert.ok(result.has('a.txt'), 'the boundary check applies to subdirs, never the root itself');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
