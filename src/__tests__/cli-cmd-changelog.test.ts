/**
 * `gipity changelog` and the post-update notice. Mocked GET /changelog that
 * applies `since` the way the server does for the shapes the CLI sends (a date
 * or cli:X.Y.Z); subprocess spawn for the command, in-process for the notice
 * (a spawned CLI is never a TTY, and the notice only prints on one).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { tempDir } from './helpers/test-home.js';

const ENTRIES = [
  { id: '2026-11-19-newest', date: '2026-11-19', title: 'Newest', server: '9.14.790', cli: null, bullets: ['Server-only `thing`.'], breaking: [], skills: [] },
  { id: '2026-11-18-middle', date: '2026-11-18', title: 'Middle', server: '9.14.782', cli: '1.1.41', bullets: ['Use `gipity deploy dev`.'], breaking: ['`target` is gone.'], skills: ['deploy'] },
  { id: '2026-11-18-oldest', date: '2026-11-18', title: 'Oldest', server: '9.14.781', cli: '1.1.39', bullets: ['First.'], breaking: [], skills: [] },
];

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

let mock: MockServer;

function serveChangelog(): void {
  mock.on('GET /changelog', ({ url }) => {
    const q = new URL(url, 'http://x').searchParams;
    let out = ENTRIES;
    const since = q.get('since');
    if (since?.startsWith('cli:')) {
      const v = since.slice(4);
      const stop = out.findIndex((e) => e.cli !== null && cmp(e.cli, v) <= 0);
      if (stop !== -1) out = out.slice(0, stop);
    } else if (since) {
      out = out.filter((e) => e.date >= since);
    }
    const last = q.get('last');
    if (last) out = out.slice(0, Number(last));
    return { body: { data: { entries: out } } };
  });
}

function stateFile(home: string): string {
  return join(home, '.gipity', 'changelog.json');
}

before(async () => {
  mock = await startMockServer();
});

after(async () => {
  await mock.stop();
});

test('gipity changelog prints the newest entries without auth, and remembers the newest seen', async () => {
  mock.reset();
  serveChangelog();
  const home = tempDir('gipity-changelog-');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'changelog'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Newest\n2026-11-19, server 9\.14\.790\n- Server-only thing\./);
  assert.match(r.stdout, /Middle\n2026-11-18, server 9\.14\.782, CLI 1\.1\.41\n- Use gipity deploy dev\.\nBreaking:\n- target is gone\.\nDocs: gipity skill read deploy/);
  assert.doesNotMatch(r.stdout, /undefined|`/);
  assert.equal(mock.requests().find((x) => x.url.startsWith('/changelog'))?.url, '/changelog?last=10');
  const state = JSON.parse(readFileSync(stateFile(home), 'utf-8'));
  assert.equal(state.seenEntry, '2026-11-19-newest');
  assert.equal(state.seenDate, '2026-11-19');
});

test('gipity changelog --newer --json starts from the CLI version, then only shows what came after the last look', async () => {
  mock.reset();
  serveChangelog();
  const home = tempDir('gipity-changelog-');
  const pkgVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')).version as string;

  const first = await runCliAsync(['--api-base', mock.apiBase, 'changelog', '--newer', '--json'], { env: { HOME: home } });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(mock.requests().find((x) => x.url.startsWith('/changelog'))?.url, `/changelog?since=cli%3A${pkgVersion}`);
  const firstIds = JSON.parse(first.stdout).entries.map((e: { id: string }) => e.id);
  // This CLI is newer than every mocked CLI version: only the server-only entry above them is new.
  assert.deepEqual(firstIds, ['2026-11-19-newest']);

  mock.reset();
  serveChangelog();
  const second = await runCliAsync(['--api-base', mock.apiBase, 'changelog', '--newer', '--json'], { env: { HOME: home } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(mock.requests().find((x) => x.url.startsWith('/changelog'))?.url, '/changelog?since=2026-11-19');
  assert.deepEqual(JSON.parse(second.stdout), { entries: [] });

  const human = await runCliAsync(['--api-base', mock.apiBase, 'changelog', '--newer'], { env: { HOME: home } });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Nothing new since you last looked\./);
});

test('gipity changelog --since passes the value through and --newer with --since is refused', async () => {
  mock.reset();
  serveChangelog();
  const home = tempDir('gipity-changelog-');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'changelog', '--since', 'cli:1.1.39', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).entries.map((e: { title: string }) => e.title), ['Newest', 'Middle']);

  const both = await runCliAsync(['--api-base', mock.apiBase, 'changelog', '--newer', '--since', '2026-11-01'], { env: { HOME: home } });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /use --newer or --since, not both/);
});

test('gipity changelog shows the server error when since is bad', async () => {
  mock.reset();
  mock.on('GET /changelog', { status: 400, body: { error: { code: 'INVALID_SINCE', message: 'since must be a date (yyyy-mm-dd) or a version' } } });
  const home = tempDir('gipity-changelog-');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'changelog', '--since', 'yesterday'], { env: { HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Changelog failed: .*since must be a date/);
});

test('update notice: silent on first run and off a TTY, one line once after the version goes up', async () => {
  mock.reset();
  serveChangelog();
  const home = tempDir('gipity-changelog-notice-');
  process.env.HOME = home;
  // GIPITY_DIR is read from HOME when the module loads, so import after setting it.
  const { maybePrintUpdateNotice, readChangelogState } = await import('../changelog.js');
  const { setApiBaseOverride } = await import('../config.js');
  setApiBaseOverride(mock.apiBase);
  const printed: string[] = [];
  const print = (line: string) => printed.push(line);

  // First ever run records the baseline and prints nothing.
  await maybePrintUpdateNotice('1.1.39', { interactive: true, print });
  assert.deepEqual(printed, []);
  assert.deepEqual(readChangelogState(), { baselineCli: '1.1.39', noticedCli: '1.1.39' });
  assert.equal(existsSync(stateFile(home)), true);

  // Updated, but piped / --json: no line, and the notice is kept for later.
  await maybePrintUpdateNotice('1.1.42', { interactive: false, print });
  assert.deepEqual(printed, []);
  assert.equal(readChangelogState()?.noticedCli, '1.1.39');

  // First interactive run on the new version: entries after 1.1.39 are Newest + Middle.
  await maybePrintUpdateNotice('1.1.42', { interactive: true, print });
  assert.equal(printed.length, 1);
  assert.match(printed[0], /2 updates since you last looked: .*gipity changelog --newer/);

  // Once only.
  await maybePrintUpdateNotice('1.1.42', { interactive: true, print });
  assert.equal(printed.length, 1);

  // Nothing unseen: no line at all.
  const { markSeen, fetchChangelog } = await import('../changelog.js');
  markSeen(readChangelogState()!, await fetchChangelog({}));
  await maybePrintUpdateNotice('1.1.43', { interactive: true, print });
  assert.equal(printed.length, 1);
  assert.equal(readChangelogState()?.noticedCli, '1.1.43');
});
