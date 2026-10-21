import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Every temp home/project made here is removed when the test process exits.
// Without this each smoke run left ~160 dirs behind (some tests write a CLI
// shim and a .gip bundle into the home, ~160 MB each), which filled /tmp.
const created: string[] = [];
process.on('exit', () => {
  for (const dir of created) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
/** A temp dir removed when this test process exits. Use it instead of a bare
 *  mkdtempSync in tests. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export interface AuthedHomeOpts {
  /** Override the email stored in auth.json. Default: ec-test@914-6.com (blocked from real SendGrid). */
  email?: string;
  /** Override the access token. Default: fake-jwt. */
  accessToken?: string;
}

/**
 * Create a temp HOME with a pre-populated `~/.gipity/auth.json` so commands
 * that call `requireAuth()` succeed without going through magic-code flow.
 * Returned path is meant to be passed as `env.HOME` to `runCliAsync`.
 */
export function makeAuthedHome(opts: AuthedHomeOpts = {}): string {
  const home = tempDir('gipity-cli-cmd-');
  mkdirSync(join(home, '.gipity'), { recursive: true });
  writeFileSync(join(home, '.gipity', 'auth.json'), JSON.stringify({
    accessToken: opts.accessToken ?? 'fake-jwt',
    refreshToken: 'fake-refresh',
    email: opts.email ?? 'ec-test@914-6.com',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }));
  return home;
}

export interface ProjectDirOpts {
  projectGuid?: string;
  projectSlug?: string;
  accountSlug?: string;
  /** Legacy key: `.gipity.json` files written before the agent primitive was
   *  archived carry one. Set it to prove such a config still loads. */
  agentGuid?: string;
  apiBase?: string;
}

/** Create a temp project directory with a `.gipity.json` so commands that
 *  rely on `requireConfig()` work. Returned path is meant to be passed as `cwd`. */
export function makeProjectDir(opts: ProjectDirOpts = {}): string {
  const dir = tempDir('gipity-cli-proj-');
  writeFileSync(join(dir, '.gipity.json'), JSON.stringify({
    projectGuid: opts.projectGuid ?? 'p_TestProj',
    projectSlug: opts.projectSlug ?? 'test-project',
    accountSlug: opts.accountSlug ?? 'test-account',
    ...(opts.agentGuid ? { agentGuid: opts.agentGuid } : {}),
    conversationGuid: null,
    apiBase: opts.apiBase ?? 'http://127.0.0.1:0',
    ignore: [],
  }));
  return dir;
}
