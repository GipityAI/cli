import { spawnSync, spawn, SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname is dist/__tests__/helpers — CLI entry is dist/index.js
export const CLI_ENTRY = resolve(__dirname, '..', '..', 'index.js');

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface SpawnOptions {
  /** Extra/overriding env vars (merged on top of the sanitized base env). */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  /** ms before the spawn is killed. Default 15000. */
  timeout?: number;
  /** If true, do NOT set DISABLE_AUTOUPDATER (Tier C wants normal startup). */
  enableUpdater?: boolean;
}

/**
 * Run the built gipity CLI with a deterministic, isolated environment.
 * Returns combined stdout/stderr text plus exit status.
 */
export function runCli(args: string[], opts: SpawnOptions = {}): SpawnResult {
  const baseEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: opts.env?.['HOME'] ?? mkdtempSync(`${tmpdir()}/gipity-cli-test-`),
    NO_COLOR: '1',
    CI: '1',
  };
  if (!opts.enableUpdater) baseEnv['DISABLE_AUTOUPDATER'] = '1';

  const env = { ...baseEnv, ...opts.env };

  const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    cwd: opts.cwd ?? process.cwd(),
    env,
    timeout: opts.timeout ?? 15000,
  };

  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], spawnOpts);
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status ?? -1,
  };
}

export function makeTmpHome(): string {
  return mkdtempSync(`${tmpdir()}/gipity-cli-test-`);
}

/**
 * Async version of runCli — uses `spawn` instead of `spawnSync` so the
 * test's event loop keeps turning while the child runs. Required for any
 * test that spins up an in-process HTTP server for the child to hit
 * (spawnSync deadlocks because the server can't accept connections while
 * the event loop is blocked).
 */
export async function runCliAsync(args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  const baseEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: opts.env?.['HOME'] ?? mkdtempSync(`${tmpdir()}/gipity-cli-test-`),
    NO_COLOR: '1',
    CI: '1',
  };
  if (!opts.enableUpdater) baseEnv['DISABLE_AUTOUPDATER'] = '1';
  const env = { ...baseEnv, ...opts.env };

  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });

  const timeoutMs = opts.timeout ?? 15000;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

  const status: number = await new Promise(resolve => {
    child.on('exit', code => { clearTimeout(timer); resolve(code ?? -1); });
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
  });
  return { stdout, stderr, status };
}
