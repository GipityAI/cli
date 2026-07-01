import { execSync, spawn, spawnSync } from 'child_process';
import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from 'child_process';

/**
 * Resolve a command to a concrete path when possible.
 *
 * On Windows, npm-installed CLIs (npm, npx, gipity, claude) are `.cmd` batch
 * shims, not `.exe`s. A bare `npm` fails to spawn with ENOENT, so we resolve
 * the real path (preferring a native `.exe`, falling back to the `.cmd` shim).
 *
 * NOTE: resolving to the `.cmd` path is NOT enough on its own. Since Node
 * 18.20.2 / 20.12.2 (the CVE-2024-27980 fix), `spawn`/`spawnSync` REFUSE to
 * launch a `.cmd`/`.bat` target unless `shell: true` - they throw `EINVAL`.
 * So always launch a resolved command through `spawnCommand` /
 * `spawnSyncCommand` below, which route batch shims through cmd.exe safely.
 */
export function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  try {
    const lines = execSync(`where ${cmd}`, { encoding: 'utf-8' })
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    // Prefer .exe (native) over .cmd (npm shim)
    return lines.find(l => l.endsWith('.exe')) || lines.find(l => l.endsWith('.cmd')) || cmd;
  } catch {
    return `${cmd}.cmd`;
  }
}

/** True for a Windows batch shim that Node cannot spawn without a shell. */
export function isBatchShim(cmd: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
}

/**
 * Build a cmd.exe invocation that launches a `.cmd`/`.bat` shim with its args
 * passed through verbatim - the correct way to run a batch file post-CVE
 * without `shell: true` mangling argument quoting.
 *
 * `cmd.exe /d /s /c "<line>"`: `/d` skips AutoRun, `/s` + the wrapping outer
 * quotes make cmd strip exactly the first and last quote of the whole line
 * (leaving each already-quoted token intact). We quote every token ourselves
 * and set `windowsVerbatimArguments` so Node hands our line to cmd untouched.
 */
export function winBatchInvocation(
  cmd: string,
  args: readonly string[],
): { file: string; args: string[] } {
  const comspec = process.env.ComSpec || 'cmd.exe';
  // Double-quote each token; escape any embedded double-quote as "" (cmd's
  // in-quote escape). Our call sites pass flags/paths/guids with no cmd
  // metacharacters, so this conservative quoting is sufficient and safe.
  const quote = (t: string) => `"${String(t).replace(/"/g, '""')}"`;
  const line = [cmd, ...args].map(quote).join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`] };
}

/**
 * Drop-in `spawn` that survives Windows batch shims. When `cmd` is a `.cmd`/
 * `.bat` on win32, it is launched via cmd.exe with verbatim arguments;
 * otherwise this is a plain `spawn`. Use for anything from `resolveCommand`.
 */
export function spawnCommand(
  cmd: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  if (isBatchShim(cmd)) {
    const inv = winBatchInvocation(cmd, args);
    return spawn(inv.file, inv.args, { ...options, windowsVerbatimArguments: true });
  }
  return spawn(cmd, [...args], options);
}

/** Drop-in `spawnSync` counterpart of {@link spawnCommand}. */
export function spawnSyncCommand(
  cmd: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  if (isBatchShim(cmd)) {
    const inv = winBatchInvocation(cmd, args);
    return spawnSync(inv.file, inv.args, { ...options, windowsVerbatimArguments: true });
  }
  return spawnSync(cmd, [...args], options);
}
