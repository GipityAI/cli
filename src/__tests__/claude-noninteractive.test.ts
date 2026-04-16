/**
 * `gipity claude -p "msg"` / `--print` — non-interactive passthrough mode.
 *
 * Exercises the early-exit preconditions (must be logged in + must have a
 * project in cwd) since the success path shells out to `claude` which isn't
 * available in CI. Also verifies banner output is suppressed from stdout so
 * the child's stream-json stays clean when a relay pipes the output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli } from './helpers/spawn-cli.js';

function freshHome(): string {
  return mkdtempSync(`${tmpdir()}/gipity-cli-claude-test-`);
}

function writeFakeAuth(home: string): void {
  const dir = join(home, '.gipity');
  mkdirSync(dir, { recursive: true });
  // Far-future expiry so refreshTokenIfNeeded() is a no-op.
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    accessToken: 'fake.jwt.token',
    refreshToken: 'fake-refresh',
    email: 'ec-test@914-6.com',
    expiresAt,
  }));
}

describe('gipity claude -p (non-interactive)', () => {
  it('errors out when not logged in, writing the error to stderr and exiting non-zero', () => {
    const home = freshHome();
    const r = runCli(['claude', '-p', 'hello world'], { env: { HOME: home }, cwd: home });
    assert.notEqual(r.status, 0, 'should exit non-zero');
    assert.match(r.stderr, /Not logged in/);
    // Stdout must stay clean so a relay piping `claude -p`'s stream-json
    // isn't polluted with gipity banner text.
    assert.equal(r.stdout, '', `expected empty stdout, got: ${r.stdout}`);
  });

  it('errors out when cwd has no Gipity project, even if logged in', () => {
    const home = freshHome();
    writeFakeAuth(home);
    const r = runCli(['claude', '-p', 'hello'], { env: { HOME: home }, cwd: home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /No Gipity project in cwd/);
    assert.equal(r.stdout, '');
  });

  it('treats --print the same as -p', () => {
    const home = freshHome();
    const r = runCli(['claude', '--print', 'hello'], { env: { HOME: home }, cwd: home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Not logged in/);
    assert.equal(r.stdout, '');
  });

  it('interactive mode (no -p) still prints the banner to stdout', () => {
    // No auth → auth prompt starts, which reads stdin and we close stdin
    // so it exits. We only need to verify the banner surfaced on stdout
    // (proving the non-interactive stderr-routing is scoped correctly).
    const home = freshHome();
    const r = runCli(['claude'], { env: { HOME: home }, cwd: home, timeout: 3000 });
    // No assertion on status (may time out awaiting input); assert banner presence.
    assert.match(r.stdout, /Gipity CLI/);
  });
});
