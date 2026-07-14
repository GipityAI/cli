/**
 * `gipity connect` — the relay-only onboarding front door (renamed from
 * `gipity setup`, which survives as a hidden alias). It runs the same first
 * steps as `gipity build` (log in, then pair + start the relay) but never
 * picks a project or launches an agent.
 *
 * Under a spawned (non-TTY) child, `confirm()` returns false without hanging,
 * so the "declined" path is fully deterministic and needs no mock server: an
 * authed home reaches the relay prompt, declines it, and exits 0 having done
 * nothing but print the plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome } from './helpers/test-home.js';

function run(args: string[], home: string) {
  return runCliAsync(['--api-base', 'http://127.0.0.1:0', ...args], { env: { HOME: home } });
}

test('gipity connect (authed, non-TTY) logs in, offers relay setup, and stops without launching', async () => {
  const home = makeAuthedHome();
  const r = await run(['connect'], home);
  assert.equal(r.status, 0, r.stderr);
  // Framed as the deliberate machine-connect it is, with the cost message.
  assert.match(r.stdout, /Gipity connect/);
  assert.match(r.stdout, /Logged in \(ec-test@914-6\.com\)/);
  assert.match(r.stdout, /Set up this computer as a relay/);
  assert.match(r.stdout, /cheapest way to pay for tokens/);
  // Non-TTY declines the confirm, so nothing is paired and no agent launches.
  assert.match(r.stdout, /No relay set up/);
  assert.doesNotMatch(r.stdout, /Launching Claude Code/);
});

test('gipity setup still works as a hidden legacy alias of connect', async () => {
  const home = makeAuthedHome();
  const r = await run(['setup'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Gipity connect/);
  assert.match(r.stdout, /No relay set up/);
});

test('gipity connect (already registered) surfaces the existing device and points at revoke instead of silently re-registering', async () => {
  const home = makeAuthedHome();
  // Seed an already-paired device. `paused: true` keeps the guard from spawning
  // a background daemon, so the test stays hermetic (no network, no stray proc).
  writeFileSync(join(home, '.gipity', 'relay.json'), JSON.stringify({
    device: {
      guid: 'rd_Existing1', name: 'SignalOrangeXps', platform: 'win32',
      token: 'tok-x', paired_at: '2026-05-01T00:00:00Z',
    },
    paused: true,
    relay_enabled: true,
  }) + '\n');

  const r = await run(['connect'], home);
  assert.equal(r.status, 0, r.stderr);
  // Names the existing registration honestly (this was the bug: it used to
  // ask for a new name, ignore it, and report the old one as if freshly set).
  assert.match(r.stdout, /already set up as a relay/i);
  assert.match(r.stdout, /SignalOrangeXps/);
  assert.match(r.stdout, /rd_Existing1/);
  // Tells the user the one supported way to re-register: revoke, then connect.
  assert.match(r.stdout, /gipity relay revoke/);
  // It must NOT prompt for a device name on an already-registered machine.
  assert.doesNotMatch(r.stdout, /Device name/);
});

test('gipity connect --help describes the machine connect', async () => {
  const home = makeAuthedHome();
  const r = await run(['connect', '--help'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Connect this computer to gipity\.ai/);
});

test('gipity --help lists connect (not setup) in the Connect & setup group', async () => {
  const home = makeAuthedHome();
  const r = await run(['--help'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Connect & setup:[\s\S]*\bconnect\b/);
  // The legacy names are hidden from top-level help.
  assert.doesNotMatch(r.stdout, /Connect & setup:[\s\S]*\bclaude\b {2}/);
});
