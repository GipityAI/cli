/**
 * `gipity setup` — the relay-only onboarding front door. It runs the same
 * first steps as `gipity claude` (log in, then pair + start the relay) but
 * never picks a project or launches Claude Code.
 *
 * Under a spawned (non-TTY) child, `confirm()` returns false without hanging,
 * so the "declined" path is fully deterministic and needs no mock server: an
 * authed home reaches the relay prompt, declines it, and exits 0 having done
 * nothing but print the plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome } from './helpers/test-home.js';

function run(args: string[], home: string) {
  return runCliAsync(['--api-base', 'http://127.0.0.1:0', ...args], { env: { HOME: home } });
}

test('gipity setup (authed, non-TTY) logs in, offers relay setup, and stops without launching', async () => {
  const home = makeAuthedHome();
  const r = await run(['setup'], home);
  assert.equal(r.status, 0, r.stderr);
  // Framed as the deliberate setup it is, with the cost message.
  assert.match(r.stdout, /Gipity setup/);
  assert.match(r.stdout, /Logged in \(ec-test@914-6\.com\)/);
  assert.match(r.stdout, /Set up this computer as a relay/);
  assert.match(r.stdout, /cheapest way to pay for tokens/);
  // Non-TTY declines the confirm, so nothing is paired and Claude never launches.
  assert.match(r.stdout, /No relay set up/);
  assert.doesNotMatch(r.stdout, /Launching Claude Code/);
});

test('gipity setup --help describes the relay-only setup', async () => {
  const home = makeAuthedHome();
  const r = await run(['setup', '--help'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Set up this computer as a relay/);
});

test('gipity --help lists setup in the Connect & setup group', async () => {
  const home = makeAuthedHome();
  const r = await run(['--help'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Connect & setup:[\s\S]*\bsetup\b/);
});
