/**
 * Tests for the local read-only commands: doctor, status. No REST mocking
 * needed; just spawn into a tmp HOME and assert the output shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('gipity doctor prints shim version + auto-update state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gipity-doctor-'));
  const r = await runCliAsync(['doctor'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Gipity CLI - doctor/);
  assert.match(r.stdout, /shim version/);
  assert.match(r.stdout, /auto-updates/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity status (logged out, no project) prints both hints', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gipity-status-out-'));
  const cwd = mkdtempSync(join(tmpdir(), 'gipity-status-out-cwd-'));
  const r = await runCliAsync(['status'], { env: { HOME: home }, cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Not a Gipity project/);
  assert.match(r.stdout, /not logged in/);
});

test('gipity status (logged in + project) shows email + project + agent', async () => {
  const home = makeAuthedHome();
  const cwd = makeProjectDir({ apiBase: 'http://127.0.0.1:1' });
  // Pre-populate .claude/settings.json so the hook check has something to read.
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
  const r = await runCliAsync(['status'], { env: { HOME: home }, cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Project:.*test-project/);
  assert.match(r.stdout, /Account:.*test-account/);
  assert.match(r.stdout, /Auth:.*ec-test@914-6\.com/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity status --json emits structured object', async () => {
  const home = makeAuthedHome();
  const cwd = makeProjectDir({ apiBase: 'http://127.0.0.1:1' });
  const r = await runCliAsync(['status', '--json'], { env: { HOME: home }, cwd });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.project.slug, 'test-project');
  assert.equal(parsed.auth.email, 'ec-test@914-6.com');
  assert.equal(parsed.auth.valid, true);
});
