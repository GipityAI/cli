import { mkdirSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
  const home = mkdtempSync(join(tmpdir(), 'gipity-cli-cmd-'));
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
  agentGuid?: string | null;
  apiBase?: string;
}

/** Create a temp project directory with a `.gipity.json` so commands that
 *  rely on `requireConfig()` work. Returned path is meant to be passed as `cwd`. */
export function makeProjectDir(opts: ProjectDirOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gipity-cli-proj-'));
  writeFileSync(join(dir, '.gipity.json'), JSON.stringify({
    projectGuid: opts.projectGuid ?? 'p_TestProj',
    projectSlug: opts.projectSlug ?? 'test-project',
    accountSlug: opts.accountSlug ?? 'test-account',
    agentGuid: opts.agentGuid ?? 'a_TestAgnt',
    conversationGuid: null,
    apiBase: opts.apiBase ?? 'http://127.0.0.1:0',
    ignore: [],
  }));
  return dir;
}
