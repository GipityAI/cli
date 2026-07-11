/**
 * Regression tests for GipityAI/cli#133: a remote tree entry whose bytes the
 * server can never serve (a "ghost" node - listed in /files/tree, absent from
 * the bulk tar, and answered with an explicit 410 GONE by every single-file
 * recovery attempt) must not disarm the deletes pass forever. Genuinely
 * transient failures (HTTP errors, truncated streams, and even clean-but-empty
 * tars, which boundary truncation can produce) must still skip deletes - that
 * guard is what stops a truncated pull from being mistaken for server-side
 * deletions (see the WS-00253 test in sync-apply.test.ts).
 *
 * Same fetch-stub harness as sync-apply.test.ts, but this file DOES exercise
 * the tar download path: tar-stream packs real archives for the stub, so the
 * bulk-download, single-file-recovery, and outcome-classification code all run
 * for real.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

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

  home = mkdtempSync(join(tmpdir(), 'gipity-unretr-home-'));
  process.env.HOME = home;
  mkdirSync(join(home, '.gipity'), { recursive: true });
  writeFileSync(join(home, '.gipity', 'auth.json'), JSON.stringify({
    accessToken: 'fake-jwt',
    refreshToken: 'fake-refresh',
    email: 'ec-test@914-6.com',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }));

  projectDir = mkdtempSync(join(tmpdir(), 'gipity-unretr-proj-'));
  writeFileSync(join(projectDir, '.gipity.json'), JSON.stringify({
    projectGuid: 'proj_unretr',
    projectSlug: 'p',
    accountSlug: 'a',
    agentGuid: 'agt_t',
    conversationGuid: null,
    apiBase: 'https://test.invalid',
    ignore: ['.gipity.json', '.gipity/'],
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

/** Pack entries into real tar bytes so the CLI's extract path runs for real.
 *  Returns ArrayBuffer - the one binary BodyInit shape this repo's TS lib
 *  accepts for `new Response(...)`. */
async function tarBuffer(entries: Record<string, string | Buffer>): Promise<ArrayBuffer> {
  const tar = await import('tar-stream');
  const pack = tar.pack();
  for (const [name, content] of Object.entries(entries)) pack.entry({ name }, content);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Shared scenario: one planned download (ghost.png, remote-added) plus one
 * planned delete-local (stale.txt: synced in the baseline, unchanged locally,
 * gone from the remote tree). The delete is unrelated to the download - the
 * question each test answers is whether the download failure blocks it.
 */
const GHOST_BYTES = Buffer.from('PNG!');
const GHOST_SHA = createHash('sha256').update(GHOST_BYTES).digest('hex');

function seedStaleAndBaseline(): void {
  writeFileSync(join(projectDir, 'stale.txt'), 'old');
  const staleSha = createHash('sha256').update('old').digest('hex');
  writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
    projectGuid: 'proj_unretr',
    files: { 'stale.txt': { size: 3, mtime: '2024', sha256: staleSha, serverVersion: 1 } },
    lastFullSync: null,
  }));
}

