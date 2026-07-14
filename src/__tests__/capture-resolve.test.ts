/**
 * Conversation binding for the capture hook runner (`resolveConvGuid`) -
 * the self-arm path that lets a bare `claude` session in a linked project
 * record to Gipity without having been launched via `gipity claude`.
 *
 * Binding order under test: GIPITY_CONVERSATION_GUID env → persisted
 * session mapping → server resolve (gated on .gipity.json, captureHooks,
 * and a paired device), serialized per-session by the capture lock.
 *
 * The server is the only thing stubbed (global fetch); config, relay
 * state, and the capture-state files are the real modules operating on a
 * sandboxed $HOME/$GIPITY_DIR.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempHome: string;
let projectDir: string;
let captureDir: string;
let relayFile: string;
let cwd0: string;
let originalHome: string | undefined;
let originalGipityDir: string | undefined;
let originalFetch: typeof fetch;

// Everything under test computes paths from HOME/GIPITY_DIR at module
// load, so the env must be sandboxed BEFORE the first dynamic import.
before(() => {
  cwd0 = process.cwd();
  originalHome = process.env.HOME;
  originalGipityDir = process.env.GIPITY_DIR;
  originalFetch = globalThis.fetch;

  tempHome = mkdtempSync(join(tmpdir(), 'gipity-capture-resolve-'));
  process.env.HOME = tempHome;
  process.env.GIPITY_DIR = join(tempHome, '.gipity');
  mkdirSync(join(tempHome, '.gipity'), { recursive: true });
  captureDir = join(tempHome, '.gipity', 'capture-state');
  relayFile = join(tempHome, '.gipity', 'relay.json');

  projectDir = join(tempHome, 'proj');
  mkdirSync(projectDir);
  process.chdir(projectDir);
});

after(() => {
  process.chdir(cwd0);
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalGipityDir === undefined) delete process.env.GIPITY_DIR; else process.env.GIPITY_DIR = originalGipityDir;
  globalThis.fetch = originalFetch;
  rmSync(tempHome, { recursive: true, force: true });
});

function writeProjectConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(join(projectDir, '.gipity.json'), JSON.stringify({
    projectGuid: 'p_capres01',
    projectSlug: 'proj',
    accountSlug: 'acct',
    agentGuid: '',
    conversationGuid: null,
    apiBase: 'https://a.gipity.ai',
    ignore: [],
    ...over,
  }));
}

function writeDevice(): void {
  writeFileSync(relayFile, JSON.stringify({
    device: { guid: 'rd_capres01', name: 'test', platform: 'linux', token: 'tok-capres', paired_at: '2026-01-01T00:00:00Z' },
  }));
}

/** Stub the server. Returns the calls array for assertions. */
function stubFetch(handler?: (url: string, init: RequestInit) => Response): Array<{ url: string; body: any }> {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (handler) return handler(String(url), init);
    return new Response(JSON.stringify({ data: { conversation_guid: 'c_resolved1', title: 'chat01' } }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const HOOK = { session_id: 'aaaabbbb-1111-2222-3333-ccccddddeeee', cwd: '/home/u/proj' };

async function mod() {
  return await import('../hooks/capture-runner.js');
}

beforeEach(async () => {
  const { clearConfigCache } = await import('../config.js');
  clearConfigCache();
  delete process.env.GIPITY_CONVERSATION_GUID;
  delete process.env.GIPITY_CAPTURE;
  rmSync(captureDir, { recursive: true, force: true });
  rmSync(join(projectDir, '.gipity.json'), { force: true });
  rmSync(relayFile, { force: true });
  globalThis.fetch = (async () => { throw new Error('unexpected fetch'); }) as typeof fetch;
});

describe('resolveConvGuid: binding order', () => {
  it('env GIPITY_CONVERSATION_GUID wins outright - no config, device, or server needed', async () => {
    const { resolveConvGuid } = await mod();
    process.env.GIPITY_CONVERSATION_GUID = 'c_fromenv01';
    assert.equal(await resolveConvGuid(HOOK), 'c_fromenv01');
  });

  it('a persisted session mapping is used without touching the server', async () => {
    const { resolveConvGuid } = await mod();
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, `sid-${HOOK.session_id}.json`), JSON.stringify({ conv_guid: 'c_mapped01' }));
    assert.equal(await resolveConvGuid(HOOK), 'c_mapped01');
  });

  it('self-arms via the server and persists the mapping for later events', async () => {
    const { resolveConvGuid } = await mod();
    writeProjectConfig();
    writeDevice();
    const calls = stubFetch();

    assert.equal(await resolveConvGuid(HOOK), 'c_resolved1');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/remote-sessions\/resolve$/);
    assert.deepEqual(calls[0].body, {
      project_guid: 'p_capres01',
      session_id: HOOK.session_id,
      cwd: HOOK.cwd,
      source: 'claude_code',
    });

    // Mapping persisted → a second event resolves without the server.
    globalThis.fetch = (async () => { throw new Error('should not re-resolve'); }) as typeof fetch;
    assert.equal(await resolveConvGuid(HOOK), 'c_resolved1');
    const mapped = JSON.parse(readFileSync(join(captureDir, `sid-${HOOK.session_id}.json`), 'utf-8'));
    assert.equal(mapped.conv_guid, 'c_resolved1');
  });
});

