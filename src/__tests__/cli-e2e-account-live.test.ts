// Real platform e2e: happy-path coverage for the account-level CLI commands
// (no linked project needed; project-scoped ones fall back to the account's
// Home project, exactly as they do for a user outside a project dir).
// Skipped unless GIPITY_E2E=1.
//
// Deliberately NOT covered (needs a human, real money, or local tooling):
//   - gmail *                      needs a real Google OAuth grant
//   - github connect/repos/disconnect  GitHub App install flow (OAuth); only `github status` runs
//   - payments connect             Stripe-hosted onboarding
//   - credits buy / credits manage Stripe checkout / billing portal
//   - generate video               real per-second Veo cost
//   - realtime bench               heavy multi-client load
//   - job run-local                needs a local Docker daemon
//   - update                       replaces the installed CLI
//   - build                        interactive TUI
// Project/app/backend commands live in cli-e2e-surface-live.test.ts.
//
// Cost profile: effectively free. One agent `email send` and one app
// `email test` to an `ec-` @914-6.com address, which the platform suppresses
// before the mail provider; everything else is reads and tiny CRUD. Uses
// dev-bypass auth (magic code 914914).
//
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-e2e@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome, type SpawnResult } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';
// Outbound mail target: `ec` prefix so the platform suppresses real delivery.
const MAIL_TO = 'ec-cli-e2e-mail@914-6.com';

