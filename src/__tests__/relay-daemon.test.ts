/**
 * `gipity-relay` daemon — full round-trip tests against an in-process mock
 * backend. `GIPITY_RELAY_CLAUDE_CMD` is pointed at `true` / `false` / a
 * sleep script so we can assert the daemon's ack shape for each outcome
 * without actually shelling out to `gipity claude`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCliAsync } from './helpers/spawn-cli.js';

// ─── Mock backend ──────────────────────────────────────────────────────

interface Dispatch {
  short_guid: string;
  kind: 'start' | 'resume';
  remote_session_id: string | null;
  message: string;
  project_guid: string;
  project_slug: string;
  account_slug: string;
}

let server: Server;
let apiBase: string;

// Queue of dispatches the /next handler will hand out in order.
let pending: Dispatch[] = [];
let heartbeats = 0;
const acks: Array<{ guid: string; status: string; error?: string | null }> = [];
let nextStatusOverride: number | null = null;
let heartbeatStatusOverride: number | null = null;

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function resetMock(): void {
  pending = [];
  heartbeats = 0;
  acks.length = 0;
  nextStatusOverride = null;
  heartbeatStatusOverride = null;
}

before(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Require device bearer on every call.
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no token' } }));
    }

    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/remote-devices/heartbeat') {
      heartbeats++;
      if (heartbeatStatusOverride != null) {
        res.statusCode = heartbeatStatusOverride;
        return res.end(JSON.stringify({ error: { code: 'X', message: 'override' } }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ data: { ok: true } }));
    }

    if (req.method === 'GET' && url === '/remote-devices/next') {
      if (nextStatusOverride != null) {
        res.statusCode = nextStatusOverride;
        return res.end(JSON.stringify({ error: { code: 'X', message: 'override' } }));
      }
      const d = pending.shift();
      if (!d) {
        // Brief wait then 204 — simulates a short long-poll hold.
        await new Promise(r => setTimeout(r, 80));
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ data: d }));
    }

    const ackMatch = url.match(/^\/remote-devices\/dispatches\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      const body = await readJson(req);
      acks.push({ guid: ackMatch[1], status: body.status, error: body.error });
      res.statusCode = 200;
      return res.end(JSON.stringify({ data: { ok: true } }));
    }

    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  apiBase = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

// ─── Fixture — a fresh $HOME with a paired device + pre-seeded project dir ─

function freshHome(opts: { paused?: boolean; preseedProject?: boolean } = {}): {
  home: string;
  projectsRoot: string;
  projectCwd: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'gipity-daemon-'));
  const projectsRoot = join(home, 'GipityProjects');
  const projectCwd = join(projectsRoot, 'test');

  // relay.json: paired device + pause flag.
  const relayDir = join(home, '.gipity');
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(join(relayDir, 'relay.json'), JSON.stringify({
    device: { guid: 'rd_test', name: 't', platform: 'linux', token: 'tok-test', paired_at: '2026-04-14' },
    paused: Boolean(opts.paused),
    relay_enabled: true,
  }, null, 2));

  // Pin `getProjectsRoot()` to our throwaway HOME's GipityProjects dir.
  writeFileSync(join(relayDir, 'settings.json'), JSON.stringify({ projectsDir: projectsRoot }) + '\n');

  // If this test wants to skip the bootstrap code path, pre-seed the dir
  // with a matching .gipity.json so the resolver short-circuits.
  if (opts.preseedProject ?? true) {
    mkdirSync(projectCwd, { recursive: true });
    writeFileSync(join(projectCwd, '.gipity.json'), JSON.stringify({
      projectGuid: 'p_test',
      projectSlug: 'test',
      accountSlug: 'acct',
      apiBase,
      ignore: [],
    }));
  }
  return { home, projectsRoot, projectCwd };
}

function dispatchRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    short_guid: 'rds_default1',
    kind: 'start',
    remote_session_id: null,
    message: 'hi',
    project_guid: 'p_test',
    project_slug: 'test',
    account_slug: 'acct',
    ...overrides,
  };
}

async function runDaemon(home: string, claudeCmd: string, opts: { maxRunMs?: number } = {}): Promise<{ stdout: string; stderr: string; status: number }> {
  return runCliAsync(
    ['--api-base', apiBase, 'relay', 'run'],
    {
      env: {
        HOME: home,
        GIPITY_RELAY_CLAUDE_CMD: claudeCmd,
        GIPITY_RELAY_HEARTBEAT_MS: '150',
        GIPITY_RELAY_POLL_TIMEOUT_MS: '300',
        GIPITY_RELAY_BACKOFF_BASE_MS: '50',
        GIPITY_RELAY_BACKOFF_MAX_MS: '200',
        // Bound the daemon so tests can't hang.
        GIPITY_RELAY_MAX_RUN_MS: String(opts.maxRunMs ?? 1500),
      },
      cwd: home,
      timeout: 10_000,
    },
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('daemon: not paired', () => {
  it('errors immediately when no device is paired', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gipity-daemon-unpaired-'));
    const r = await runCliAsync(['--api-base', apiBase, 'relay', 'run'], {
      env: { HOME: home },
      cwd: home,
      timeout: 5_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Not paired/);
  });
});

describe('daemon: dispatch happy path', () => {
  it('claims queued dispatch, spawns child, acks done when child exits 0', async () => {
    resetMock();
    const { home } = freshHome();
    pending.push(dispatchRow({ short_guid: 'rds_abc123', message: 'hello' }));

    await runDaemon(home, 'true');

    assert.equal(acks.length, 1, `expected 1 ack, got ${acks.length}`);
    assert.equal(acks[0].guid, 'rds_abc123');
    assert.equal(acks[0].status, 'done');
    assert.ok(heartbeats >= 1, 'should have heartbeated at least once');
  });

  it('acks error when the child exits nonzero', async () => {
    resetMock();
    const { home } = freshHome();
    pending.push(dispatchRow({ short_guid: 'rds_fail1', message: 'boom' }));

    await runDaemon(home, 'false');

    assert.equal(acks.length, 1);
    assert.equal(acks[0].guid, 'rds_fail1');
    assert.equal(acks[0].status, 'error');
    assert.match(acks[0].error || '', /exited with code/);
  });
});

describe('daemon: safety checks', () => {
  it('refuses dispatches while paused', async () => {
    resetMock();
    const { home } = freshHome({ paused: true });
    pending.push(dispatchRow({ short_guid: 'rds_paused' }));

    await runDaemon(home, 'true');

    assert.equal(acks.length, 1);
    assert.equal(acks[0].status, 'error');
    assert.match(acks[0].error || '', /paused/i);
  });

  it('refuses resume without remote_session_id', async () => {
    resetMock();
    const { home } = freshHome();
    pending.push(dispatchRow({ short_guid: 'rds_badresume', kind: 'resume' }));

    await runDaemon(home, 'true');

    assert.equal(acks.length, 1);
    assert.equal(acks[0].status, 'error');
    assert.match(acks[0].error || '', /remote_session_id/);
  });
});

describe('daemon: auto-bootstrap missing project dir', () => {
  it('creates ~/GipityProjects/<slug>/ + .gipity.json when dispatch targets an unknown project', async () => {
    resetMock();
    // Don't preseed the project dir — daemon should create it.
    const { home, projectCwd } = freshHome({ preseedProject: false });
    pending.push(dispatchRow({ short_guid: 'rds_bootstrap', message: 'hi' }));

    await runDaemon(home, 'true');

    // Ack should be "done" — the dispatch ran successfully against the new dir.
    assert.equal(acks.length, 1);
    assert.equal(acks[0].status, 'done', `got ${acks[0].status}: ${acks[0].error}`);

    // Directory + .gipity.json now exist with the right guid.
    const cfgPath = join(projectCwd, '.gipity.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(cfg.projectGuid, 'p_test');
    assert.equal(cfg.projectSlug, 'test');
  });
});

describe('daemon: revocation', () => {
  it('exits cleanly (0) when /next returns 401', async () => {
    resetMock();
    nextStatusOverride = 401;
    const { home } = freshHome();

    const r = await runDaemon(home, 'true');
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /revoked/);
  });
});