describe('resolveConvGuid: self-arm gates', () => {
  it('no session_id → null', async () => {
    const { resolveConvGuid } = await mod();
    writeProjectConfig();
    writeDevice();
    const calls = stubFetch();
    assert.equal(await resolveConvGuid({}), null);
    assert.equal(calls.length, 0);
  });

  it('not a Gipity project (no .gipity.json) → null', async () => {
    const { resolveConvGuid } = await mod();
    writeDevice();
    const calls = stubFetch();
    assert.equal(await resolveConvGuid(HOOK), null);
    assert.equal(calls.length, 0);
  });

  it('captureHooks:false in .gipity.json opts the project out → null', async () => {
    const { resolveConvGuid } = await mod();
    writeProjectConfig({ captureHooks: false });
    writeDevice();
    const calls = stubFetch();
    assert.equal(await resolveConvGuid(HOOK), null);
    assert.equal(calls.length, 0);
  });

  it('machine not paired (no relay.json) → null', async () => {
    const { resolveConvGuid } = await mod();
    writeProjectConfig();
    const calls = stubFetch();
    assert.equal(await resolveConvGuid(HOOK), null);
    assert.equal(calls.length, 0);
  });

  it('server failure → null and NO mapping persisted (next event retries)', async () => {
    const { resolveConvGuid } = await mod();
    writeProjectConfig();
    writeDevice();
    stubFetch(() => new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }));
    assert.equal(await resolveConvGuid(HOOK), null);
    assert.equal(existsSync(join(captureDir, `sid-${HOOK.session_id}.json`)), false);
  });
});

describe('resolveConvGuid: per-session serialization', () => {
  it('a held resolve lock makes the loser poll for the winner\'s mapping instead of racing', async () => {
    const { resolveConvGuid, acquireLock } = await mod();
    writeProjectConfig();
    writeDevice();
    const calls = stubFetch();

    // A live "winner" holds the resolve lock for this session.
    const release = acquireLock(`sid-${HOOK.session_id}`);
    assert.ok(release);

    // The loser's injected sleep stands in for the winner finishing: on the
    // first tick it writes the mapping, which the poll then picks up.
    let ticks = 0;
    const sleep = async (): Promise<void> => {
      ticks++;
      mkdirSync(captureDir, { recursive: true });
      writeFileSync(join(captureDir, `sid-${HOOK.session_id}.json`), JSON.stringify({ conv_guid: 'c_winner01' }));
    };

    assert.equal(await resolveConvGuid(HOOK, 'claude_code', sleep), 'c_winner01');
    assert.equal(ticks, 1);
    assert.equal(calls.length, 0); // the loser never called the server
    release!();
  });
});

