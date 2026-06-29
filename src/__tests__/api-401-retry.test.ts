/**
 * A transient/raced 401 on a session token must self-heal: the API layer forces
 * a token refresh and replays the request once, instead of failing the command
 * with "Session expired". This is what stabilizes `gipity page eval`, whose
 * kickoff POST + long GET poll loop crosses the access-token refresh boundary
 * many times — a single 401 anywhere in that loop used to kill the whole call.
 * The same self-heal also covers the streaming/download paths (downloadStream →
 * sync, postForTarEntries → page screenshot) that bypass request().
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as tar from 'tar-stream';

// GIPITY_DIR (auth.json home) is captured at module load, so set env BEFORE
// importing api.js / auth.js.
let authDir: string;
let origFetch: typeof globalThis.fetch;
let origApiBase: string | undefined;
let origGipityDir: string | undefined;
let origGipityToken: string | undefined;

// A JWT whose payload is `{exp}` — only the middle segment is decoded by the CLI
// (decodeJwtExp), so header/signature can be anything.
function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `h.${payload}.s`;
}

function writeAuth(accessExpSec: number, refreshExpSec: number, accessExpiresAtMs: number): void {
  writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
    accessToken: jwt(accessExpSec),
    refreshToken: jwt(refreshExpSec),
    email: 'ec-test@914-6.com',
    expiresAt: new Date(accessExpiresAtMs).toISOString(),
  }));
}

before(() => {
  origFetch = globalThis.fetch;
  origApiBase = process.env.GIPITY_API_BASE;
  origGipityDir = process.env.GIPITY_DIR;
  origGipityToken = process.env.GIPITY_TOKEN;
  delete process.env.GIPITY_TOKEN;           // exercise the session-token path
  process.env.GIPITY_API_BASE = 'https://test.invalid';
  authDir = mkdtempSync(join(tmpdir(), 'gipity-api-401-'));
  process.env.GIPITY_DIR = authDir;
  mkdirSync(authDir, { recursive: true });
});

after(() => {
  globalThis.fetch = origFetch;
  if (origApiBase === undefined) delete process.env.GIPITY_API_BASE; else process.env.GIPITY_API_BASE = origApiBase;
  if (origGipityDir === undefined) delete process.env.GIPITY_DIR; else process.env.GIPITY_DIR = origGipityDir;
  if (origGipityToken === undefined) delete process.env.GIPITY_TOKEN; else process.env.GIPITY_TOKEN = origGipityToken;
  rmSync(authDir, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// A refresh response that rotates to a live token, so a replayed call succeeds.
function refreshOk(): Response {
  return jsonResponse(200, { accessToken: jwt(now() + 9999), refreshToken: jwt(now() + 7 * 24 * 3600) });
}

// A one-entry tar payload, so postForTarEntries has a real body to parse on the replay.
function buildTar(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
    pack.entry({ name: 'shot.png' }, 'PNGDATA');
    pack.finalize();
  });
}

describe('api request() 401 self-heal', () => {
  beforeEach(() => {
    // Access token still locally "fresh" (well outside the 5-min buffer) but the
    // SERVER rejects it — the clock-skew / sibling-rotation case the force path
    // exists for. The fast path would otherwise skip refreshing entirely.
    writeAuth(now() + 3600, now() + 7 * 24 * 3600, Date.now() + 60 * 60_000);
  });

  it('forces a refresh and replays the request once after a 401', async () => {
    const { get } = await import('../api.js');

    // A distinguishable exp so we can prove the replay carried the ROTATED token.
    const rotatedAccess = jwt(now() + 9999);
    const calls: string[] = [];
    let apiHits = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/auth/refresh')) {
        // Hand back a freshly-rotated pair so the replay carries a live token.
        return jsonResponse(200, { accessToken: rotatedAccess, refreshToken: jwt(now() + 7 * 24 * 3600) });
      }
      // First API hit 401s; the replay (after refresh) succeeds.
      apiHits += 1;
      if (apiHits === 1) return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Session expired' } });
      return jsonResponse(200, { data: { ok: true } });
    }) as unknown as typeof globalThis.fetch;

    const result = await get<{ data: { ok: boolean } }>('/tools/browser/eval/abc');

    assert.deepEqual(result, { data: { ok: true } });
    assert.equal(apiHits, 2, 'the API call should be replayed exactly once');
    assert.ok(calls.some((u) => u.endsWith('/auth/refresh')), 'a refresh round-trip should have happened');
    // The refresh must have persisted the rotated token to auth.json.
    const saved = JSON.parse(readFileSync(join(authDir, 'auth.json'), 'utf-8'));
    assert.equal(saved.accessToken, rotatedAccess, 'auth.json should hold the rotated access token');
  });

  it('surfaces a login hint when the refresh token is also dead', async () => {
    const { ApiError, get } = await import('../api.js');

    // Refresh token already expired → forceRefreshAccessToken can't recover.
    writeAuth(now() - 10, now() - 10, Date.now() - 10_000);

    let apiHits = 0;
    let refreshHits = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) { refreshHits += 1; return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }); }
      apiHits += 1;
      return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Session expired' } });
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      get('/tools/browser/eval/abc'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as InstanceType<typeof ApiError>).statusCode, 401);
        assert.match((err as Error).message, /run: gipity login/);
        return true;
      },
    );
    // The dead refresh token means we never wastefully replay the API call.
    assert.equal(apiHits, 1, 'no replay when the session is unrecoverable');
    assert.ok(refreshHits >= 0);
  });
});

describe('streaming + download 401 self-heal', () => {
  beforeEach(() => {
    writeAuth(now() + 3600, now() + 7 * 24 * 3600, Date.now() + 60 * 60_000);
  });

  it('downloadStream forces a refresh and replays once after a 401', async () => {
    const { downloadStream } = await import('../api.js');
    let hits = 0;
    let refreshed = false;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) { refreshed = true; return refreshOk(); }
      hits += 1;
      if (hits === 1) return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Session expired' } });
      return new Response('FILEBYTES', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const stream = await downloadStream('/files/x');
    let body = '';
    for await (const chunk of stream) body += chunk.toString();
    assert.equal(body, 'FILEBYTES');
    assert.equal(hits, 2, 'the download should be replayed exactly once');
    assert.ok(refreshed, 'a refresh round-trip should have happened');
  });

  it('postForTarEntries forces a refresh and replays once after a 401', async () => {
    const { postForTarEntries } = await import('../api.js');
    const tarBuf = await buildTar();
    let hits = 0;
    let refreshed = false;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) { refreshed = true; return refreshOk(); }
      hits += 1;
      if (hits === 1) return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Session expired' } });
      return new Response(new Uint8Array(tarBuf), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const entries = await postForTarEntries('/tools/browser/screenshot', { url: 'x' });
    assert.equal(hits, 2, 'the tar POST should be replayed exactly once');
    assert.ok(refreshed, 'a refresh round-trip should have happened');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'shot.png');
    assert.equal(entries[0].buffer.toString(), 'PNGDATA');
  });
});
