/**
 * The API layer's request timeout must be overridable per call. The default
 * 60s cap exists to turn a wedged connection into a fast, clear error - but
 * media generation (music/video/image/speech, `service call` POSTs) can
 * legitimately hold one request open for minutes (a GPU music model
 * cold-starting from scale-to-zero spends 1-3 min loading weights before it
 * renders anything). Those callers pass LONG_REQUEST_TIMEOUT_MS, which must
 * sit just above the server's 300s work ceiling so the server's clearer error
 * always beats the CLI's. Regression guard for EasyClaw#455 (ace-step music
 * cold start killed at exactly 60s by the CLI, not by the gateway).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

let origFetch: typeof globalThis.fetch;
let origApiBase: string | undefined;
let origGipityToken: string | undefined;

before(() => {
  origFetch = globalThis.fetch;
  origApiBase = process.env.GIPITY_API_BASE;
  origGipityToken = process.env.GIPITY_TOKEN;
  process.env.GIPITY_API_BASE = 'https://test.invalid';
  // A static agent token skips the auth.json/refresh machinery entirely -
  // this file is about timeout plumbing, not sessions.
  process.env.GIPITY_TOKEN = 'gip_at_test';
});

after(() => {
  globalThis.fetch = origFetch;
  if (origApiBase === undefined) delete process.env.GIPITY_API_BASE; else process.env.GIPITY_API_BASE = origApiBase;
  if (origGipityToken === undefined) delete process.env.GIPITY_TOKEN; else process.env.GIPITY_TOKEN = origGipityToken;
});

/** A fetch that never responds on its own - it only rejects when the caller's
 *  AbortSignal fires. If no signal (or one that never fires) is wired through,
 *  the test itself times out, so a pass PROVES the per-call cap reached fetch. */
function hangUntilAborted(): typeof globalThis.fetch {
  return ((_input: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, 'request() must pass an AbortSignal to fetch');
      signal!.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        reject(err);
      });
    })) as unknown as typeof globalThis.fetch;
}

/** A fetch that fails like a network error the instant it is called, but first
 *  asserts a deadline was wired in. The buffered-body helpers bound
 *  time-to-first-byte at 30s-310s, so waiting for a real fire would stall the
 *  suite for minutes; asserting the signal REACHES fetch is the regression that
 *  matters, because the bug being guarded is a raw `fetch()` with no signal at
 *  all (which hangs forever on a wedged socket). */
function requiresAbortSignal(seen: string[]): typeof globalThis.fetch {
  return ((input: string | URL, init?: RequestInit) => {
    assert.ok(init?.signal, `${String(input)} must reach fetch with an AbortSignal`);
    seen.push(String(input));
    return Promise.reject(Object.assign(new Error('connection reset'), { name: 'TypeError' }));
  }) as unknown as typeof globalThis.fetch;
}

describe('every buffered-body path carries a deadline', () => {
  // Regression: these four bypassed request()/fetchWithTimeout and called a raw
  // fetch() with no signal. One unbounded call is enough to hang a whole deploy
  // while sync holds .gipity/sync.lock, with no output and no error, forever.
  const cases: Array<[string, (api: any) => Promise<unknown>]> = [
    ['download', api => api.download('/projects/p_x/file')],
    ['downloadWithHeaders', api => api.downloadWithHeaders('/projects/p_x/export')],
    ['postForTarEntries', api => api.postForTarEntries('/tools/browser/screenshot', {})],
    ['publicRequest', api => api.publicRequest('POST', '/api/token', { app: 'p_x' })],
  ];

  for (const [name, call] of cases) {
    it(`${name}() passes an AbortSignal to fetch`, async () => {
      const api = await import('../api.js');
      const seen: string[] = [];
      globalThis.fetch = requiresAbortSignal(seen);

      // Rejects with the stubbed network error, not a hang. The assertion that
      // guards the bug lives inside the stub.
      await assert.rejects(call(api));
      assert.equal(seen.length, 1, 'the call should have reached fetch exactly once');
    });
  }
});

describe('api request() timeout override', () => {
  it('post() honors a per-call timeoutMs instead of the 60s default', async () => {
    const { post, ApiError } = await import('../api.js');
    globalThis.fetch = hangUntilAborted();

    const started = Date.now();
    await assert.rejects(
      post('/api/p_x/services/music', { prompt: 'x' }, { timeoutMs: 100 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as InstanceType<typeof ApiError>).statusCode, 408);
        assert.equal((err as InstanceType<typeof ApiError>).code, 'REQUEST_TIMEOUT');
        return true;
      },
    );
    // Well under the 60s default: the override, not the default, cut it off.
    assert.ok(Date.now() - started < 5_000, 'the 100ms override should have aborted the call');
  });

  it('LONG_REQUEST_TIMEOUT_MS clears the server-side 300s work ceiling', async () => {
    const { LONG_REQUEST_TIMEOUT_MS } = await import('../api.js');
    // The server bounds media generation at 300s (provider fetch budget and ALB
    // idle timeout). The CLI must outlast that so the server's error wins.
    assert.ok(LONG_REQUEST_TIMEOUT_MS > 300_000);
  });
});
