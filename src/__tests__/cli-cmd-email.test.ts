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

test('gipity email --subject --body sends and prints recap', async () => {
  mock.reset();
  mock.on('POST /agent-email/send', { body: { data: {
    to: ['someone@example.com'], cc: [], bcc: [], subject: 'Hi',
  } } });
  const r = await fresh(['email', '--to', 'someone@example.com', '--subject', 'Hi', '--body', 'Hello there']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Email sent to someone@example\.com: Hi/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity email omits --to and self-sends (subject/body still required)', async () => {
  mock.reset();
  mock.on('POST /agent-email/send', { body: { data: { to: ['self@example.com'], cc: [], bcc: [], subject: 'Hi' } } });
  const r = await fresh(['email', '--subject', 'Hi', '--body', 'Hello there']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Email sent to self@example\.com: Hi/);
});
