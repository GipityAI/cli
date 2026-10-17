// App environments, end to end against a real platform (nothing mocked).
// Skipped unless GIPITY_E2E=1. docs-team/product/specs/app-environments.md
//
// The story: a new app deploys prod; `deploy dev` creates an isolated env;
// a new function version and a new migration go to dev while prod keeps
// serving the old ones; a bare deploy is refused once an env exists; the plan
// shows the migration already ran on dev; a destructive migration needs
// --yes-destructive on prod; prod catches up; a staging env starts from prod's
// data; the env's page carries its own app guid; deleting envs and the app
// cleans up.
//
// Each run signs up a fresh `ec-` account (the platform never emails ec-*), so
// its URLs can't collide with anyone's. Cost: free platform CRUD only.
//
//   GIPITY_E2E=1                   enable
//   GIPITY_E2E_API_BASE=...        default https://a.gipity.ai (or a local server)
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';
const RUN = Date.now().toString(36);
const EMAIL = `ec-envs-${RUN}@914-6.com`;

const hello = (v: number) => `export default async function hello() {\n  return { version: ${v} };\n}\n`;

describe('cli-e2e-envs-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const home = makeTmpHome();
  const dir = mkdtempSync(join(tmpdir(), 'gipity-e2e-envs-'));
  const slug = `envs-e2e-${RUN}`;
  const cli = (args: string[], timeout = 120_000) =>
    runCli(['--api-base', API_BASE, ...args], { env: { HOME: home }, cwd: dir, timeout, enableUpdater: false });
  const ok = (args: string[], timeout?: number) => {
    const r = cli(args, timeout);
    assert.equal(r.status, 0, `gipity ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    return r;
  };
  const json = <T = any>(args: string[], timeout?: number): T => {
    const r = ok([...args, '--json'], timeout);
    const lines = r.stdout.trim().split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
    return JSON.parse(lines[lines.length - 1]);
  };
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const failedPhases = (d: { phases?: Array<{ status: string }> }) => (d.phases ?? []).filter((p) => p.status === 'failed');
  let account = '';
  let devGuid = '';

  before(() => {
    ok(['login', '--email', EMAIL, '--code', CODE]);
  });

  after(() => {
    try { cli(['-y', 'project', 'delete', slug]); } catch { /* best effort */ }
    try { cli(['logout']); } catch { /* best effort */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. a new app deploys prod with a bare deploy', () => {
    ok(['init', slug]);
    ok(['add', 'web-fullstack'], 180_000);
    write('functions/hello.js', hello(1));
    write('migrations/001-items.sql', `CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO items (name) SELECT 'seeded' WHERE NOT EXISTS (SELECT 1 FROM items);`);
    const d = json(['deploy']);
    assert.deepEqual(failedPhases(d), []);
    assert.equal(d.env, 'prod');
    assert.match(d.url, new RegExp(`^https://app\\.gipity\\.ai/[^/]+/${slug}/$`));
    account = d.url.split('/')[3];
    assert.equal(json(['fn', 'call', 'hello', '{}']).version, 1);
  });

  it('2. deploy dev creates an isolated env at the bare dev URL', () => {
    const d = json(['deploy', 'dev']);
    assert.deepEqual(failedPhases(d), []);
    assert.equal(d.env, 'dev');
    assert.equal(d.created, true);
    assert.equal(d.url, `https://dev.gipity.ai/${account}/${slug}/`);
    devGuid = d.appGuid;
    assert.ok(devGuid && devGuid !== JSON.parse(ok(['status', '--json']).stdout).project.guid);
  });

  it('3. a new function and migration go to dev; prod keeps the old ones', () => {
    write('functions/hello.js', hello(2));
    write('migrations/002-price.sql', 'ALTER TABLE items ADD COLUMN IF NOT EXISTS price INT;');
    const d = json(['deploy', 'dev']);
    assert.deepEqual(failedPhases(d), []);
    assert.equal(json(['fn', 'call', 'hello', '{}', '--env', 'dev']).version, 2);
    assert.equal(json(['fn', 'call', 'hello', '{}']).version, 1);
    const cols = (envFlag: string[]) => JSON.stringify(json(['db', 'query',
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'items' ORDER BY 1", ...envFlag]));
    assert.match(cols(['--env', 'dev']), /price/);
    assert.doesNotMatch(cols([]), /price/);
  });

  it('4. once an env exists, a bare deploy is refused and names the choices', () => {
    const r = cli(['deploy']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /environments \(dev\)/);
    assert.match(r.stdout + r.stderr, /gipity deploy prod/);
  });

  it('5. the prod plan shows the migration already ran on dev', () => {
    const plan = json(['deploy', 'prod', '--plan']);
    assert.equal(plan.env, 'prod');
    const m = plan.pending.find((p: { file: string }) => /002-price/.test(p.file));
    assert.ok(m, `002-price not pending on prod: ${JSON.stringify(plan)}`);
    assert.deepEqual(m.ranOn.map((r: { env: string }) => r.env), ['dev']);
    assert.deepEqual(m.destructive, []);
  });

  it('6. a destructive migration stops a prod deploy until --yes-destructive', () => {
    write('migrations/003-drop-name.sql', 'ALTER TABLE items DROP COLUMN name;');
    const r = cli(['deploy', 'prod', '--json']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /destroy data/);
    assert.match(r.stdout, /003-drop-name\.sql: drops a column/);
    // Nothing ran: prod still has no price column and still has name.
    const cols = JSON.stringify(json(['db', 'query',
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'items' ORDER BY 1"]));
    assert.match(cols, /"name"/);
    assert.doesNotMatch(cols, /price/);

    const d = json(['deploy', 'prod', '--yes-destructive']);
    assert.deepEqual(failedPhases(d), []);
    assert.equal(json(['fn', 'call', 'hello', '{}']).version, 2);
    const after = JSON.stringify(json(['db', 'query',
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'items' ORDER BY 1"]));
    assert.match(after, /price/);
    assert.doesNotMatch(after, /"name"/);
  });

  it('7. a staging env starts from prod\'s data; writes there stay there', () => {
    ok(['db', 'query', 'INSERT INTO items (price) VALUES (42)']);
    const created = json(['env', 'create', 'staging', '--data']);
    assert.deepEqual(failedPhases(created), []);
    assert.equal(created.url, `https://dev.gipity.ai/${account}/${slug}--staging/`);
    assert.ok(created.data.databases[0].rows >= 2);
    const count = (envFlag: string[]) => JSON.stringify(json(['db', 'query', 'SELECT count(*)::int AS n FROM items', ...envFlag]));
    const before = count([]);
    ok(['db', 'query', 'INSERT INTO items (price) VALUES (7)', '--env', 'staging']);
    assert.equal(count([]), before);
    assert.notEqual(count(['--env', 'staging']), before);
    const list = json(['env', 'list']);
    assert.deepEqual(list.envs.map((e: { name: string }) => e.name), ['dev', 'staging']);
  });

  it('8. the dev page carries the dev env\'s own app guid', async () => {
    const html = await (await fetch(`https://dev.gipity.ai/${account}/${slug}/?cb=${RUN}`)).text();
    assert.match(html, new RegExp(`content="${devGuid}"`));
  });

  it('8b. gipity test runs the working tree in the hidden test env, never over prod', () => {
    write('functions/hello.js', hello(3));
    write('tests/hello.test.js', `test('hello is the working-tree version', async (ctx) => {
  const r = await ctx.fn.call('hello', {});
  assert.equal(r.version, 3);
});
`);
    const r = ok(['test'], 300_000);
    assert.match(r.stdout, /1 passed|passed: 1|✓/);
    // Prod still serves what was deployed, and the test env stays hidden.
    assert.equal(json(['fn', 'call', 'hello', '{}']).version, 2);
    assert.deepEqual(json(['env', 'list']).envs.map((e: { name: string }) => e.name), ['dev', 'staging']);
  });

  it('9. deleting an env takes its URL and data; prod stays', async () => {
    ok(['-y', 'env', 'delete', 'staging']);
    const list = json(['env', 'list']);
    assert.deepEqual(list.envs.map((e: { name: string }) => e.name), ['dev']);
    assert.equal(json(['fn', 'call', 'hello', '{}']).version, 2);
    const r = cli(['fn', 'call', 'hello', '{}', '--env', 'staging']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No environment "staging"/);
  });
});