// ─── end-to-end: the runner binary, spawned as Claude Code spawns it ────
// Bare `claude` in a linked project: no GIPITY_CONVERSATION_GUID, no
// `gipity claude` parent. The SessionStart hook must resolve a conversation
// from the server, persist the mapping, and post the attach entry - the
// whole self-arm path through the real dist/ runner process.
describe('capture-runner self-arm (spawned end-to-end)', () => {
  it('session-start resolves, persists the mapping, and ingests the attach', async () => {
    const { startMockServer } = await import('./helpers/mock-server.js');
    const mock = await startMockServer();
    try {
      mock.on('POST /remote-sessions/resolve', {
        body: { data: { conversation_guid: 'c_e2earm01', title: 'chat01' } },
      });
      mock.on('POST /remote-sessions/c_e2earm01/ingest', {
        status: 201,
        body: { data: { counts: { attach: 1 } } },
      });

      writeProjectConfig();
      writeDevice();

      const runner = new URL('../hooks/capture-runner.js', import.meta.url).pathname;
      const { spawn } = await import('node:child_process');
      const env: NodeJS.ProcessEnv = { ...process.env, GIPITY_API_BASE: mock.apiBase };
      delete env.GIPITY_CONVERSATION_GUID;
      delete env.GIPITY_CAPTURE;

      const sid = 'e2e-1111-2222-3333-444455556666';
      const exit = await new Promise<number>((resolvePromise) => {
        const child = spawn(process.execPath, [runner, 'claude-code', 'session-start'], {
          cwd: projectDir,
          env,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('exit', (code) => resolvePromise(code ?? -1));
        child.stdin.end(JSON.stringify({ session_id: sid, cwd: projectDir }));
      });
      assert.equal(exit, 0, 'runner must exit 0');

      const reqs = mock.requests();
      const resolveReq = reqs.find(r => r.url === '/remote-sessions/resolve');
      assert.ok(resolveReq, 'runner called /remote-sessions/resolve');
      assert.deepEqual(resolveReq!.body, { project_guid: 'p_capres01', session_id: sid, cwd: projectDir, source: 'claude_code' });

      const ingestReq = reqs.find(r => r.url === '/remote-sessions/c_e2earm01/ingest');
      assert.ok(ingestReq, 'runner ingested into the resolved conversation');
      const entries = (ingestReq!.body as any).entries;
      assert.equal(entries[0].kind, 'attach');
      assert.equal(entries[0].session_id, sid);

      const mapped = JSON.parse(readFileSync(join(captureDir, `sid-${sid}.json`), 'utf-8'));
      assert.equal(mapped.conv_guid, 'c_e2earm01');
    } finally {
      await mock.stop();
    }
  });

  it('GIPITY_CAPTURE=off stands the runner down entirely (daemon dispatch path)', async () => {
    const { startMockServer } = await import('./helpers/mock-server.js');
    const mock = await startMockServer();
    try {
      writeProjectConfig();
      writeDevice();

      const runner = new URL('../hooks/capture-runner.js', import.meta.url).pathname;
      const { spawn } = await import('node:child_process');
      const env = {
        ...process.env,
        GIPITY_API_BASE: mock.apiBase,
        GIPITY_CAPTURE: 'off',
        GIPITY_CONVERSATION_GUID: 'c_shouldnotpost',
      };

      const exit = await new Promise<number>((resolvePromise) => {
        const child = spawn(process.execPath, [runner, 'claude-code', 'session-start'], {
          cwd: projectDir,
          env,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('exit', (code) => resolvePromise(code ?? -1));
        child.stdin.end(JSON.stringify({ session_id: 'off-sess-1', cwd: projectDir }));
      });
      assert.equal(exit, 0);
      assert.equal(mock.requests().length, 0, 'no capture traffic when GIPITY_CAPTURE=off');
    } finally {
      await mock.stop();
    }
  });
});