function treeJson(): Response {
  return new Response(JSON.stringify({ data: [
    { path: 'ghost.png', size: GHOST_BYTES.length, modified: '2026-07-01', type: 'file', guid: 'fl_ghost', contentHash: GHOST_SHA, serverVersion: 1 },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('sync() - unretrievable remote files vs the deletes guard (#133)', () => {
  it('a ghost entry (explicit 410 GONE from recovery) does NOT block unrelated deletions', async () => {
    seedStaleAndBaseline();

    let singleFetches = 0;
    stubFetch(async (url) => {
      if (url.includes('content=tar&path=')) {
        singleFetches++;
        // The server's permanent verdict: content can never be served.
        return new Response(JSON.stringify({ error: { code: 'GONE', message: 'File content is unavailable' } }),
          { status: 410, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('content=tar')) {
        return new Response(await tarBuffer({}));  // bulk tar: server skipped the ghost blob
      }
      if (url.includes('/files/tree')) return treeJson();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync, readBaseline } = await import('../sync.js');
    const result = await sync({ interactive: false });

    // The unrelated delete-local ran: sync converges instead of wedging.
    assert.equal(existsSync(join(projectDir, 'stale.txt')), false, 'stale.txt must be deleted');
    assert.ok(!result.errors.some(e => /Skipped .* deletion/.test(e)),
      `deletes must not be skipped, got: ${JSON.stringify(result.errors)}`);
    // The ghost is reported as a distinct, permanent condition - not the
    // generic "Download missing" that implies a retry will fix it.
    assert.ok(result.errors.some(e => e.startsWith('Unretrievable on server: ghost.png')),
      `expected an Unretrievable error, got: ${JSON.stringify(result.errors)}`);
    // All three recovery attempts were made before declaring it unretrievable.
    assert.equal(singleFetches, 3);

    const bl = readBaseline('proj_unretr');
    assert.equal(bl.files['stale.txt'], undefined, 'deleted file leaves the baseline');
    assert.equal(bl.files['ghost.png'], undefined, 'ghost must not enter the baseline');
  });

  it('a transient failure (HTTP 500 on every tar) still skips ALL deletions', async () => {
    seedStaleAndBaseline();

    stubFetch(async (url) => {
      if (url.includes('content=tar')) {
        return new Response('boom', { status: 500 });
      }
      if (url.includes('/files/tree')) return treeJson();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync, readBaseline } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.equal(existsSync(join(projectDir, 'stale.txt')), true,
      'transient failure must leave local files alone');
    assert.ok(result.errors.some(e => /Skipped 1 deletion/.test(e)),
      `expected the skipped-deletions guard, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.errors.some(e => e === 'Download missing: ghost.png'),
      `expected the generic Download missing error, got: ${JSON.stringify(result.errors)}`);

    const bl = readBaseline('proj_unretr');
    assert.equal(bl.files['stale.txt']?.serverVersion, 1, 'skipped delete keeps its baseline entry');
  });

  it('mixed signals (one transient attempt among 410s) stay conservative: deletes skipped', async () => {
    seedStaleAndBaseline();

    let singleFetches = 0;
    stubFetch(async (url) => {
      if (url.includes('content=tar&path=')) {
        singleFetches++;
        if (singleFetches === 1) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ error: { code: 'GONE', message: 'File content is unavailable' } }),
          { status: 410, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('content=tar')) {
        return new Response(await tarBuffer({}));
      }
      if (url.includes('/files/tree')) return treeJson();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.equal(existsSync(join(projectDir, 'stale.txt')), true,
      'a transient attempt in the mix must keep the conservative guard');
    assert.ok(result.errors.some(e => /Skipped 1 deletion/.test(e)),
      `expected the skipped-deletions guard, got: ${JSON.stringify(result.errors)}`);
  });

  it('repeated wedges escalate: third consecutive skip warns that it looks stuck', async () => {
    seedStaleAndBaseline();

    stubFetch(async (url) => {
      if (url.includes('content=tar')) return new Response('boom', { status: 500 });
      if (url.includes('/files/tree')) return treeJson();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');

    const first = await sync({ interactive: false });
    assert.ok(!first.errors.some(e => /syncs in a row/.test(e)),
      'first skip must not escalate');
    await sync({ interactive: false });
    const third = await sync({ interactive: false });
    assert.ok(third.errors.some(e => /skipped 3 syncs in a row - this looks stuck/.test(e)),
      `third consecutive skip must escalate, got: ${JSON.stringify(third.errors)}`);

    // A converged run (no skips) resets the streak.
    const staleSha = createHash('sha256').update('old').digest('hex');
    stubFetch(async (url) => {
      if (url.includes('/files/tree') && !url.includes('content=tar')) {
        // Remote now agrees with local: stale.txt is back, nothing to download.
        return new Response(JSON.stringify({ data: [
          { path: 'stale.txt', size: 3, modified: '2026-07-01', type: 'file', guid: 'fl_stale', contentHash: staleSha, serverVersion: 1 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await sync({ interactive: false });
    const state = JSON.parse(readFileSync(join(projectDir, '.gipity', 'sync-state.json'), 'utf-8'));
    assert.equal(state.deletesSkippedStreak, undefined, 'clean run resets the streak');
  });

  it('a clean-but-empty single-file tar (possible boundary truncation) stays conservative', async () => {
    seedStaleAndBaseline();

    stubFetch(async (url) => {
      if (url.includes('content=tar')) {
        // Both bulk and single-file recovery: complete tar, entry absent.
        // Without the explicit 410 this is ambiguous - must NOT unblock deletes.
        return new Response(await tarBuffer({}));
      }
      if (url.includes('/files/tree')) return treeJson();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.equal(existsSync(join(projectDir, 'stale.txt')), true,
      'ambiguous empty tar must keep the conservative guard');
    assert.ok(result.errors.some(e => /Skipped 1 deletion/.test(e)),
      `expected the skipped-deletions guard, got: ${JSON.stringify(result.errors)}`);
  });

  it('single-file recovery still succeeds when the server can serve the bytes', async () => {
    seedStaleAndBaseline();

    stubFetch(async (url) => {
      if (url.includes('content=tar&path=')) {
        return new Response(await tarBuffer({ 'ghost.png': GHOST_BYTES }));
      }
      if (url.includes('content=tar')) {
        return new Response(await tarBuffer({}));  // bulk dropped it; recovery finds it
      }
      if (url.includes('/files/tree')) return treeJson();
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { sync, readBaseline } = await import('../sync.js');
    const result = await sync({ interactive: false });

    assert.deepEqual(result.errors, []);
    assert.equal(existsSync(join(projectDir, 'ghost.png')), true, 'recovered file written');
    assert.equal(existsSync(join(projectDir, 'stale.txt')), false, 'delete ran on a complete pull');
    const bl = readBaseline('proj_unretr');
    assert.equal(bl.files['ghost.png']?.sha256, GHOST_SHA);
  });
});
