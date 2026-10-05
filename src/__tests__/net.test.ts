import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { describeFetchError } from '../net.js';

// cli#191: in a sandbox whose only way out is an HTTP proxy, Node's fetch()
// ignored HTTP(S)_PROXY and every command died with a bare "fetch failed".

let proxy: http.Server;
let proxyUrl: string;
const seen: string[] = [];
let home: string;

before(async () => {
  // A forward proxy that answers every request as if it were the API. Node
  // reaches it either with the absolute URL as the request target or through a
  // CONNECT tunnel (which one depends on the Node version), so serve both: a
  // tunnel is fed straight back into this same server.
  proxy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ guid: 'sk_Prox0001', name: 'via-proxy', description: 'served by the proxy', scope: 'platform' }] }));
  });
  proxy.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    proxy.emit('connection', socket);
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  home = makeAuthedHome();
});
after(() => { proxy.close(); });

test('requests go through HTTP_PROXY / HTTPS_PROXY from the environment', async () => {
  // The API host does not resolve, so the call can only succeed via the proxy.
  const api = 'http://gipity-proxy-test.invalid';
  const r = await runCliAsync(['--api-base', api, 'skill', 'list'], {
    env: { HOME: home, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
    cwd: makeProjectDir({ apiBase: api }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /via-proxy/);
  assert.ok(seen.includes(`GET ${api}/skills`) || seen.includes('CONNECT gipity-proxy-test.invalid:80'), seen.join(', '));
});

test('a network failure names the host and the cause, not a bare "fetch failed"', async () => {
  // A port nothing listens on: grab a free one, then close it.
  const closed = http.createServer();
  await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>(r => closed.close(() => r()));
  const api = `http://127.0.0.1:${port}`;
  const r = await runCliAsync(['--api-base', api, 'skill', 'list'], {
    env: { HOME: home },
    cwd: makeProjectDir({ apiBase: api }),
  });
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  assert.ok(out.includes(`fetch failed: could not reach ${api} (`), out);
  assert.match(out, /ECONNREFUSED/);
  assert.match(out, /set HTTPS_PROXY/);
});

test('describeFetchError names only the origin (no query secrets) and keeps the cause', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND bucket.example'), { code: 'ENOTFOUND' });
  const err = new TypeError('fetch failed', { cause });
  const out = describeFetchError(err, 'https://bucket.example/obj?X-Signature=secret', true, { HTTPS_PROXY: 'http://user:pw@proxy.corp:3128' }) as TypeError;
  assert.ok(out instanceof TypeError);
  assert.equal(out.cause, cause);
  assert.match(out.message, /^fetch failed: could not reach https:\/\/bucket\.example via proxy http:\/\/proxy\.corp:3128 \(getaddrinfo ENOTFOUND bucket\.example\)\.$/);
  assert.doesNotMatch(out.message, /secret|user|pw@/);
  // Anything that isn't undici's network TypeError passes through untouched.
  const other = new Error('boom');
  assert.equal(describeFetchError(other, 'https://x', false, {}), other);
});
