/**
 * `gipity push` (pushFile) CAS behavior: when the local baseline is stale,
 * the server returns 409 and we surface a clear error that tells the user
 * to run `gipity sync`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Set HOME BEFORE importing the CLI so ~/.gipity/auth.json resolves to our tempdir.
let home: string;
let projectDir: string;
let origHome: string | undefined;
let origCwd: string;
let origFetch: typeof globalThis.fetch;

before(() => {
  origHome = process.env.HOME;
  origCwd = process.cwd();
  origFetch = globalThis.fetch;

  home = mkdtempSync(join(tmpdir(), 'gipity-pushcas-home-'));
  process.env.HOME = home;

  mkdirSync(join(home, '.gipity'), { recursive: true });
  writeFileSync(join(home, '.gipity', 'auth.json'), JSON.stringify({
    accessToken: 'fake-jwt',
    refreshToken: 'fake-refresh',
    email: 'ec-test@914-6.com',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }));

  projectDir = mkdtempSync(join(tmpdir(), 'gipity-pushcas-proj-'));
  writeFileSync(join(projectDir, '.gipity.json'), JSON.stringify({
    projectGuid: 'proj_test',
    projectSlug: 'p',
    accountSlug: 'a',
    agentGuid: 'agt_t',
    conversationGuid: null,
    apiBase: 'https://test.invalid',
    ignore: [],
  }));
  mkdirSync(join(projectDir, '.gipity'), { recursive: true });
  process.chdir(projectDir);
});

after(() => {
  process.chdir(origCwd);
  globalThis.fetch = origFetch;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = handler as unknown as typeof globalThis.fetch;
}

describe('pushFile CAS', () => {
  it('surfaces a clear error when the remote has a newer version', async () => {
    // Baseline says we last synced at serverVersion=5.
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_test',
      files: {
        'hello.txt': {
          size: 5, mtime: '2024-01-01T00:00:00.000Z',
          sha256: 'fakesha-old',
          serverVersion: 5,
        },
      },
      lastFullSync: '2024-01-01T00:00:00.000Z',
    }));
    writeFileSync(join(projectDir, 'hello.txt'), 'world');

    // Server returns 409: it's at version 7 now, client expected 5.
    stubFetch(async (url) => {
      if (url.includes('/files/upload-init')) {
        return new Response(
          JSON.stringify({
            error: { code: 'CONFLICT', message: 'Version mismatch' },
            data: { current_server_version: 7 },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    // Force-evict the module cache so our stubbed fetch is picked up cleanly.
    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { pushFile } = await import('../sync.js');

    await assert.rejects(
      () => pushFile(join(projectDir, 'hello.txt')),
      /newer version.*serverVersion=7.*gipity sync/is,
    );
  });

  it('succeeds when baseline matches - pushFile updates serverVersion in baseline', async () => {
    writeFileSync(join(projectDir, '.gipity', 'sync-state.json'), JSON.stringify({
      projectGuid: 'proj_test',
      files: {
        'greet.txt': {
          size: 5, mtime: '2024-01-01T00:00:00.000Z',
          sha256: 'fakesha-old',
          serverVersion: 3,
        },
      },
      lastFullSync: '2024-01-01T00:00:00.000Z',
    }));
    writeFileSync(join(projectDir, 'greet.txt'), 'hi-v4');

    // Server: upload-init → presigned URL. PUT to presigned URL → etag.
    // upload-complete → 200 with server_version=4.
    stubFetch(async (url, init) => {
      if (url.includes('/files/upload-init')) {
        return new Response(JSON.stringify({
          data: {
            upload_guid: 'fl_abc',
            method: 'PUT',
            url: 'https://s3.example/stage',
            expires_in: 3600,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://s3.example')) {
        // Presigned PUT - return an etag.
        return new Response('', { status: 200, headers: { etag: '"fake-etag"' } });
      }
      if (url.includes('/files/upload-complete')) {
        return new Response(JSON.stringify({
          data: { size: 5, guid: 'fl_new', version: 1, server_version: 4 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const { clearConfigCache } = await import('../config.js');
    clearConfigCache();
    const { pushFile, readBaseline } = await import('../sync.js');

    await pushFile(join(projectDir, 'greet.txt'));

    const bl = readBaseline('proj_test');
    assert.ok(bl.files['greet.txt'], 'greet.txt should be in baseline');
    assert.equal(bl.files['greet.txt'].serverVersion, 4, 'baseline should reflect bumped server version');
  });
});
