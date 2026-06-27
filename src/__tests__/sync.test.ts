import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { plan, formatPlan, walkLocal, readGipityIgnore, effectiveIgnore, resolveInRoot, extractTarToMap, type BaselineEntry } from '../sync.js';
import { PassThrough } from 'stream';
import * as tar from 'tar-stream';

describe('extractTarToMap (idle-watchdog download)', () => {
  it('rejects (never hangs) when the stream delivers no end within the idle window', async () => {
    // The original bug: bytes arrive, the stream never ends, tar never emits
    // 'finish', and the awaiting Promise hangs forever. A short idle here must
    // reject promptly instead. The watchdog timer is unref'd (in production the
    // open socket keeps the loop alive); a bare in-memory stream has no such
    // handle, so keep the loop alive for the test ourselves.
    const keepAlive = setInterval(() => {}, 25);
    try {
      const stream = new PassThrough();
      const t0 = Date.now();
      await assert.rejects(extractTarToMap(stream, 120), /stalled/);
      assert.ok(Date.now() - t0 < 2000, 'rejected well before any real timeout');
    } finally { clearInterval(keepAlive); }
  });

  it('rejects when bytes flow then stall mid-stream without finishing', async () => {
    const keepAlive = setInterval(() => {}, 25);
    try {
      const stream = new PassThrough();
      stream.write(Buffer.alloc(512)); // some bytes, then silence (no tar end blocks)
      await assert.rejects(extractTarToMap(stream, 120), /stalled/);
    } finally { clearInterval(keepAlive); }
  });

  it('resolves with every file when the tar completes normally', async () => {
    const pack = tar.pack();
    pack.entry({ name: 'a.txt' }, 'hello');
    pack.entry({ name: 'dir/b.txt' }, 'world');
    pack.finalize();
    const files = await extractTarToMap(pack as any, 5000);
    assert.equal(files.get('a.txt')?.toString(), 'hello');
    assert.equal(files.get('dir/b.txt')?.toString(), 'world');
  });

  it('keeps only entries the filter selects', async () => {
    const pack = tar.pack();
    pack.entry({ name: 'keep.txt' }, 'yes');
    pack.entry({ name: 'skip.txt' }, 'no');
    pack.finalize();
    const files = await extractTarToMap(pack as any, 5000, undefined, (p) => p === 'keep.txt');
    assert.equal(files.get('keep.txt')?.toString(), 'yes');
    assert.equal(files.has('skip.txt'), false);
  });

  it('rejects on a source-stream error (a truncated body is never a clean finish)', async () => {
    const stream = new PassThrough();
    queueMicrotask(() => stream.destroy(new Error('socket reset')));
    await assert.rejects(extractTarToMap(stream, 5000), /socket reset/);
  });
});

describe('resolveInRoot (path-traversal guard)', () => {
  const root = join(tmpdir(), 'proj-root');

  it('resolves normal paths inside the project', () => {
    assert.equal(resolveInRoot(root, 'src/app.js'), join(root, 'src/app.js'));
    assert.equal(resolveInRoot(root, 'a/b/c.txt'), join(root, 'a/b/c.txt'));
  });

  it('throws on paths that escape the project root', () => {
    for (const p of ['../../.ssh/authorized_keys', '../sibling/x', '../../../etc/passwd', 'a/../../b']) {
      assert.throws(() => resolveInRoot(root, p), /outside project root/, `should reject ${p}`);
    }
  });

  it('does not treat a sibling dir with a shared prefix as inside', () => {
    // root + "-evil" shares the string prefix but is a different directory.
    assert.throws(() => resolveInRoot(root, '../proj-root-evil/x'), /outside project root/);
  });
});

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

  // Read-after-write race guard: a just-pushed local file advances the baseline,
  // but the remote tree can still serve an OLDER version (stale read). That looks
  // like unchanged×modified; a blind download would clobber the new local bytes.
  // A real remote change always carries a strictly newer serverVersion.
  it('unchanged × modified but remote serverVersion ≤ baseline (stale read) → no download', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-new')]]),
      new Map([['foo', remote('foo', 'h-stale', 4)]]),
      { foo: baselineOf('h-new', 5) },
    );
    assert.equal(p.actions.length, 0);
  });

  it('unchanged × modified with equal serverVersion (differing sha) → no download', () => {
    const p = plan(
      new Map([['foo', local(100, 'h-new')]]),
      new Map([['foo', remote('foo', 'h-stale', 5)]]),
      { foo: baselineOf('h-new', 5) },
    );
    assert.equal(p.actions.length, 0);
  });

  it('deleted × modified but stale remote (serverVersion ≤ baseline) → no resurrect', () => {
    const p = plan(
      new Map(),
      new Map([['foo', remote('foo', 'h-stale', 4)]]),
      { foo: baselineOf('h-cur', 5) },
    );
    assert.equal(p.actions.length, 0);
  });

  it('deleted × modified with a genuinely newer remote → restore (download)', () => {
    const p = plan(
      new Map(),
      new Map([['foo', remote('foo', 'h-newer', 9)]]),
      { foo: baselineOf('h-cur', 5) },
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

describe('.gipityignore', () => {
  it('readGipityIgnore parses patterns, skipping blanks and comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-ignore-'));
    try {
      writeFileSync(join(root, '.gipityignore'), [
        '# research material',
        '',
        'twenty-repo',
        './scratch/',
        '/notes.local.md',
        '*.bak',
      ].join('\n'));
      assert.deepEqual(readGipityIgnore(root), ['twenty-repo', 'scratch/', 'notes.local.md', '*.bak']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('readGipityIgnore returns [] when the file is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-ignore-'));
    try {
      assert.deepEqual(readGipityIgnore(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('effectiveIgnore merges config patterns with the ignore file and never syncs the file itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-ignore-'));
    try {
      writeFileSync(join(root, '.gipityignore'), 'vendored\n');
      const merged = effectiveIgnore(root, ['node_modules']);
      assert.ok(merged.includes('node_modules'));
      assert.ok(merged.includes('vendored'));
      assert.ok(merged.includes('.gipityignore'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('effectiveIgnore falls back to DEFAULT_SYNC_IGNORE when the config list is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-ignore-'));
    try {
      const merged = effectiveIgnore(root, []);
      assert.ok(merged.includes('node_modules'), 'empty config ignore must not mean "sync everything"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('walkLocal skips paths matched by .gipityignore patterns', () => {
    const root = mkdtempSync(join(tmpdir(), 'gipity-ignore-'));
    try {
      writeFileSync(join(root, '.gipityignore'), 'reference\n*.scratch\n');
      writeFileSync(join(root, 'index.html'), 'x');
      mkdirSync(join(root, 'reference'));
      writeFileSync(join(root, 'reference', 'big.txt'), 'y');
      writeFileSync(join(root, 'data.scratch'), 'z');

      const result = walkLocal(root, effectiveIgnore(root, []), {});

      assert.ok(result.has('index.html'));
      assert.equal(result.has('reference/big.txt'), false);
      assert.equal(result.has('data.scratch'), false);
      assert.equal(result.has('.gipityignore'), false, 'the ignore file itself never syncs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
