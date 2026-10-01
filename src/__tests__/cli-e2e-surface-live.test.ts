// Real platform e2e: happy-path coverage for every project/app/backend CLI leaf
// command that had no live test. Skipped unless GIPITY_E2E=1.
//
// One throwaway web-fullstack app carries everything: a tiny function, a
// migration (one table, declared as a Records table), a cheap cpu-small bash
// job, a workflow, the notify kit, a static page, and a server-side test.
// Every test parses --json and checks real fields; a command that misbehaves
// is kept asserting the CORRECT behavior and marked `{ todo: 'BUG: ...' }` so
// the suite reports it without failing.
//
// Deliberately NOT covered here (needs a human, real money, or local infra):
//   - payments connect          Stripe-hosted onboarding (only `payments status` runs)
//   - generate video            real per-second Veo cost
//   - realtime bench            spins N simulated controllers against a live room (heavy)
//   - job run-local             needs a local Docker daemon
//   - GPU jobs (gpu-*)          real GPU cost; only a cpu-small bash job runs here
// Account-level commands live in cli-e2e-account-live.test.ts.
//
// Cost profile: a few cents at most. One cpu-small job run of ~1s plus one
// cancelled run, one sandboxed `gipity test` run, one headless page eval, one
// small image + one short TTS clip, one app email() test send (suppressed: the
// `ec` address never reaches the mail provider). Everything else is free CRUD.
// Dev-bypass auth (magic code 914914) with an `ec-` prefixed @914-6.com email.
//
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-e2e@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome, type SpawnResult } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

const RUN_ID = Date.now().toString(36);
const FN = 'e2e-ping';
const FN_DOOMED = 'e2e-doomed';
const TABLE = 'e2e_items';
const JOB = 'e2e-echo';
const WF_NAME = `e2e-wf-${RUN_ID}`;
const WF_PATH = 'workflows/e2e.yaml';
const ROOM = `e2e-room-${RUN_ID}`;
const DB_EXTRA = `e2edb${RUN_ID}`;
const TEST_NAME = 'e2e ping echoes its input';
const PAGE = 'e2e.html';
const PAGE_TITLE = 'E2E Surface Page';

function wfYaml(description: string): string {
  return `name: ${WF_NAME}
description: ${description}
trigger: manual
steps:
  - name: greet
    prompt: "Reply with exactly: ok"
    model_id: claude-haiku-4-5
`;
}

describe('cli-e2e-surface-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-surface-'));
  const scratchDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-surface-scratch-'));
  const projectSlug = `gip-e2e-sf-${RUN_ID}`;
  const env = { HOME: tmpHome };
  // Projects this suite creates besides the main one (project create, load);
  // deleted in after().
  const extraProjects: string[] = [];
  let appUrl = '';

  const cli = (args: string[], opts: { timeout?: number; cwd?: string } = {}): SpawnResult =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: opts.cwd ?? projectDir, timeout: opts.timeout ?? 60000, enableUpdater: false,
    });

  /** Run a command that must succeed and print JSON; return the parsed value. */
  const cliJson = <T = any>(args: string[], opts: { timeout?: number; cwd?: string } = {}): T => {
    const r = cli(args, opts);
    assert.equal(r.status, 0, `\`gipity ${args.join(' ')}\` failed (${r.status}): ${r.stderr || r.stdout}`);
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new Error(`\`gipity ${args.join(' ')}\` did not print JSON on stdout:\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    }
  };

  /** Parse the last JSON line of stdout (tolerates stray log lines above it).
   *  Used where a separate todo test asserts stdout is PURE JSON. */
  const lastJsonLine = <T = any>(r: SpawnResult): T => {
    const line = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{') || l.startsWith('['));
    assert.ok(line, `no JSON line on stdout:\n${r.stdout}`);
    return JSON.parse(line!) as T;
  };
  const isPureJson = (r: SpawnResult): boolean => {
    try { JSON.parse(r.stdout); return true; } catch { return false; }
  };

  before(() => {
    const login = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(login.status, 0, `login failed: ${login.stderr || login.stdout}`);

    const init = cli(['init', projectSlug]);
    assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);

    const add = cli(['add', 'web-fullstack'], { timeout: 120000 });
    assert.equal(add.status, 0, `add web-fullstack failed: ${add.stderr || add.stdout}`);

    // Keep the template's substituted database name; replace the rest of the
    // manifest with every phase this suite exercises.
    const tmplYaml = readFileSync(join(projectDir, 'gipity.yaml'), 'utf-8');
    const dbName = /^\s*database:\s*(\S+)/m.exec(tmplYaml)?.[1];
    assert.ok(dbName, `no database name in the web-fullstack gipity.yaml:\n${tmplYaml}`);

    writeFileSync(join(projectDir, 'gipity.yaml'), `version: 1
deploy:
  phases:
    - name: files
      type: static
      source: src
    - name: database
      type: sql
      source: migrations
      database: ${dbName}
    - name: records
      type: records
      tables:
        - table: ${TABLE}
          auth_level: member
          soft_delete_column: deleted_at
          fields:
            - { name: name, type: text, required: true, title: true }
    - name: functions
      type: functions
      source: functions
      function_definitions:
        - name: ${FN}
          auth: public
        - name: ${FN_DOOMED}
          auth: public
    - name: jobs
      type: jobs
      job_definitions:
        - name: ${JOB}
          handler: jobs/${JOB}/main.sh
          runtime: bash
          compute: cpu-small
          timeout_ms: 180000
          description: E2E echo job (sleeps when input says slow)
`);

    mkdirSync(join(projectDir, 'migrations'), { recursive: true });
    writeFileSync(join(projectDir, 'migrations', '001-e2e-items.sql'), `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ
);
`);

    mkdirSync(join(projectDir, 'functions'), { recursive: true });
    writeFileSync(join(projectDir, 'functions', `${FN}.js`), `export default async function e2e_ping(ctx) {
  console.log('e2e-ping called');
  return { ok: true, echo: ctx.body?.msg ?? null };
}
`);
    writeFileSync(join(projectDir, 'functions', `${FN_DOOMED}.js`), `export default async function e2e_doomed(ctx) {
  return { ok: true };
}
`);

    mkdirSync(join(projectDir, 'tests'), { recursive: true });
    writeFileSync(join(projectDir, 'tests', 'e2e-ping.test.js'), `test(${JSON.stringify(TEST_NAME)}, async (ctx) => {
  const result = await ctx.fn.call('${FN}', { msg: 'hi' });
  assert.equal(result.ok, true);
  assert.equal(result.echo, 'hi');
});
`);

    mkdirSync(join(projectDir, 'jobs', JOB), { recursive: true });
    writeFileSync(join(projectDir, 'jobs', JOB, 'main.sh'), `#!/bin/bash
set -e
echo "e2e-job-start"
case "$GIPITY_RUN_INPUT" in
  *slow*) sleep 150 ;;
