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

test('gipity email send --subject --body sends and prints recap', async () => {
  mock.reset();
  mock.on('POST /agent-email/send', { body: { data: {
    to: ['someone@example.com'], cc: [], bcc: [], subject: 'Hi',
  } } });
  const r = await fresh(['email', 'send', '--to', 'someone@example.com', '--subject', 'Hi', '--body', 'Hello there']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Email sent to someone@example\.com: Hi/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity email send omits --to and self-sends (subject/body still required)', async () => {
  mock.reset();
  mock.on('POST /agent-email/send', { body: { data: { to: ['self@example.com'], cc: [], bcc: [], subject: 'Hi' } } });
  const r = await fresh(['email', 'send', '--subject', 'Hi', '--body', 'Hello there']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Email sent to self@example\.com: Hi/);
});

// --- app email() subcommands (test / log) ---

test('gipity email test <to> posts to the app email() path and reports the send', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/email/send', {
    body: { data: { sent: 1, skipped: 0, results: [{ to: 'lead@acme-corp.io', status: 'sent' }] } },
  });
  const r = await fresh(['email', 'test', 'lead@acme-corp.io']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sent to 1 recipient/);
  assert.match(r.stdout, /lead@acme-corp\.io — sent/);
  assert.doesNotMatch(r.stdout, /undefined/);

  const post = mock.requests().find(q => q.method === 'POST' && q.url === '/api/p_TestProj/services/email/send');
  assert.ok(post, 'expected a send request');
  assert.equal((post!.body as { to: string }).to, 'lead@acme-corp.io');
  assert.equal((post!.body as { subject: string }).subject, 'Test email from Gipity');
  assert.ok((post!.body as { text: string }).text);
});

test('gipity email test passes --reply-to and --from-name through to the request', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/email/send', {
    body: { data: { sent: 1, skipped: 0, results: [{ to: 'lead@acme-corp.io', status: 'sent' }] } },
  });
  const r = await fresh([
    'email', 'test', 'lead@acme-corp.io',
    '--subject', 'Hi', '--text', 'Hello there',
    '--reply-to', 'you@yourco.com', '--from-name', 'Acme Sales',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const post = mock.requests().find(q => q.url === '/api/p_TestProj/services/email/send');
  const body = post!.body as { subject: string; text: string; replyTo: string; fromName: string };
  assert.equal(body.subject, 'Hi');
  assert.equal(body.text, 'Hello there');
  assert.equal(body.replyTo, 'you@yourco.com');
  assert.equal(body.fromName, 'Acme Sales');
});

test('gipity email test warns when nothing is sent (all skipped)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/email/send', {
    body: { data: { sent: 0, skipped: 1, results: [{ to: 'blocked@x.io', status: 'blocked', reason: 'test/internal address the platform never emails (ec-* and suppression domains) - use a real inbox to verify delivery' }] } },
  });
  const r = await fresh(['email', 'test', 'blocked@x.io']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing sent/);
  assert.match(r.stdout, /blocked@x\.io — blocked: test\/internal address/);
});

test('gipity email log lists sends AND skipped attempts with recipient + subject', async () => {
  mock.reset();
  mock.on('GET /account/logs/credits', {
    body: { data: {
      totals: { n: 3, credits: 2 },
      items: [
        { created_at: '2026-07-10T10:00:00Z', credits_deducted: '1', detail: { to: 'lead@acme-corp.io', subject: 'Welcome' } },
        { created_at: '2026-07-09T09:00:00Z', credits_deducted: '1', detail: { to: 'other@acme-corp.io', subject: 'Follow up' } },
        { created_at: '2026-07-08T08:00:00Z', credits_deducted: '0', detail: { to: 'ec-probe@914-6.com', subject: 'Test email', status: 'blocked' } },
      ],
    } },
  });
  const r = await fresh(['email', 'log']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 attempts/);
  assert.match(r.stdout, /lead@acme-corp\.io/);
  assert.match(r.stdout, /Welcome/);
  assert.match(r.stdout, /ec-probe@914-6\.com.*\[skipped: blocked\]/);
  assert.doesNotMatch(r.stdout, /undefined/);

  const get = mock.requests().find(q => q.method === 'GET' && q.url.startsWith('/account/logs/credits'));
  assert.ok(get, 'expected a credits-log request');
  assert.match(get!.url, /operations=email_send,email_skip/);
  assert.match(get!.url, /app_guid=p_TestProj/);
});

test('gipity email log prints an empty-state message when there are no sends', async () => {
  mock.reset();
  mock.on('GET /account/logs/credits', { body: { data: { totals: { n: 0, credits: 0 }, items: [] } } });
  const r = await fresh(['email', 'log']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No email\(\) activity/);
});
