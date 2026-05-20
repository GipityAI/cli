import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function run(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

test('gipity gmail search shows matching messages', async () => {
  mock.reset();
  mock.on('GET /gmail/search', { body: { data: [
    { id: '17a1b', from: 'alice@example.com', subject: 'Lunch?', snippet: 'Hey are you free' },
  ] } });
  const r = await run(['gmail', 'search', 'lunch']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /17a1b/);
  assert.match(r.stdout, /Lunch\?/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity gmail read <id> prints message JSON', async () => {
  mock.reset();
  mock.on('GET /gmail/17a1b', { body: { data: { id: '17a1b', body: 'Hello world' } } });
  const r = await run(['gmail', 'read', '17a1b']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hello world/);
});

test('gipity gmail send posts and prints sent confirmation', async () => {
  mock.reset();
  mock.on('POST /gmail/send', { body: { data: { sent: true } } });
  const r = await run(['gmail', 'send', '--to', 'a@b.c', '--subject', 'Hi', '--body', 'Hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sent from your Gmail to a@b\.c/);
});

test('gipity gmail reply posts and prints reply confirmation', async () => {
  mock.reset();
  mock.on('POST /gmail/reply', { body: { data: { sent: true } } });
  const r = await run([
    'gmail', 'reply',
    '--thread-id', 't1', '--message-id', 'm1',
    '--to', 'a@b.c', '--subject', 'Re: Hi', '--body', 'OK',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Reply sent/);
});