if (E2E_ENABLED && (!EMAIL.startsWith('ec') || !MAIL_TO.startsWith('ec'))) {
  throw new Error(`E2E test emails must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

const RUN_ID = Date.now().toString(36);

describe('cli-e2e-account-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  // Deliberately NOT a project dir: account commands must work from anywhere.
  const workDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-account-'));
  const env = { HOME: tmpHome };

  const cli = (args: string[], opts: { timeout?: number } = {}): SpawnResult =>
    runCli(['--api-base', API_BASE, ...args], {
      env, cwd: workDir, timeout: opts.timeout ?? 60000, enableUpdater: false,
    });

  const cliJson = <T = any>(args: string[], opts: { timeout?: number } = {}): T => {
    const r = cli(args, opts);
    assert.equal(r.status, 0, `\`gipity ${args.join(' ')}\` failed (${r.status}): ${r.stderr || r.stdout}`);
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new Error(`\`gipity ${args.join(' ')}\` did not print JSON on stdout:\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    }
  };

  before(() => {
    const login = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(login.status, 0, `login failed: ${login.stderr || login.stdout}`);
  });

  after(() => {
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── token ────────────────────────────────────────────────────────────

  it('token create / list / revoke round-trip', () => {
    const name = `e2e token ${RUN_ID}`;
    const c = cliJson(['token', 'create', '--name', name, '--expires', '1', '--json']);
    assert.match(c.token, /^gip_at_/);
    const guid = c.shortGuid ?? c.short_guid;
    assert.ok(guid, `no token guid: ${JSON.stringify(c)}`);

    const list = cliJson<any[]>(['token', 'list', '--json']);
    const row = list.find((t) => t.short_guid === guid);
    assert.ok(row, 'new token not listed');
    assert.equal(row.name, name);
    assert.equal(row.token, undefined, 'list must never return the token value');

    const rv = cliJson(['token', 'revoke', guid, '--json']);
    assert.equal(rv.revoked, true);
    const after = cliJson<any[]>(['token', 'list', '--json']);
    assert.ok(!after.some((t) => t.short_guid === guid), 'revoked token still listed');
  });

  it('token create --json uses the same guid key as token list', { todo: 'BUG: token create --json returns camelCase shortGuid/expiresAt while token list (and key create/list) use short_guid/expires_at' }, () => {
    const c = cliJson(['token', 'create', '--name', `e2e shape ${RUN_ID}`, '--expires', '1', '--json']);
    const guid = c.shortGuid ?? c.short_guid;
    try {
      assert.ok(c.short_guid, `token create --json has no short_guid: ${Object.keys(c).join(',')}`);
    } finally {
      if (guid) cli(['token', 'revoke', guid]);
    }
  });

  // ── credits / storage ────────────────────────────────────────────────

  it('credits list --json compares plans', () => {
    const d = cliJson(['credits', 'list', '--json']);
    assert.equal(typeof d.currentTier, 'string');
    assert.ok(Array.isArray(d.plans) && d.plans.length >= 1);
    assert.ok(d.plans.some((p: any) => p.tier === d.currentTier), 'current tier not among plans');
    assert.ok(Array.isArray(d.products));
  });

  it('credits usage --json returns usage rows', () => {
    const rows = cliJson<any[]>(['credits', 'usage', '--limit', '5', '--json']);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length <= 5);
    for (const u of rows) {
      assert.equal(typeof u.operation, 'string');
      assert.equal(typeof u.createdAt, 'string');
      // Provider cost is margin data and must never reach end users.
      assert.ok(!('costUsd' in u) && !('cost_usd' in u), `provider cost leaked: ${JSON.stringify(u)}`);
    }
  });

  it('storage usage --json reports quota and breakdown', () => {
    const d = cliJson(['storage', 'usage', '--json']);
    assert.ok(d.quotaBytes > 0);
    assert.equal(typeof d.usedBytes, 'number');
    assert.equal(typeof d.storage.liveBytes, 'number');
    assert.ok(Array.isArray(d.projects));
    assert.equal(typeof d.projectTotals.count, 'number');
  });

  it('storage retention --json shows the policy (read only)', () => {
    const r = cliJson(['storage', 'retention', '--json']);
    assert.ok(r.days >= 1 && r.days <= r.maxDays, JSON.stringify(r));
    assert.ok(r.count >= 1 && r.count <= r.maxCount, JSON.stringify(r));
    assert.equal(typeof r.customDays, 'boolean');
  });

  // ── bug ──────────────────────────────────────────────────────────────

  it('bug report / list / retract round-trip', () => {
    const r = cliJson(['bug', 'report', '--category', 'other', '--severity', 'S4',
      '--summary', `CLI e2e test ${RUN_ID} ignore`,
      '--detail', 'Automated CLI e2e test report. Retracted immediately; not a real bug.', '--json']);
    const id = r.report_guid;
    assert.ok(id, `no report_guid: ${JSON.stringify(r)}`);

    const list = cliJson<any[]>(['bug', 'list', '--json']);
    const row = list.find((b) => b.report_guid === id);
    assert.ok(row, 'filed report not listed');
    assert.equal(row.category, 'other');
    assert.equal(row.severity, 'S4');

    const x = cliJson(['bug', 'retract', id, '--reason', 'automated e2e test', '--json']);
    assert.equal(x.report_guid, id);
    assert.match(x.status, /retract|withdrawn|dismiss/i);
  });

  // ── github / domain / skill ──────────────────────────────────────────

  it('github status --json reports the connection state', () => {
    const s = cliJson(['github', 'status', '--json']);
    assert.equal(typeof s.connected, 'boolean');
  });

  it('domain list --all --json returns the account domain summary', () => {
    const d = cliJson(['domain', 'list', '--all', '--json']);
    assert.ok(Array.isArray(d.domains));
    assert.equal(typeof d.count, 'number');
    assert.equal(typeof d.limit, 'number');
  });

  it('skill list --json names the catalog', () => {
    const s = cliJson<any[]>(['skill', 'list', '--json']);
    assert.ok(s.length > 5);
    assert.ok(s.some((x) => x.name === 'jobs'), 'jobs skill missing');
    assert.ok(s.every((x) => typeof x.description === 'string'));
  });

  it('skill read --json returns the doc with its section outline', () => {
    const d = cliJson(['skill', 'read', 'jobs', '--json']);
    assert.equal(d.name, 'jobs');
    assert.match(d.content, /Declaring a job/);
    assert.ok(Array.isArray(d.sections) && d.sections.some((s: any) => /declaring-a-job/.test(s.slug)), JSON.stringify(d.sections?.slice(0, 5)));
  });

  it('skill read --section prints only that section', () => {
    const r = cli(['skill', 'read', 'jobs', '--section', 'compute-classes']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /cpu-small/);
    assert.doesNotMatch(r.stdout, /## Handler contract/);
  });

  // ── location / text ──────────────────────────────────────────────────

  it('location <ip> geolocates a public IP', () => {
    const d = cliJson(['location', '8.8.8.8', '--json']);
    assert.equal(d.source, 'ip');
    assert.equal(d.ip, '8.8.8.8');
    assert.ok(d.country, JSON.stringify(d));
  });

  it('location <lat> <lng> reverse-geocodes', () => {
    const d = cliJson(['location', '48.8584', '2.2945', '--json']);
    assert.equal(d.source, 'coords');
    assert.match(`${d.city} ${d.country}`, /Paris|France|FR/i, JSON.stringify(d));
  });

  it('location (no args) resolves this machine', () => {
    const d = cliJson(['location', '--json']);
    assert.ok(d && typeof d === 'object', 'no location object');
    assert.ok(d.country || d.city || d.timezone, JSON.stringify(d));
  });

  it('text analyze counts words and characters locally', () => {
    const d = cliJson(['text', 'analyze', 'hello world hello', '--json']);
    assert.equal(d.words, 3, JSON.stringify(d));
    assert.equal(d.characters, 17);
    assert.equal(d.uniqueWords, 2);
    assert.deepEqual(d.wordFrequency[0], { word: 'hello', count: 2 });
    const c = cliJson(['text', 'analyze', 'hello world hello', '--count', 'hello', '--json']);
    assert.equal(c.nonOverlapping, 2, JSON.stringify(c));
  });

  // ── email ────────────────────────────────────────────────────────────

  it('email send delivers (suppressed) mail to an ec- address', () => {
    const d = cliJson(['email', 'send', '--to', MAIL_TO, '--subject', `E2E ${RUN_ID}`, '--body', 'CLI e2e test mail.', '--json']);
    assert.deepEqual(d.to, [MAIL_TO]);
    assert.equal(d.subject, `E2E ${RUN_ID}`);
  });

  it('email test sends through the app email() path', () => {
    const d = cliJson(['email', 'test', MAIL_TO, '--subject', `E2E app ${RUN_ID}`, '--json']);
    assert.equal(typeof d.sent, 'number');
    assert.equal(d.sent + d.skipped, 1, JSON.stringify(d));
    assert.equal(d.results[0].to, MAIL_TO);
  });

  it('email log --json lists recent email() activity', () => {
    const d = cliJson(['email', 'log', '--range', '1h', '--json']);
    assert.ok(Array.isArray(d.items));
    assert.equal(typeof d.totals.n, 'number');
    assert.ok(d.items.some((i: any) => i.detail?.to === MAIL_TO), `the test send is not in the log: ${JSON.stringify(d.items.slice(0, 3))}`);
  });
});