esac
echo '{"ok":true}'
`);

    writeFileSync(join(projectDir, 'src', PAGE), `<!doctype html>
<html><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body><p id="marker">e2e-surface</p></body></html>
`);

    mkdirSync(join(projectDir, 'workflows'), { recursive: true });
    writeFileSync(join(projectDir, WF_PATH), wfYaml('E2E surface workflow v1'));

    const deploy = cli(['deploy', 'dev', '--json'], { timeout: 300000 });
    assert.equal(deploy.status, 0, `deploy failed: ${deploy.stderr || deploy.stdout}`);
    const d = JSON.parse(deploy.stdout) as { url?: string };
    assert.ok(d.url, `deploy did not return a url: ${deploy.stdout}`);
    appUrl = d.url.replace(/\/?$/, '/');
  });

  after(() => {
    // Best-effort cleanup; never fail the suite on it.
    try { cli(['-y', 'workflow', 'delete', WF_NAME]); } catch { /* ignore */ }
    try { cli(['realtime', 'room', 'delete', ROOM]); } catch { /* ignore */ }
    try { cli(['db', 'drop', DB_EXTRA, '--yes']); } catch { /* ignore */ }
    for (const slug of extraProjects) {
      try { cli(['-y', 'project', 'delete', slug]); } catch { /* ignore */ }
    }
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── project ──────────────────────────────────────────────────────────

  it('project info --json describes the linked project', () => {
    const p = cliJson(['project', 'info', '--json']);
    assert.equal(p.slug, projectSlug);
    assert.match(p.short_guid, /\w+/);
    assert.ok(['gipity', 'app', 'both'].includes(p.auth_mode), `auth_mode: ${p.auth_mode}`);
  });

  it('project rename changes the display name only', () => {
    const name = `E2E Surface ${RUN_ID}`;
    const r = cliJson(['project', 'rename', name, '--json']);
    assert.equal(r.name, name);
    const p = cliJson(['project', 'info', '--json']);
    assert.equal(p.name, name);
    assert.equal(p.slug, projectSlug, 'rename must not change the slug');
  });

  it('project auth shows, sets, and restores the sign-in mode', () => {
    const shown = cliJson(['project', 'auth', '--json']);
    assert.equal(shown.auth_mode, 'gipity');
    assert.equal(typeof shown.unique_player_names, 'boolean');

    const set = cliJson(['project', 'auth', 'both', '--json']);
    assert.equal(set.auth_mode, 'both');
    assert.equal(cliJson(['project', 'info', '--json']).auth_mode, 'both');

    const back = cliJson(['project', 'auth', 'gipity', '--json']);
    assert.equal(back.auth_mode, 'gipity');
  });

  let projectCreateRun: SpawnResult | null = null;

  it('project create makes a new linked project directory', () => {
    const name = `e2e-pc-${RUN_ID}`;
    extraProjects.push(name); // register for cleanup before anything can throw
    const r = cli(['project', 'create', name, '--json'], { timeout: 90000 });
    projectCreateRun = r;
    assert.equal(r.status, 0, `project create failed: ${r.stderr || r.stdout}`);
    const d = lastJsonLine(r);
    assert.equal(d.created, name);
    assert.match(d.guid, /\w+/);
    assert.ok(existsSync(join(d.dir, '.gipity.json')), `no .gipity.json in ${d.dir}`);
    const list = cliJson<any[]>(['project', '--json']);
    assert.ok(list.some((p) => p.slug === name), 'created project missing from project list');
  });

  it('project create --json prints only JSON on stdout', { todo: 'BUG: finalizeLocalProject setup (Codex hooks line, template-var line) prints to stdout under --json' }, () => {
    assert.ok(projectCreateRun, 'project create did not run');
    assert.ok(isPureJson(projectCreateRun!), `stdout is not pure JSON:\n${projectCreateRun!.stdout}`);
  });

  // ── brand ────────────────────────────────────────────────────────────

  it('brand show --json returns the stored brand and resolved spec', () => {
    const b = cliJson(['brand', 'show', '--json']);
    assert.equal(typeof b.branding, 'object');
    assert.match(b.resolved.accent, /^#[0-9a-f]{6}$/i);
    assert.ok(b.resolved.glyph, 'no resolved glyph');
  });

  it('brand set stores fields and regenerates assets', () => {
    const b = cliJson(['brand', 'set', '--glyph', 'E', '--color', '#3b82f6', '--tagline', 'E2E tagline', '--json'], { timeout: 120000 });
    assert.equal(b.resolved.glyph, 'E');
    assert.equal(b.resolved.accent.toLowerCase(), '#3b82f6');
    assert.equal(b.branding.tagline, 'E2E tagline');
    assert.ok(Array.isArray(b.files) && b.files.length > 0, `no regenerated files: ${JSON.stringify(b)}`);
  });

  it('brand apply re-renders assets from the stored brand', () => {
    const b = cliJson(['brand', 'apply', '--json'], { timeout: 120000 });
    assert.ok(Array.isArray(b.files) && b.files.length > 0, `no regenerated files: ${JSON.stringify(b)}`);
    assert.ok(b.files.some((f: string) => f.startsWith('src/images/')), `no src/images asset: ${b.files}`);
    assert.equal(b.resolved.accent.toLowerCase(), '#3b82f6', 'apply must keep the stored accent');
  });

  // ── page eval ────────────────────────────────────────────────────────

  it('page eval runs JS in the deployed page and returns the value', () => {
    const r = cliJson(['page', 'eval', `${appUrl}${PAGE}`, `document.title + '|' + document.getElementById('marker').textContent`, '--json'], { timeout: 120000 });
    assert.equal(r.result, `${PAGE_TITLE}|e2e-surface`);
  });

  // ── fn / logs ────────────────────────────────────────────────────────

  it('fn call + fn logs shows the invocation and its console output', () => {
    const call = cliJson(['fn', 'call', FN, '{"msg":"logs"}', '--json']);
    assert.equal(call.echo, 'logs');
    const logs = cliJson<any[]>(['fn', 'logs', FN, '--limit', '5', '--json']);
    assert.ok(Array.isArray(logs) && logs.length > 0, 'fn logs returned nothing');
    assert.equal(logs[0].status, 'ok');
    assert.ok((logs[0].logs ?? []).some((l: any) => /e2e-ping called/.test(l.message)), `console line missing: ${JSON.stringify(logs[0])}`);
  });

  it('logs fn --json returns a top-level array of invocations', () => {
    const logs = cliJson<any[]>(['logs', 'fn', FN, '--limit', '5', '--json']);
    assert.ok(Array.isArray(logs) && logs.length > 0);
    assert.ok(logs.every((l) => typeof l.status === 'string' && typeof l.created_at === 'string'));
  });

  it('logs app --json returns the unified activity envelope', () => {
    const d = cliJson(['logs', 'app', '--since', '1h', '--type', 'functions', '--json']);
    assert.ok(Array.isArray(d.entries), `no entries array: ${JSON.stringify(d)}`);
    assert.equal(typeof d.count, 'number');
    assert.ok(Array.isArray(d.types) && d.types.includes('functions'), `types: ${JSON.stringify(d.types)}`);
  });

  it('fn delete removes a deployed function', () => {
    const r = cliJson(['fn', 'delete', FN_DOOMED, '--yes', '--json']);
    assert.equal(r.deleted, true);
    const fns = cliJson<any[]>(['fn', 'list', '--json']);
    assert.ok(!fns.some((f) => f.name === FN_DOOMED), `${FN_DOOMED} still listed after delete`);
    assert.ok(fns.some((f) => f.name === FN), `${FN} should survive`);
  });

  // ── test ─────────────────────────────────────────────────────────────

  let testRunGuid = '';

  it('test list --json lists the test file without running it', () => {
    const d = cliJson(['test', 'list', '--json']);
    assert.ok(d.total >= 1, `no test files: ${JSON.stringify(d)}`);
    assert.ok(d.files.some((f: any) => /e2e-ping\.test\.js$/.test(f.name) || /e2e-ping/.test(f.path + f.name)), JSON.stringify(d.files));
  });

  it('test status <guid> --json re-fetches a finished run', () => {
    const run = cli(['test', '--json'], { timeout: 180000 });
    assert.equal(run.status, 0, `test run failed: ${run.stderr || run.stdout}`);
    const hist = cliJson<any[]>(['test', 'history', '--json']);
    assert.ok(hist.length >= 1, 'no runs in history');
    testRunGuid = hist[0].run_guid;
    assert.match(testRunGuid, /^tr_/);

    const s = cliJson(['test', 'status', testRunGuid, '--json']);
    assert.equal(s.runGuid, testRunGuid);
    assert.equal(s.status, 'passed', JSON.stringify(s));
    assert.ok(s.results.some((t: any) => t.name === TEST_NAME && t.status === 'passed'), JSON.stringify(s.results));
  });

  it('test status rejects an empty run guid locally', { todo: 'BUG: test status "" is sent to the server and fails as "Unknown endpoint: GET /projects/<g>/test/status/"' }, () => {
    const r = cli(['test', 'status', '', '--json']);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr + r.stdout, /Unknown endpoint/, 'empty guid reached the server');
    assert.match(r.stderr + r.stdout, /guid/i);
  });

  // ── db ───────────────────────────────────────────────────────────────

  it('db create + drop manages an extra database', () => {
    const c = cliJson(['db', 'create', DB_EXTRA, '--json']);
    assert.equal(c.success, true);
    const list = cliJson<any[]>(['db', 'list', '--json']);
    assert.ok(list.some((d) => d.friendlyName === DB_EXTRA), `created db not listed: ${JSON.stringify(list)}`);

    const d = cliJson(['db', 'drop', DB_EXTRA, '--yes', '--json']);
    assert.equal(d.success, true);
    const after = cliJson<any[]>(['db', 'list', '--json']);
    assert.ok(!after.some((x) => x.friendlyName === DB_EXTRA), 'dropped db still listed');
  });

  it('db checkpoint + restore undoes writes made after the checkpoint', () => {
    const count = () => Number(cliJson(['db', 'query', `select count(*)::int as n from ${TABLE}`, '--json']).rows[0].n);
    const before = count();

    const cp = cliJson(['db', 'checkpoint', '--json']);
    assert.ok(Array.isArray(cp.tables) && cp.tables.length >= 1, `checkpoint saw no tables: ${JSON.stringify(cp)}`);

    cliJson(['db', 'query', `insert into ${TABLE} (name) values ('checkpoint-probe')`, '--json']);
    assert.equal(count(), before + 1);

    const rs = cliJson(['db', 'restore', '--json']);
    assert.ok(Array.isArray(rs.tables) && rs.tables.length >= 1, JSON.stringify(rs));
    assert.equal(count(), before, 'restore did not roll the insert back');
  });

  // ── key ──────────────────────────────────────────────────────────────

  it('key create / list / revoke round-trip', () => {
    const k = cliJson(['key', 'create', `e2e key ${RUN_ID}`, '--role', 'viewer', '--json']);
    assert.match(k.short_guid, /\w+/);
    assert.equal(k.role, 'viewer');
    assert.ok(typeof k.key === 'string' && k.key.length > 16, 'no key value returned');

    const list = cliJson<any[]>(['key', 'list', '--json']);
    const row = list.find((x) => x.short_guid === k.short_guid);
    assert.ok(row, 'new key not listed');
    assert.equal(row.key, undefined, 'list must never return the key value');

    const rv = cliJson(['key', 'revoke', k.short_guid, '--json']);
    assert.equal(rv.revoked, true);
    const after = cliJson<any[]>(['key', 'list', '--json']);
    assert.ok(!after.some((x) => x.short_guid === k.short_guid), 'revoked key still listed');
  });

  // ── job ──────────────────────────────────────────────────────────────

  let jobRunGuid = '';

  it('job list shows the declared cpu job', () => {
    const jobs = cliJson<any[]>(['job', 'list', '--json']);
    const j = jobs.find((x) => x.name === JOB);
    assert.ok(j, `job ${JOB} not listed: ${JSON.stringify(jobs)}`);
    assert.equal(j.compute, 'cpu-small');
    assert.equal(j.runtime, 'bash');
  });

  it('job submit + wait runs the job to success', () => {
    const s = cliJson(['job', 'submit', JOB, '{"mode":"fast"}', '--json']);
    jobRunGuid = s.run_guid;
    assert.ok(jobRunGuid, `no run_guid: ${JSON.stringify(s)}`);

    const w = cliJson(['job', 'wait', jobRunGuid, '--timeout', '170', '--json'], { timeout: 200000 });
    assert.equal(w.status, 'success', JSON.stringify(w));
  });

  it('job status reports the finished run', () => {
    const s = cliJson(['job', 'status', jobRunGuid, '--json']);
    assert.equal(s.guid, jobRunGuid);
    assert.equal(s.status, 'success');
  });

  it('job logs --no-follow snapshots the run including stdout', () => {
    const r = cliJson(['job', 'logs', jobRunGuid, '--no-follow', '--json']);
    assert.equal(r.guid, jobRunGuid);
    assert.match(JSON.stringify(r), /e2e-job-start/, `stdout not in snapshot: ${JSON.stringify(r)}`);
  });

  it('job runs lists recent runs of the job', () => {
    const runs = cliJson<any[]>(['job', 'runs', JOB, '--json']);
    assert.ok(runs.some((r) => r.guid === jobRunGuid), `run ${jobRunGuid} not listed`);
  });

  it('job cancel stops a running job', () => {
    const s = cliJson(['job', 'submit', JOB, '{"mode":"slow"}', '--json']);
    const guid = s.run_guid;
    assert.ok(guid);
    const c = cliJson(['job', 'cancel', guid, '--json']);
    assert.ok(c && typeof c === 'object', 'cancel printed no JSON object');
    const st = cliJson(['job', 'status', guid, '--json']);
    assert.ok(['cancelled', 'canceled'].includes(st.status), `status after cancel: ${st.status}`);
  });

  // ── workflow ─────────────────────────────────────────────────────────

  it('workflow list --json includes the workflow deploy created from workflows/', () => {
    // The deploy in before() armed workflows/e2e.yaml (the workflows phase is
    // implied); `workflow create --from` itself is covered by cli-e2e-workflow-live.
    const res = cliJson(['workflow', 'list', '--json']);
    const rows = Array.isArray(res) ? res : res.data;
    assert.ok(Array.isArray(rows), `unexpected list shape: ${JSON.stringify(res)}`);
    assert.ok(rows.some((w: any) => w.name === WF_NAME), `workflow ${WF_NAME} not listed: ${JSON.stringify(res)}`);
  });

  it('workflow edit --from updates the workflow from YAML', () => {
    writeFileSync(join(projectDir, WF_PATH), wfYaml('E2E surface workflow v2'));
    const push = cli(['push', WF_PATH]);
    assert.equal(push.status, 0, `push failed: ${push.stderr || push.stdout}`);

    const e = cliJson(['workflow', 'edit', WF_NAME, '--from', WF_PATH, '--json']);
    assert.equal(e.updated, WF_NAME);
    const info = cliJson(['workflow', 'info', WF_NAME, '--json']);
    assert.equal(info.description, 'E2E surface workflow v2');
  });

  // ── approval ─────────────────────────────────────────────────────────

  it('approval create / list / answer resolves a yes-no approval', () => {
    const c = cliJson(['approval', 'create', `E2E approval ${RUN_ID}`, '--description', 'e2e test, safe to ignore', '--json']);
    assert.match(c.guid, /^ap_/);
    const pending = cliJson<any[]>(['approval', 'list', '--json']);
    assert.ok(pending.some((a) => a.guid === c.guid), 'new approval not in pending list');

    const a = cliJson(['approval', 'answer', c.guid, 'a', '--json']);
    assert.equal(a.status, 'approved');
    const approved = cliJson<any[]>(['approval', 'list', '--status', 'approved', '--json']);
    assert.ok(approved.some((x) => x.guid === c.guid), 'answered approval not listed as approved');
  });

  it('approval cancel withdraws a pending approval', () => {
    const c = cliJson(['approval', 'create', `E2E cancel ${RUN_ID}`, '--json']);
    const r = cliJson(['approval', 'cancel', c.guid, '--json']);
    assert.equal(r.cancelled, true);
    const pending = cliJson<any[]>(['approval', 'list', '--json']);
    assert.ok(!pending.some((a) => a.guid === c.guid), 'cancelled approval still pending');
  });

  // ── memory / service ─────────────────────────────────────────────────

  it('memory list --json shows a written topic', () => {
    const topic = `e2e-list-${RUN_ID}`;
    cliJson(['memory', 'write', topic, 'hello', '--json']);
    const list = cliJson<any[]>(['memory', 'list', '--json']);
    const m = list.find((x) => x.topic === topic);
    assert.ok(m, 'topic not listed');
    assert.equal(m.content, 'hello');
    cli(['-y', 'memory', 'delete', topic]);
  });

  it('service list --json names the callable services', () => {
    const s = cliJson<any[]>(['service', 'list', '--json']);
    for (const name of ['llm', 'image', 'tts']) {
      assert.ok(s.some((x) => x.name === name), `service ${name} missing`);
    }
  });

  // ── generate (cheapest model, one call each) ─────────────────────────

  it('generate image writes a real image (cheapest BFL model, 512px)', () => {
    const out = join(scratchDir, 'e2e.png');
    const r = cliJson(['generate', 'image', 'a small red circle on white', '--provider', 'bfl', '--model', 'flux-2-klein-4b', '--size', '512x512', '-o', out, '--json'], { timeout: 180000 });
    assert.match(r.url ?? '', /^https?:\/\//);
    assert.ok(existsSync(out) && statSync(out).size > 1000, `no image at ${out}`);
  });

  it('generate speech writes a real audio clip (openai, one voice, two words)', () => {
    const out = join(scratchDir, 'e2e.mp3');
    const r = cliJson(['generate', 'speech', 'Hello there.', '--provider', 'openai', '--voice', 'alloy', '-o', out, '--json'], { timeout: 120000 });
    assert.match(r.url ?? '', /^https?:\/\//);
    assert.ok(existsSync(out) && statSync(out).size > 1000, `no audio at ${out}`);
  });

  it('generate speech --provider openai works without --voice', { todo: 'BUG: /generate/speech defaults voice to the ElevenLabs Kristen id for every provider, so openai 400s' }, () => {
    const out = join(scratchDir, 'e2e-default-voice.mp3');
    const r = cliJson(['generate', 'speech', 'Hi.', '--provider', 'openai', '-o', out, '--json'], { timeout: 120000 });
    assert.match(r.url ?? '', /^https?:\/\//);
  });

  // ── notify (kit) / remove ────────────────────────────────────────────

  it('add notify installs the kit, then notify subs reports zero subscriptions', () => {
    const add = cli(['add', 'notify'], { timeout: 120000 });
    assert.equal(add.status, 0, `add notify failed: ${add.stderr || add.stdout}`);
    assert.ok(existsSync(join(projectDir, 'src', 'packages', 'notify')), 'kit files missing');
    const s = cliJson(['notify', 'subs', '--json']);
    assert.equal(s.total, 0);
    assert.deepEqual(s.byUser, []);
  });

  it('notify test with no subscribers sends to zero devices', () => {
    const r = cliJson(['notify', 'test', '--title', 'E2E', '--body', 'e2e test', '--json']);
    assert.equal(r.sent, 0);
    assert.equal(typeof r.failed, 'number');
  });

  it('remove notify uninstalls the kit', () => {
    const r = cliJson(['remove', 'notify', '--json'], { timeout: 120000 });
    assert.equal(r.kit, 'notify');
    assert.ok(Array.isArray(r.removed) && r.removed.length > 0, JSON.stringify(r));
    assert.ok(!existsSync(join(projectDir, 'src', 'packages', 'notify')), 'kit dir still on disk after remove');
  });

  // ── domain (list only; add/verify need real DNS) ─────────────────────

  it('domain list --json returns this project\'s custom domains', () => {
    const d = cliJson(['domain', 'list', '--json']);
    assert.ok(Array.isArray(d), JSON.stringify(d));
    assert.equal(d.length, 0, 'a fresh project has no custom domains');
  });

  // ── payments / realtime ──────────────────────────────────────────────

  it('payments status --json reports an unconnected app', () => {
    const s = cliJson(['payments', 'status', '--json']);
    assert.equal(s.connected, false);
  });

  it('realtime room create / list / info / delete', () => {
    const c = cliJson(['realtime', 'room', 'create', ROOM, '--type', 'relay', '--max-clients', '4', '--json']);
    assert.equal(c.name, ROOM);
    assert.equal(c.room_type, 'relay');
    assert.equal(c.max_clients, 4);

    const list = cliJson<any[]>(['realtime', 'room', 'list', '--json']);
    assert.ok(list.some((r) => r.name === ROOM), 'room not listed');

    const info = cliJson(['realtime', 'room', 'info', ROOM, '--json']);
    assert.equal(info.room.name, ROOM);

    const d = cliJson(['realtime', 'room', 'delete', ROOM, '--json']);
    assert.equal(d.success, true);
    const after = cliJson<any[]>(['realtime', 'room', 'list', '--json']);
    assert.ok(!after.some((r) => r.name === ROOM), 'deleted room still listed');
  });

  // ── records ──────────────────────────────────────────────────────────

  let recordId = '';

  it('records list shows the table declared in gipity.yaml', () => {
    const t = cliJson<any[]>(['records', 'list', '--json']);
    const row = t.find((x) => x.table_name === TABLE);
    assert.ok(row, `table ${TABLE} not configured: ${JSON.stringify(t)}`);
    assert.equal(row.auth_level, 'member');
  });

  it('records config shows and sets the table config', () => {
    const shown = cliJson(['records', 'config', TABLE, '--json']);
    assert.equal(shown.auth_level, 'member');
    const set = cliJson(['records', 'config', TABLE, '--searchable', 'true', '--json']);
    assert.equal(set.searchable, true);
  });

  it('records create / get / update', () => {
    const c = cliJson(['records', 'create', TABLE, '--data', '{"name":"alpha"}', '--json']);
    assert.equal(c.name, 'alpha');
    recordId = String(c.id);
    assert.ok(recordId && recordId !== 'undefined');

    const g = cliJson(['records', 'get', TABLE, recordId, '--json']);
    assert.equal(g.name, 'alpha');

    const u = cliJson(['records', 'update', TABLE, recordId, '--data', '{"name":"beta"}', '--json']);
    assert.equal(u.name, 'beta');
  });

  it('records query finds the record', () => {
    const q = cliJson(['records', 'query', TABLE, '--filter', 'name:eq:beta', '--json']);
    assert.equal(q.meta.total, 1);
    assert.equal(String(q.data[0].id), recordId);
  });

  it('records history shows create + update with English summaries', () => {
    const h = cliJson<any[]>(['records', 'history', TABLE, recordId, '--json']);
    const actions = h.map((e) => e.action);
    assert.ok(actions.includes('create') && actions.includes('update'), `actions: ${actions}`);
    assert.ok(h.every((e) => typeof e.detail?.summary === 'string'), JSON.stringify(h));
  });

  it('records delete soft-deletes and restore brings it back', () => {
    cliJson(['-y', 'records', 'delete', TABLE, recordId, '--json']);
    const bin = cliJson(['records', 'query', TABLE, '--only-deleted', '--json']);
    assert.ok(bin.data.some((r: any) => String(r.id) === recordId), 'row not in the recycle bin');

    cliJson(['records', 'restore', TABLE, recordId, '--json']);
    const live = cliJson(['records', 'query', TABLE, '--json']);
    assert.ok(live.data.some((r: any) => String(r.id) === recordId), 'restored row not live');

    const p = cliJson(['-y', 'records', 'delete', TABLE, recordId, '--purge', '--json']);
    assert.equal(p.purged, true);
  });

  // ── rbac / audit ─────────────────────────────────────────────────────

  it('rbac create / list / delete a policy', () => {
    const c = cliJson(['rbac', 'create', TABLE, '--role', 'viewer', '--op', 'select', '--condition', 'id > 0', '--json']);
    assert.ok(c && typeof c === 'object');
    const list = cliJson<any[]>(['rbac', 'list', '--json']);
    assert.ok(list.some((p) => p.table_name === TABLE && p.role === 'viewer' && p.operation === 'select'), JSON.stringify(list));

    const d = cli(['-y', 'rbac', 'delete', TABLE, '--role', 'viewer', '--op', 'select']);
    assert.equal(d.status, 0, `rbac delete failed: ${d.stderr || d.stdout}`);
    const after = cliJson<any[]>(['rbac', 'list', '--json']);
    assert.ok(!after.some((p) => p.table_name === TABLE && p.role === 'viewer' && p.operation === 'select'), 'policy survived delete');
  });

  it('audit list + count see the record writes', () => {
    const list = cliJson<any[]>(['audit', 'list', '--limit', '50', '--json']);
    assert.ok(Array.isArray(list) && list.length > 0, 'no audit events after record writes');
    assert.ok(list.every((e) => typeof e.event_type === 'string'));
    const n = cliJson(['audit', 'count', '--json']);
    assert.ok(typeof n.count === 'number' && n.count >= list.length, JSON.stringify(n));
  });

  // ── files / upload ───────────────────────────────────────────────────

  it('file ls / tree list the project tree', () => {
    const ls = cliJson<any[]>(['file', 'ls', '--json']);
    assert.ok(ls.some((f) => f.name === 'src' && f.type === 'directory'), JSON.stringify(ls));
    const lsSrc = cliJson<any[]>(['file', 'ls', 'src', '--json']);
    assert.ok(lsSrc.some((f) => f.name === PAGE && f.type === 'file'), JSON.stringify(lsSrc));
    const tree = cliJson<any[]>(['file', 'tree', '--json']);
    assert.ok(tree.some((f) => f.path === `src/${PAGE}`), 'src/e2e.html missing from the root tree');
  });

  it('file tree <dir> lists paths relative to the directory', { todo: 'BUG: file tree <dir> drops the first character of every path (e2e.html -> 2e.html): off-by-one prefix strip in vfs findFilesWithMeta' }, () => {
    const tree = cliJson<any[]>(['file', 'tree', 'src', '--json']);
    assert.ok(tree.some((f) => f.path === PAGE), `paths: ${tree.map((f) => f.path).join(', ')}`);
  });

  it('file url returns a URL', () => {
    const u = cliJson(['file', 'url', `src/${PAGE}`, '--json']);
    assert.match(u.url, /^https:\/\//);
    assert.match(u.file_guid, /^fl_/);
  });

  it('file url serves the file content', { todo: 'BUG: /api/:app/files/:guid/serve redirects to the media bucket, but project-file blobs live on the VFS volume: 404 NoSuchKey' }, async () => {
    const u = cliJson(['file', 'url', `src/${PAGE}`, '--json']);
    const res = await fetch(u.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(PAGE_TITLE));
  });

  it('file rm deletes a remote file', () => {
    mkdirSync(join(projectDir, 'scratch'), { recursive: true });
    writeFileSync(join(projectDir, 'scratch', 'doomed.txt'), 'bye\n');
    const push = cli(['push', 'scratch/doomed.txt']);
    assert.equal(push.status, 0, `push failed: ${push.stderr || push.stdout}`);
    assert.ok(cliJson<any[]>(['file', 'ls', 'scratch', '--json']).some((f) => f.name === 'doomed.txt'));

    cliJson(['file', 'rm', 'scratch/doomed.txt', '--json']);
    const after = cli(['file', 'ls', 'scratch', '--json']);
    const rows = after.status === 0 ? JSON.parse(after.stdout) as any[] : [];
    assert.ok(!rows.some((f) => f.name === 'doomed.txt'), 'file still listed after rm');
  });

  it('upload returns a durable URL that serves the exact bytes', async () => {
    const content = `e2e upload ${RUN_ID}\n`;
    const file = join(scratchDir, `e2e-upload-${RUN_ID}.txt`);
    writeFileSync(file, content);
    const u = cliJson(['upload', file, '--json']);
    assert.equal(u.is_public, true);
    assert.match(u.url, /^https:\/\//);
    const res = await fetch(u.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), content);
  });

  // ── save / load ──────────────────────────────────────────────────────

  let gipPath = '';

  it('save writes a .gip bundle', () => {
    const r = cliJson(['save', scratchDir, '--json'], { timeout: 120000 });
    gipPath = r.path;
    assert.ok(gipPath.endsWith('.gip'), gipPath);
    assert.ok(existsSync(gipPath) && statSync(gipPath).size === r.bytes);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.ok(r.entries > 3, `too few entries: ${r.entries}`);
  });

  it('load --inspect peeks inside the bundle without creating anything', () => {
    const r = cliJson(['load', gipPath, '--inspect', '--json'], { timeout: 120000 });
    assert.ok(r.fileCount > 3);
    assert.equal(r.manifest.found, true);
    assert.equal(r.manifest.valid, true);
    assert.ok(r.manifest.functions.some((f: any) => f.name === FN), JSON.stringify(r.manifest));
  });

  let loadRun: SpawnResult | null = null;

  it('load creates a NEW project from the bundle', () => {
    const name = `e2e-load-${RUN_ID}`;
    extraProjects.push(name); // register for cleanup before anything can throw
    const r = cli(['load', gipPath, '--name', name, '--json'], { timeout: 180000 });
    loadRun = r;
    assert.equal(r.status, 0, `load failed: ${r.stderr || r.stdout}`);
    const d = lastJsonLine(r);
    if (d.created !== name) extraProjects.push(d.created);
    assert.notEqual(d.created, projectSlug, 'load must never reuse the source project');
    assert.equal(d.name, name);
    assert.ok(d.written > 3, `wrote ${d.written} files`);
    assert.equal(d.partial, false);
    assert.ok(existsSync(join(d.dir, 'gipity.yaml')), 'gipity.yaml not pulled into the new project dir');
    assert.ok(existsSync(join(d.dir, 'functions', `${FN}.js`)), 'function not pulled into the new project dir');
  });

  it('load --json prints only JSON on stdout', { todo: 'BUG: finalizeLocalProject setup (Codex hooks line) prints to stdout under --json' }, () => {
    assert.ok(loadRun, 'load did not run');
    assert.ok(isPureJson(loadRun!), `stdout is not pure JSON:\n${loadRun!.stdout}`);
  });
});
