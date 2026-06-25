/**
 * `gipity doctor --json` - the environment report a GUI/installer (the desktop
 * onboarding client) polls. We assert the shape and the host-independent fields
 * (node, gipity login, relay pairing). Claude install/auth are host-dependent
 * (real `which claude` + credential store), so we only assert they're booleans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome } from './helpers/test-home.js';

function bareHome(): string {
  return mkdtempSync(join(tmpdir(), 'gipity-doctor-'));
}

function pairedAuthedHome(): string {
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

function assertEnvShape(env: any) {
  assert.equal(typeof env.ready, 'boolean');
  assert.equal(typeof env.node.ok, 'boolean');
  assert.equal(typeof env.node.version, 'string');
  assert.equal(typeof env.claude.installed, 'boolean');
  assert.equal(typeof env.claude.authenticated, 'boolean');
  assert.equal(typeof env.relay.paired, 'boolean');
  assert.equal(typeof env.relay.running, 'boolean');
  assert.equal(typeof env.relay.paused, 'boolean');
  assert.ok(env.relay.autostart === true || env.relay.autostart === false || env.relay.autostart === null);
  // CLI settings block.
  assert.equal(typeof env.cli.shim_version, 'string');
  assert.equal(typeof env.cli.auto_updates, 'boolean');
  assert.equal(typeof env.cli.local_install_ok, 'boolean');
}

test('gipity doctor --json reports logged-out + unpaired for a fresh home', async () => {
  const home = bareHome();
  const r = await runCliAsync(['doctor', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout.trim());
  assertEnvShape(env);
  assert.equal(env.node.ok, true);            // CI runs Node 18+
  assert.equal(env.gipity.logged_in, false);
  assert.equal(env.gipity.email, null);
  assert.equal(env.relay.paired, false);
  assert.equal(env.relay.device, null);
  assert.equal(env.relay.autostart, false); // no unit file under this throwaway HOME
  assert.equal(env.ready, false);
});

test('gipity doctor --json reports logged-in + paired for an authed, paired home', async () => {
  const home = pairedAuthedHome();
  const r = await runCliAsync(['doctor', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout.trim());
  assertEnvShape(env);
  assert.equal(env.gipity.logged_in, true);
  assert.equal(env.gipity.email, 'ec-test@914-6.com');
  assert.equal(env.relay.paired, true);
  assert.equal(env.relay.device.name, 'My Mac');
  assert.equal(env.relay.device.guid, 'rd_TestDev01');
});
