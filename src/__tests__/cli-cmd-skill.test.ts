import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
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

// A doc with real structure, reused by the outline/targeted-read tests.
const DOC = [
  '# App Database', '', 'Intro line.', '',
  '## Queries', '', 'Use `gipity db query`.', '',
  '```bash', '# not a heading - inside a fence', 'echo hi', '```', '',
  '## Limits', '', '500 rows / 128 KB per query.', '',
  '### Per statement', '', '50,000 chars.', '',
  '## Migrations', '', 'Each file runs once.',
].join('\n');

function mockDoc(content: string) {
  mock.reset();
  mock.on('GET /skills', { body: { data: [
    { guid: 'sk_TestSkl01', name: 'app-database', description: 'Query the DB', scope: 'platform' },
    { guid: 'sk_TestSkl02', name: 'app-auth', description: 'Sign users in', scope: 'platform' },
  ] } });
  mock.on('GET /skills/sk_TestSkl01', { body: { data: {
    guid: 'sk_TestSkl01', name: 'app-database', description: 'Query the DB', scope: 'platform', content,
  } } });
  mock.on('GET /skills/sk_TestSkl02', { body: { data: {
    guid: 'sk_TestSkl02', name: 'app-auth', description: 'Sign users in', scope: 'platform',
    content: '# App Auth\n\n## Sign in\n\nCall Gipity.login().',
  } } });
}

test('gipity skill read prints a length + section map above the doc', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /app-database.*24 lines/);
  // Section slugs come from the H2s, not the lone H1 and not the fenced `#` line.
  assert.match(r.stdout, /queries, limits, migrations/);
  assert.doesNotMatch(r.stdout, /not-a-heading/);
  assert.match(r.stdout, /Each file runs once\./);
});

test('gipity skill read --toc prints the outline only', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database', '--toc']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /per-statement/);
  assert.doesNotMatch(r.stdout, /Each file runs once\./);
});

test('gipity skill read --section prints one section with its subsections', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database', '--section', 'limits']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /500 rows \/ 128 KB per query/);
  assert.match(r.stdout, /50,000 chars/);          // subsection rides along
  assert.doesNotMatch(r.stdout, /Each file runs once\./);
});

test('gipity skill read --grep prints the matching section, not a bare line', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database', '--grep', '128 KB']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Limits/);
  assert.doesNotMatch(r.stdout, /Use `gipity db query`/);
});

test('gipity skill read --section with no match lists the available sections', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database', '--section', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Sections: app-database, queries, limits/);
});

test('gipity skill read takes several names in one call', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database', 'app-auth']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Each file runs once\./);
  assert.match(r.stdout, /Call Gipity\.login\(\)/);
});

test('gipity skill read --json carries the outline alongside the content', async () => {
  mockDoc(DOC);
  const r = await fresh(['skill', 'read', 'app-database', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.lines, 24);
  assert.ok(doc.sections.some((s: { slug: string }) => s.slug === 'limits'));
  assert.match(doc.content, /Each file runs once\./);
});

test('gipity skill read <kit> falls back to an installed kit README when no skill doc exists', async () => {
  mock.reset();
  // Catalog has no "chatbot" skill.
  mock.on('GET /skills', { body: { data: [
    { guid: 'sk_TestSkl01', name: 'web-app-basics', description: 'Build a web app', scope: 'platform' },
  ] } });
  const dir = makeProjectDir({ apiBase: mock.apiBase, agentGuid: 'a_TestAgnt' });
  const kitDir = join(dir, 'src', 'packages', 'chatbot');
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(join(kitDir, 'package.json'), JSON.stringify({ name: '@gipity/chatbot', gipity: { install: {} } }));
  writeFileSync(join(kitDir, 'README.md'), '# @gipity/chatbot\n\nConfigure persona, scope guardrails, and static knowledge.');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'skill', 'read', 'chatbot'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed kit's README/);
  assert.match(r.stdout, /Configure persona, scope guardrails/);
});

test('gipity skill read <name> still errors when neither a skill nor an installed kit exists', async () => {
  mock.reset();
  mock.on('GET /skills', { body: { data: [
    { guid: 'sk_TestSkl01', name: 'web-app-basics', description: 'Build a web app', scope: 'platform' },
  ] } });
  const r = await fresh(['skill', 'read', 'nonesuch']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
});
