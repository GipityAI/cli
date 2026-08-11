/**
 * The token refresh must never hang without a deadline.
 *
 * `refreshTokenIfNeeded()` sits on the critical path of EVERY authenticated
 * command: api.ts resolves its bearer token through it before the first byte of
 * a sync, deploy, or sandbox run leaves the machine. It used to call a raw
 * `fetch()` with no signal, so a wedged socket (connected, then silent - a
 * dropped NAT flow, a black-holed path) hung the whole CLI forever: no output,
 * no error at any timeout, and sync already holding .gipity/sync.lock. Because
 * the access token lives 1h and refresh only fires inside a 5-min buffer before
 * expiry, this presented as an *intermittent* "deploy just stalls silently"
 * that no amount of retrying could clear.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let authDir: string;
let origFetch: typeof globalThis.fetch;
let origApiBase: string | undefined;
let origGipityToken: string | undefined;

/** A JWT the CLI's decodeJwtExp can read. Only `exp` matters here. */
function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }))
    .toString('base64url');
  return `h.${payload}.s`;
}

before(() => {
  origFetch = globalThis.fetch;
  origApiBase = process.env.GIPITY_API_BASE;
  origGipityToken = process.env.GIPITY_TOKEN;
  // AUTH_DIR is captured from GIPITY_DIR at module load, so set it before import.
  authDir = mkdtempSync(join(tmpdir(), 'gipity-auth-refresh-test-'));
  process.env.GIPITY_DIR = authDir;
  process.env.GIPITY_API_BASE = 'https://test.invalid';
  // Prove the deadline fires without waiting out 3 x the real 15s budget.
  process.env.GIPITY_REFRESH_TIMEOUT_MS = '150';
  // A static agent token would skip the refresh machinery entirely - that is
  // exactly the path under test, so make sure it is not set.
  delete process.env.GIPITY_TOKEN;

  // Access token already lapsed (forces the refresh), refresh token still live
  // (so the flow reaches the network instead of bailing out to re-login).
  writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
    accessToken: jwt(-60),
    refreshToken: jwt(7 * 24 * 3600),
    email: 'test@914-6.com',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }));
});

after(() => {
  globalThis.fetch = origFetch;
  delete process.env.GIPITY_DIR;
  delete process.env.GIPITY_REFRESH_TIMEOUT_MS;
  if (origApiBase === undefined) delete process.env.GIPITY_API_BASE; else process.env.GIPITY_API_BASE = origApiBase;
  if (origGipityToken === undefined) delete process.env.GIPITY_TOKEN; else process.env.GIPITY_TOKEN = origGipityToken;
  rmSync(authDir, { recursive: true, force: true });
});

describe('refreshTokenIfNeeded network deadline', () => {
  it('sends every /auth/refresh attempt with an AbortSignal', async () => {
    const { refreshTokenIfNeeded } = await import('../auth.js');

    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
      assert.ok(String(input).endsWith('/auth/refresh'), 'should hit the refresh endpoint');
      signals.push(init?.signal);
      // Fail fast like a reset connection so the retry loop runs without waiting
      // out the real deadline. The guard is that a deadline was attached at all.
      return Promise.reject(Object.assign(new Error('connection reset'), { name: 'TypeError' }));
    }) as unknown as typeof globalThis.fetch;

    // Retries are exhausted internally and the existing token is left in place -
    // this resolves rather than throwing, and must not hang.
    await refreshTokenIfNeeded();

    assert.ok(signals.length > 0, 'the refresh must actually reach fetch');
    for (const signal of signals) {
      assert.ok(signal, 'every /auth/refresh attempt must carry an AbortSignal');
    }
  });

  it('aborts a refresh that connects and then goes silent', async () => {
    const { refreshTokenIfNeeded } = await import('../auth.js');

    let aborts = 0;
    // Never settles on its own: only the CLI's own deadline can end this. If no
    // signal is wired through, this test hangs and fails - which is precisely
    // the production failure being guarded.
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, 'a hung refresh must be abortable');
        signal!.addEventListener('abort', () => {
          aborts++;
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      })) as unknown as typeof globalThis.fetch;

    const started = Date.now();
    await refreshTokenIfNeeded();
    const elapsed = Date.now() - started;

    assert.ok(aborts > 0, 'the wedged refresh must be aborted by its own deadline');
    // Bounded by the (here shortened) per-attempt budget plus backoff, rather
    // than running until the process is killed.
    assert.ok(elapsed < 30_000, `refresh should be bounded, took ${elapsed}ms`);
  });
});
