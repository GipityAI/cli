/**
 * `gipity relay` happy-path tests for the REST-touching verbs (rename,
 * revoke) and the pure-local ones (status, pause, resume). The daemon
 * run loop and installer paths are covered separately by
 * relay-daemon.test.ts and relay-installers.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;

before(async () => { mock = await startMockServer(); });
after(async () => { await mock.stop(); });

function pairedHome(): string {
  const home = makeAuthedHome();
  const relayDir = join(home, '.gipity');
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(join(relayDir, 'relay.json'), JSON.stringify({
    device: { guid: 'rd_TestDev01', name: 'My Mac', platform: 'linux', token: 'tok-test', paired_at: '2026-05-01' },
    paused: false,
    relay_enabled: true,
  }, null, 2));
  return home;
}

function run(args: string[], home: string) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

test('gipity relay status (paired) prints device name + platform', async () => {
  const home = pairedHome();
  const r = await run(['relay', 'status'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Device:.*My Mac/);
  assert.match(r.stdout, /Platform:\s+linux/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity relay status --json redacts the device token', async () => {
  const home = pairedHome();
  const r = await run(['relay', 'status', '--json'], home);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.device.token, '***');
});

test('gipity relay status (no device) prompts to pair', async () => {
  const home = makeAuthedHome();
  const r = await run(['relay', 'status'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No paired device/);
});

test('gipity relay pause + resume flip the local paused flag', async () => {
  const home = pairedHome();
  const pause = await run(['relay', 'pause'], home);
  assert.equal(pause.status, 0, pause.stderr);
  assert.match(pause.stdout, /Paused/);
  const state1 = JSON.parse(readFileSync(join(home, '.gipity', 'relay.json'), 'utf-8'));
  assert.equal(state1.paused, true);

  const resume = await run(['relay', 'resume'], home);
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /Resumed/);
  const state2 = JSON.parse(readFileSync(join(home, '.gipity', 'relay.json'), 'utf-8'));
  assert.equal(state2.paused, false);
});

test('gipity relay rename posts to /remote-devices/:guid/rename and updates local state', async () => {
  mock.reset();
  mock.on('POST /remote-devices/rd_TestDev01/rename', { body: { data: { renamed: true } } });
  const home = pairedHome();
  const r = await run(['relay', 'rename', 'New Mac'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Renamed to New Mac/);
  const state = JSON.parse(readFileSync(join(home, '.gipity', 'relay.json'), 'utf-8'));
  assert.equal(state.device.name, 'New Mac');
});

test('gipity relay revoke --yes posts revoke + clears local state', async () => {
  mock.reset();
  mock.on('POST /remote-devices/rd_TestDev01/revoke', { body: { data: { revoked: true } } });
  const home = pairedHome();
  const r = await runCliAsync(['--api-base', mock.apiBase, '--yes', 'relay', 'revoke'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Device revoked/);
  const state = JSON.parse(readFileSync(join(home, '.gipity', 'relay.json'), 'utf-8'));
  assert.equal(state.device, null);
});

test('gipity relay setup (fresh) creates a device and writes local state', async () => {
  mock.reset();
  mock.on('POST /remote-devices', { body: { data: {
    short_guid: 'rd_New01', name: 'CI Box', platform: 'linux', token: 'tok-new',
  } } });
  const home = makeAuthedHome();
  // --no-start / --no-autostart keep the test hermetic (no detached daemon, no
  // launchctl/systemctl) - and mirror how the Option-B desktop client calls it.
  const r = await run(['relay', 'setup', '--name', 'CI Box', '--no-start', '--no-autostart', '--json'], home);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.device.guid, 'rd_New01');
  assert.equal(parsed.device.reused, false);
  assert.equal(parsed.daemon_started, false);
  const state = JSON.parse(readFileSync(join(home, '.gipity', 'relay.json'), 'utf-8'));
  assert.equal(state.device.guid, 'rd_New01');
  assert.equal(state.device.token, 'tok-new');
  assert.equal(state.relay_enabled, true);
});

test('gipity relay setup (already paired) is idempotent and makes no server call', async () => {
  mock.reset(); // no /remote-devices handler registered → a POST would 404
  const home = pairedHome();
  const r = await run(['relay', 'setup', '--no-start', '--no-autostart', '--json'], home);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.device.reused, true);
  assert.equal(parsed.device.guid, 'rd_TestDev01');
  // Idempotent path must not hit the create endpoint.
  assert.equal(mock.requests().some(q => q.method === 'POST' && q.url === '/remote-devices'), false);
});

test('gipity relay setup --force re-registers in place without revoking (keeps conversations)', async () => {
  mock.reset();
  mock.on('POST /remote-devices', { body: { data: {
    short_guid: 'rd_TestDev01', name: 'My Mac', platform: 'linux', token: 'tok-fresh',
  } } });
  const home = pairedHome();
  const r = await run(['relay', 'setup', '--force', '--no-start', '--no-autostart', '--json'], home);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.device.reused, false);

  // No pre-revoke: revoking first forced the server to mint a NEW device row,
  // which orphaned every conversation bound to the old one (issue #291). The
  // machine_id dedup reattaches the same row and rotates its token, which
  // invalidates the old bearer anyway - so the revoke round-trip was both
  // unnecessary and destructive.
  const reqs = mock.requests();
  assert.ok(!reqs.some(q => q.url.includes('/revoke')), 'must not revoke before re-registering');
  assert.ok(reqs.some(q => q.method === 'POST' && q.url === '/remote-devices'));

  const state = JSON.parse(readFileSync(join(home, '.gipity', 'relay.json'), 'utf-8'));
  assert.equal(state.device.guid, 'rd_TestDev01');
  assert.equal(state.device.token, 'tok-fresh'); // token rotated
});

test('gipity relay setup --json surfaces a 401 as a not_authenticated error', async () => {
  mock.reset();
  mock.on('POST /remote-devices', { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'expired' } } });
  const home = makeAuthedHome();
  const r = await run(['relay', 'setup', '--no-start', '--no-autostart', '--json'], home);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'not_authenticated');
});

test('gipity relay status --json reports daemon_running', async () => {
  const home = pairedHome();
  const r = await run(['relay', 'status', '--json'], home);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  // No daemon spawned in the test home, so it must be a literal false (not undefined).
  assert.equal(parsed.daemon_running, false);
});

test('gipity relay log prints last lines when log file exists', async () => {
  const home = pairedHome();
  // The daemon log path is under ~/.gipity/. Pre-seed it.
  const logPath = join(home, '.gipity', 'relay.log');
  writeFileSync(logPath, 'first line\nsecond line\nthird line\n');
  const r = await runCliAsync(['relay', 'log', '-n', '2'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /third line/);
});

test('gipity relay log (no log file) prints helpful hint', async () => {
  const home = pairedHome();
  const r = await runCliAsync(['relay', 'log'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No log file yet/);
});
