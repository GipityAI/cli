/**
 * A non-2xx response whose body isn't JSON (Express's HTML "Cannot POST /x"
 * page for a retired route, a proxy 502) must still produce a readable error.
 * The old fallback used res.statusText, which is always empty over HTTP/2, so
 * `gipity chat` against a removed endpoint printed "Chat failed: " and nothing
 * else.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

let origFetch: typeof globalThis.fetch;
let origApiBase: string | undefined;
let origToken: string | undefined;

before(() => {
  origFetch = globalThis.fetch;
  origApiBase = process.env.GIPITY_API_BASE;
  origToken = process.env.GIPITY_TOKEN;
  process.env.GIPITY_API_BASE = 'https://test.invalid';
  process.env.GIPITY_TOKEN = 'test-token';
});

after(() => {
  globalThis.fetch = origFetch;
  if (origApiBase === undefined) delete process.env.GIPITY_API_BASE; else process.env.GIPITY_API_BASE = origApiBase;
  if (origToken === undefined) delete process.env.GIPITY_TOKEN; else process.env.GIPITY_TOKEN = origToken;
});

// HTTP/2 carries no reason phrase, so statusText is ''.
function htmlResponse(status: number): Response {
  return new Response('<!DOCTYPE html><html><body><pre>Cannot POST /conversations</pre></body></html>', {
    status, statusText: '', headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

describe('API error bodies', () => {
  it('an HTML error names the status and the request instead of an empty message', async () => {
    globalThis.fetch = (async () => htmlResponse(404)) as typeof fetch;
    const { post, ApiError } = await import('../api.js');
    await assert.rejects(post('/conversations', { content: 'hi' }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'UNKNOWN');
      assert.equal(err.message, 'HTTP 404 from POST /conversations');
      return true;
    });
  });

  it('a JSON error keeps the server message and code', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint: POST /conversations' } }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    const { post, ApiError } = await import('../api.js');
    await assert.rejects(post('/conversations', {}), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'NOT_FOUND');
      assert.equal(err.message, 'Unknown endpoint: POST /conversations');
      return true;
    });
  });

  it('the unauthenticated path gets the same fallback', async () => {
    globalThis.fetch = (async () => htmlResponse(502)) as typeof fetch;
    const { publicRequest } = await import('../api.js');
    await assert.rejects(publicRequest('POST', '/auth/verify', {}), { message: 'HTTP 502 from POST /auth/verify' });
  });
});
