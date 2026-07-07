/**
 * `gipity claude -p "msg"` / `--print` - non-interactive passthrough mode.
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
import { runCli, runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer } from './helpers/mock-server.js';

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

describe('gipity claude --new-project / --project', () => {
  it('rejects --new-project and --project used together', () => {
    const home = freshHome();
    const r = runCli(['claude', '--new-project', '--project', 'foo'], { env: { HOME: home }, cwd: home });
    assert.notEqual(r.status, 0, 'should exit non-zero');
    assert.match(r.stderr, /not both/);
  });

  it('still requires login with --new-project', () => {
    const home = freshHome();
    const r = runCli(['claude', '--new-project', '-p', 'build a thing'], { env: { HOME: home }, cwd: home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Not logged in/);
    assert.equal(r.stdout, '');
  });

  it('--new-project lifts the "no project in cwd" guard (proceeds to resolve a project)', async () => {
    // Logged in but cwd has no .gipity.json. Without --new-project this errors
    // with "No Gipity project in cwd". With it, the command proceeds past that
    // guard to fetch projects - here an in-process mock 500s so the fetch fails
    // deterministically. (A dead port doesn't reliably refuse fast on every
    // host - some hang until the spawn timeout - so we use a real server that
    // accepts the connection and errors.)
    const home = freshHome();
    writeFakeAuth(home);
    const mock = await startMockServer();
    mock.on('GET /projects', { status: 500, body: { error: { code: 'BOOM', message: 'nope' } } });
    try {
      // Point the CLI at the mock via GIPITY_API_BASE (a trusted env override
      // read directly by resolveApiBase) rather than the root --api-base flag,
      // which commander drops when it trails the subcommand - so the request
      // would otherwise escape to the real backend.
      const r = await runCliAsync(
        ['claude', '--new-project', '-p', 'build a thing'],
        { env: { HOME: home, GIPITY_API_BASE: mock.apiBase }, cwd: home },
      );
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stderr, /No Gipity project in cwd/);
      assert.match(r.stderr, /Could not load projects|session expired/);
      assert.equal(r.stdout, '');
    } finally {
      await mock.stop();
    }
  });
});

// The daemon-capture gate: hook capture stands down ONLY for relay-daemon
// spawns (inherited conv guid + stream-json output). A user-supplied
// `--output-format stream-json` run has no daemon parsing its stdout, so
// hooks must stay armed or the conversation records nothing (the
// qwen-flight zero-message bug, 2026-07-07).
describe('hasStreamJsonFlag', () => {
  it('detects both the two-arg and equals forms', async () => {
    const { hasStreamJsonFlag } = await import('../commands/claude.js');
    assert.equal(hasStreamJsonFlag(['-p', 'x', '--output-format', 'stream-json']), true);
    assert.equal(hasStreamJsonFlag(['-p', 'x', '--output-format=stream-json']), true);
  });

  it('is false for other formats and for no format flag at all', async () => {
    const { hasStreamJsonFlag } = await import('../commands/claude.js');
    assert.equal(hasStreamJsonFlag(['-p', 'x', '--output-format', 'json']), false);
    assert.equal(hasStreamJsonFlag(['-p', 'x', '--output-format=json']), false);
    assert.equal(hasStreamJsonFlag(['-p', 'x']), false);
    assert.equal(hasStreamJsonFlag([]), false);
    // Value in a later position only counts when paired with the flag.
    assert.equal(hasStreamJsonFlag(['stream-json']), false);
  });
});
