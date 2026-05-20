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
  const d = makeProjectDir({ apiBase: mock.apiBase, agentGuid: 'a_TestAgnt' });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity skill list shows available skills with description', async () => {
  mock.reset();
  mock.on('GET /skills', { body: { data: [
    { guid: 'sk_TestSkl01', name: 'web-app-basics', description: 'Build a web app', scope: 'platform' },
    { guid: 'sk_TestSkl02', name: 'deploy', description: 'Ship your app', scope: 'platform' },
  ] } });
  const r = await fresh(['skill', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /web-app-basics/);
  assert.match(r.stdout, /Build a web app/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity skill read <name> prints content', async () => {
  mock.reset();
  mock.on('GET /skills', { body: { data: [
    { guid: 'sk_TestSkl01', name: 'web-app-basics', description: 'Build a web app', scope: 'platform' },
  ] } });
  mock.on('GET /skills/sk_TestSkl01', { body: { data: {
    guid: 'sk_TestSkl01', name: 'web-app-basics', description: 'Build a web app', scope: 'platform',
    content: '# Web App Basics\n\nDeploy with `gipity deploy dev`.',
  } } });
  const r = await fresh(['skill', 'read', 'web-app-basics']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Web App Basics/);
  assert.match(r.stdout, /gipity deploy dev/);
});
