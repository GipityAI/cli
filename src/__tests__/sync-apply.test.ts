/**
 * sync() integration + baseline + conflict-name tests.
 *
 * Uses `globalThis.fetch` stubbing to intercept HTTP. The tar-download path
 * is not exercised here (node:test lacks clean tar-stream mocking); that's
 * covered end-to-end by the server CAS tests + CLI push CAS test.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let home: string;
let projectDir: string;
let origHome: string | undefined;
let origCwd: string;
let origFetch: typeof globalThis.fetch;
let origTTY: boolean | undefined;

before(() => {
  origHome = process.env.HOME;
  origCwd = process.cwd();
  origFetch = globalThis.fetch;
  origTTY = process.stdout.isTTY;

  home = mkdtempSync(join(tmpdir(), 'gipity-apply-home-'));
  process.env.HOME = home;
  mkdirSync(join(home, '.gipity'), { recursive: true });
  writeFileSync(join(home, '.gipity', 'auth.json'), JSON.stringify({
    accessToken: 'fake-jwt',
    refreshToken: 'fake-refresh',
    email: 'ec-test@914-6.com',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }));

  projectDir = mkdtempSync(join(tmpdir(), 'gipity-apply-proj-'));
  writeFileSync(join(projectDir, '.gipity.json'), JSON.stringify({
    projectGuid: 'proj_apply',
    projectSlug: 'p',
    accountSlug: 'a',
    agentGuid: 'agt_t',
    conversationGuid: null,
    apiBase: 'https://test.invalid',
    ignore: ['.gipity.json', '.gipity/'],  // match DEFAULT_SYNC_IGNORE subset for these tests
  }));
  mkdirSync(join(projectDir, '.gipity'), { recursive: true });
  process.chdir(projectDir);

  // Force non-TTY so sync() defaults `interactive: false`.
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
});

after(() => {
  process.chdir(origCwd);
  globalThis.fetch = origFetch;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origTTY !== undefined) {
    Object.defineProperty(process.stdout, 'isTTY', { value: origTTY, configurable: true });
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Nuke everything under projectDir except .gipity.json, then restore an
  // empty .gipity dir. Hermetic is simpler than incremental cleanup.
  const entries = readdirSync(projectDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.gipity.json') continue;
    rmSync(join(projectDir, e.name), { recursive: true, force: true });
  }
  mkdirSync(join(projectDir, '.gipity'), { recursive: true });
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
}

// ─── Baseline I/O ────────────────────────────────────────────────

describe('readBaseline', () => {
  it('returns empty baseline when file missing', async () => {
    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { readBaseline } = await import('../sync.js');
    const b = readBaseline('proj_apply');
    assert.deepEqual(b.files, {});
    assert.equal(b.lastFullSync, null);
  });

  it('returns empty baseline when file is malformed JSON', async () => {
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), '{ not valid json');
    const { readBaseline } = await import('../sync.js');
    const b = readBaseline('proj_apply');
    assert.deepEqual(b.files, {});
  });

  it('returns empty baseline when projectGuid does not match current project', async () => {
    // Someone else's baseline in our folder - must not leak.
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_OTHER',
      files: { 'leak.txt': { size: 1, mtime: '2024', sha256: 'x', serverVersion: 1 } },
      lastFullSync: null,
    }));
    const { readBaseline } = await import('../sync.js');
    const b = readBaseline('proj_apply');
    assert.deepEqual(b.files, {});
  });

  it('round-trips via writeBaseline', async () => {
    const { readBaseline, writeBaseline } = await import('../sync.js');
    writeBaseline({
      projectGuid: 'proj_apply',
      files: { 'a.ts': { size: 10, mtime: '2024', sha256: 'hhh', serverVersion: 3 } },
      lastFullSync: '2024-01-01T00:00:00.000Z',
    });
    const b = readBaseline('proj_apply');
    assert.equal(b.files['a.ts']?.serverVersion, 3);
    assert.equal(b.lastFullSync, '2024-01-01T00:00:00.000Z');
  });
});

// ─── Conflict filenames ─────────────────────────────────────────

describe('conflictedCopyName', () => {
  it('inserts hostname+timestamp before the extension', async () => {
    const { conflictedCopyName } = await import('../sync.js');
    const out = conflictedCopyName('src/app.ts');
    assert.match(out, /^src\/app \(conflict from .+ \d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\)\.ts$/);
  });

  it('handles files with no extension', async () => {
    const { conflictedCopyName } = await import('../sync.js');
    const out = conflictedCopyName('Makefile');
    assert.match(out, /^Makefile \(conflict from .+\)$/);
  });

  it('handles unicode and spaces in the path', async () => {
    const { conflictedCopyName } = await import('../sync.js');
    const out = conflictedCopyName('notes/日本語 file.md');
    assert.match(out, /^notes\/日本語 file \(conflict from /);
    assert.ok(out.endsWith('.md'));
  });

  it('sanitizes weird hostname characters so the filename is safe', async () => {
    const { conflictedCopyName } = await import('../sync.js');
    const out = conflictedCopyName('x.ts');
    // Whatever characters the real hostname had, the result should only
    // contain [A-Za-z0-9._-] in the "from <host>" segment.
    const m = out.match(/\(conflict from ([^ ]+) /);
    assert.ok(m, 'hostname segment present');
    assert.match(m![1], /^[A-Za-z0-9._-]+$/);
  });
});

// ─── sync() end-to-end with fetch mock ────────────────────────

describe('sync() - fetch-intercepted', () => {
  it('noop when local, remote, and baseline all agree', async () => {
    // Baseline says we have foo.txt at v=3, sha=same.
    writeFileSync(join(projectDir, 'foo.txt'), 'content');
    const { createHash } = await import('crypto');
    const sha = createHash('sha256').update('content').digest('hex');
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_apply',
      files: { 'foo.txt': { size: 7, mtime: '2024', sha256: sha, serverVersion: 3 } },
      lastFullSync: null,
    }));

    stubFetch(async (url) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        return new Response(JSON.stringify({ data: [
          { path: 'foo.txt', size: 7, modified: '2026-04-21', type: 'file', guid: 'fl_foo', contentHash: sha, serverVersion: 3 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync, readBaseline } = await import('../sync.js');
    const tBefore = Date.now();
    const result = await sync({ interactive: false });
    assert.equal(result.applied, 0);
    assert.equal(result.plan.actions.length, 0);
    assert.deepEqual(result.errors, []);
    // Baseline's lastFullSync must be bumped even when no actions fired -
    // otherwise we can't tell "sync ran and everything was fine" from
    // "sync never ran".
    const bl = readBaseline('proj_apply');
    assert.ok(bl.lastFullSync, 'lastFullSync must be set');
    assert.ok(new Date(bl.lastFullSync!).getTime() >= tBefore,
      'lastFullSync must be after the sync call started');
    // Baseline entry preserved.
    assert.equal(bl.files['foo.txt']?.serverVersion, 3);
  });

  it('uploads a new local file with expected=null, baseline updates', async () => {
    writeFileSync(join(projectDir, 'hello.txt'), 'hi');

    let initCallCount = 0;
    let completeCallCount = 0;
    let lastInitBody: any = null;
    let lastCompleteBody: any = null;

    stubFetch(async (url, init) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        return new Response(JSON.stringify({ data: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/files/upload-init')) {
        initCallCount++;
        lastInitBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: {
          upload_guid: 'fl_new', method: 'PUT',
          url: 'https://s3.example/stage', expires_in: 3600,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://s3.example')) {
        return new Response('', { status: 200, headers: { etag: '"fake"' } });
      }
      if (url.includes('/files/upload-complete')) {
        completeCallCount++;
        lastCompleteBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: {
          size: 2, guid: 'fl_new', version: 1, server_version: 1,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync, readBaseline } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.equal(result.applied, 1);
    assert.equal(result.plan.uploads, 1);
    assert.equal(initCallCount, 1);
    assert.equal(completeCallCount, 1);
    assert.equal(lastInitBody.expected_server_version, null, 'new file → expected=null');
    assert.equal(lastCompleteBody.expected_server_version, null);

    const bl = readBaseline('proj_apply');
    assert.equal(bl.files['hello.txt']?.serverVersion, 1);
  });

  it('skips deletes in non-interactive mode when the bulk-delete threshold trips', async () => {
    // Seed baseline with 20 files; local has none; remote has none.
    // That's 20 delete-remote actions → blocked by guard in non-interactive.
    const files: Record<string, any> = {};
    for (let i = 0; i < 20; i++) {
      files[`f${i}.txt`] = { size: 1, mtime: '2024', sha256: `sha${i}`, serverVersion: 1 };
    }
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_apply', files, lastFullSync: null,
    }));

    stubFetch(async (url) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        // Remote has all 20 files (baseline state) - client deleted all 20 locally.
        const data = Object.entries(files).map(([path, e]: [string, any]) => ({
          path, size: 1, modified: '2024', type: 'file',
          guid: `fl_${path}`, contentHash: e.sha256, serverVersion: e.serverVersion,
        }));
        return new Response(JSON.stringify({ data }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`guard should prevent any DELETE calls, got: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.equal(result.plan.deletesRemote, 20);
    assert.equal(result.applied, 0, 'no deletes executed under guard');
    assert.equal(result.skipped, 20, 'all 20 actions skipped by guard');
  });

  it('force:true bypasses the bulk-delete guard', async () => {
    const files: Record<string, any> = {};
    for (let i = 0; i < 20; i++) {
      files[`f${i}.txt`] = { size: 1, mtime: '2024', sha256: `sha${i}`, serverVersion: 1 };
    }
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_apply', files, lastFullSync: null,
    }));

    let deleteCount = 0;
    stubFetch(async (url, init) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        const data = Object.entries(files).map(([path, e]: [string, any]) => ({
          path, size: 1, modified: '2024', type: 'file',
          guid: `fl_${path}`, contentHash: e.sha256, serverVersion: e.serverVersion,
        }));
        return new Response(JSON.stringify({ data }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'DELETE') {
        deleteCount++;
        return new Response(JSON.stringify({ success: true }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ interactive: false, force: true });

    assert.equal(deleteCount, 20);
    assert.equal(result.applied, 20);
    assert.equal(result.skipped, 0);
  });

  it('plan-only mode returns the plan without any HTTP writes', async () => {
    writeFileSync(join(projectDir, 'new.txt'), 'x');

    let writeCalls = 0;
    stubFetch(async (url, init) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        return new Response(JSON.stringify({ data: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'POST' || init?.method === 'DELETE') {
        writeCalls++;
      }
      throw new Error(`unexpected: ${url} ${init?.method}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ plan: true, interactive: false });

    assert.equal(writeCalls, 0, 'plan mode must not write');
    assert.equal(result.applied, 0);
    assert.equal(result.plan.uploads, 1);
    assert.ok(result.summary.includes('1 upload'));
  });

  it('plan-time conflict (modified × modified) → rename local + download + upload copy', async () => {
    // Baseline says we have app.js at v=1. Local has edited it. Remote has
    // also been modified (v=2). Upload of app.js returns 409 with current=2.
    const { createHash } = await import('crypto');
    const localSha = createHash('sha256').update('local-edit').digest('hex');
    const remoteSha = createHash('sha256').update('remote-edit').digest('hex');
    writeFileSync(join(projectDir, 'app.js'), 'local-edit');
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_apply',
      files: { 'app.js': {
        size: 'baseline'.length, mtime: '2024',
        sha256: createHash('sha256').update('baseline').digest('hex'),
        serverVersion: 1,
      } },
      lastFullSync: null,
    }));

    // The plan for app.js is 'modified × modified' → conflict (no 409 needed;
    // plan already classified it). But we'll also verify the server-side
    // matching by returning remote_sha differing from baseline.
    const tarHeader = Buffer.from(''); // not used because conflict is detected pre-apply

    let completeCalls: any[] = [];
    stubFetch(async (url, init) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        return new Response(JSON.stringify({ data: [
          { path: 'app.js', size: 11, modified: '2024', type: 'file',
            guid: 'fl_app', contentHash: remoteSha, serverVersion: 2 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/files/tree?content=tar')) {
        // Build a minimal tar with app.js = 'remote-edit'
        const tar = await import('tar-stream');
        const pack = tar.pack();
        pack.entry({ name: 'app.js' }, 'remote-edit');
        pack.finalize();
        const chunks: Buffer[] = [];
        for await (const c of pack as any) chunks.push(c);
        return new Response(Buffer.concat(chunks), { status: 200 });
      }
      if (url.includes('/files/upload-init')) {
        const body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: {
          upload_guid: `fl_${body.path.length}`, method: 'PUT',
          url: 'https://s3.example/stage', expires_in: 3600,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://s3.example')) {
        return new Response('', { status: 200, headers: { etag: '"fake"' } });
      }
      if (url.includes('/files/upload-complete')) {
        const body = JSON.parse(init!.body as string);
        completeCalls.push(body);
        return new Response(JSON.stringify({ data: {
          size: 10, guid: 'fl_done', version: 1, server_version: 7,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.equal(result.plan.conflicts, 1);
    // Original path should now hold remote bytes.
    assert.equal(readFileSync(join(projectDir, 'app.js'), 'utf-8'), 'remote-edit');
    // A renamed conflict copy should exist.
    const entries = readdirSync(projectDir);
    const copy = entries.find((n: string) => n.startsWith('app ') && n.includes('conflict from'));
    assert.ok(copy, 'conflicted-copy file should exist on disk');
    assert.equal(readFileSync(join(projectDir, copy!), 'utf-8'), 'local-edit');
    // Both server paths were uploaded (only the renamed copy, since original just downloaded)
    assert.ok(completeCalls.length >= 1, 'at least one upload-complete for the conflict copy');
  });

  it('apply-time 409 (baseline fresh but another client raced in between) → re-plans as conflict', async () => {
    // Plan sees: local='modified', remote='unchanged' → upload with CAS=baseline.
    // But server has already moved on between manifest-fetch and upload - returns
    // 409. This exercises the apply-phase UploadConflictError handler in sync.ts.
    const { createHash } = await import('crypto');
    const baselineSha = createHash('sha256').update('base').digest('hex');
    const localSha = createHash('sha256').update('local-new').digest('hex');
    const newerRemoteSha = createHash('sha256').update('newer-remote').digest('hex');

    writeFileSync(join(projectDir, 'race.txt'), 'local-new');
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_apply',
      files: { 'race.txt': {
        size: 4, mtime: '2024', sha256: baselineSha, serverVersion: 3,
      } },
      lastFullSync: null,
    }));

    let initCalls = 0;
    stubFetch(async (url, init) => {
      // Manifest still shows the "unchanged" remote that matches baseline -
      // client will plan an upload with expected=3.
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        return new Response(JSON.stringify({ data: [
          { path: 'race.txt', size: 4, modified: '2024', type: 'file',
            guid: 'fl_r', contentHash: baselineSha, serverVersion: 3 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Between plan and apply, another client bumped the version to 5.
      if (url.includes('/files/upload-init')) {
        initCalls++;
        const body = JSON.parse(init!.body as string);
        if (body.path === 'race.txt' && body.expected_server_version === 3) {
          // Server has moved past 3 - return 409.
          return new Response(JSON.stringify({
            error: { code: 'CONFLICT', message: 'Version mismatch: expected 3, current 5' },
            data: { current_server_version: 5 },
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        // The conflict-copy re-upload (expected=null) succeeds.
        return new Response(JSON.stringify({ data: {
          upload_guid: 'fl_copy', method: 'PUT',
          url: 'https://s3.example/stage', expires_in: 3600,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // fetchOne (targeted tar download for the new remote version)
      if (url.includes('/files/tree?content=tar')) {
        const tar = await import('tar-stream');
        const pack = tar.pack();
        pack.entry({ name: 'race.txt' }, 'newer-remote');
        pack.finalize();
        const chunks: Buffer[] = [];
        for await (const c of pack as any) chunks.push(c);
        return new Response(Buffer.concat(chunks), { status: 200 });
      }
      if (url.startsWith('https://s3.example')) {
        return new Response('', { status: 200, headers: { etag: '"fake"' } });
      }
      if (url.includes('/files/upload-complete')) {
        return new Response(JSON.stringify({ data: {
          size: 8, guid: 'fl_cc', version: 1, server_version: 1,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ interactive: false });

    // Plan thought it was a clean upload (not a plan-level conflict).
    assert.equal(result.plan.conflicts, 0, 'plan classified as upload, not conflict');
    assert.equal(result.plan.uploads, 1);
    assert.ok(initCalls >= 2, 'at least two upload-inits: original (409) + conflict-copy');

    // After 409 handling: original path must hold the newer remote bytes.
    assert.equal(readFileSync(join(projectDir, 'race.txt'), 'utf-8'), 'newer-remote');
    // A conflicted-copy file must exist with the local-new bytes preserved.
    const entries = readdirSync(projectDir);
    const copy = entries.find(n => n.startsWith('race ') && n.includes('conflict from'));
    assert.ok(copy, 'conflicted-copy file should exist on disk');
    assert.equal(readFileSync(join(projectDir, copy!), 'utf-8'), 'local-new');
  });
});
