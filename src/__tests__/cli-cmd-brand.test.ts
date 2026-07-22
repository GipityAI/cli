import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

const RESOLVED = { accent: '#3b82f6', accentDark: '#204788', themeColor: '#161f2f', glyph: 'G', isEmoji: false };

test('gipity brand shows the resolved spec and asset list', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/brand', { body: { data: {
    branding: {},
    resolved: RESOLVED,
    assets: ['src/images/favicon.ico', 'src/images/og-image.png', 'src/manifest.webmanifest'],
  } } });
  const r = await fresh(['brand']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Glyph:\s+G/);
  assert.match(r.stdout, /#3b82f6/);
  assert.match(r.stdout, /og-image\.png/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity brand set --emoji posts icon_glyph and reports regenerated files', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/brand', { body: { data: {
    branding: { icon_glyph: '🦍' },
    resolved: { ...RESOLVED, glyph: '🦍', isEmoji: true },
    files: ['src/images/favicon.ico', 'src/images/favicon-192.png', 'src/images/og-image.png', 'src/manifest.webmanifest'],
  } } });
  const r = await fresh(['brand', 'set', '--emoji', '🦍']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.method === 'POST' && q.url.endsWith('/projects/p_TestProj/brand'));
  assert.ok(req, 'POST /brand was called');
  assert.equal((req!.body as { icon_glyph?: string }).icon_glyph, '🦍');
  assert.match(r.stdout, /Regenerated 4 assets/);
  assert.match(r.stdout, /gipity deploy dev/);
});

test('gipity brand set with no fields errors out', async () => {
  mock.reset();
  const r = await fresh(['brand', 'set']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Nothing to set/);
});

test('gipity brand apply --fix-head posts fix_head and reports the head update', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/brand', { body: { data: {
    branding: {},
    resolved: RESOLVED,
    files: ['src/images/og-image.png', 'src/manifest.webmanifest', 'src/index.html'],
  } } });
  const r = await fresh(['brand', 'apply', '--fix-head']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.method === 'POST' && q.url.endsWith('/projects/p_TestProj/brand'));
  assert.ok(req, 'POST /brand was called');
  assert.equal((req!.body as { fix_head?: boolean }).fix_head, true);
  assert.match(r.stdout, /src\/index\.html head updated/);
});

test('gipity brand apply re-renders from the stored brand', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/brand', { body: { data: {
    branding: {},
    resolved: RESOLVED,
    files: ['src/images/favicon.ico', 'src/manifest.webmanifest'],
  } } });
  const r = await fresh(['brand', 'apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Regenerated 2 assets/);
});
