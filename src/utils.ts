import { createInterface } from 'readline';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { bold, dim } from './colors.js';

/** True inside Windows Subsystem for Linux (either env marker or kernel
 *  string). WSL ships without a systemd user session unless the user opts in
 *  via /etc/wsl.conf, and Windows-side paths live under /mnt/c. */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

const WINDOWS_PSEUDO_USERS = new Set(['All Users', 'Default', 'Default User', 'Public', 'desktop.ini']);

/** Under WSL, find a same-named project folder on the Windows side
 *  (C:\Users\<name>\GipityProjects\<dir>) that is NOT the linked project.
 *  From Windows Explorer that folder looks like "the project", so users drop
 *  new files there - but nothing syncs from it. Returns the twin's WSL path,
 *  or null when there is no twin (or no Windows mount at all). */
export function findWindowsTwinProject(projectRoot: string, usersBase = '/mnt/c/Users'): string | null {
  try {
    const name = basename(projectRoot);
    if (!name) return null;
    const realRoot = realpathSync(projectRoot);
    for (const user of readdirSync(usersBase)) {
      if (WINDOWS_PSEUDO_USERS.has(user)) continue;
      const candidate = join(usersBase, user, 'GipityProjects', name);
      try {
        if (!statSync(candidate).isDirectory()) continue;
        if (realpathSync(candidate) === realRoot) continue; // the linked project itself lives on /mnt/c
        return candidate;
      } catch {
        // this user has no such folder - keep scanning
      }
    }
  } catch {
    // usersBase unreadable: not WSL, or no C: mount
  }
  return null;
}

/** /mnt/c/Users/steve/... -> C:\Users\steve\... for display to a Windows user. */
export function wslPathToWindows(p: string): string {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

/** Safely decode a JWT payload without signature validation */
export function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Prompt the user for input on stdin.
 *  Fails fast if stdin is not a TTY (e.g. when spawned by the relay
 *  daemon with `stdio: ['ignore', ...]`) - otherwise `readline` blocks
 *  indefinitely on a closed stdin, hanging the dispatch until the web
 *  CLI's 8-second latch gives up. Turning that into a loud error lets
 *  the daemon ack the dispatch cleanly and surface a real message. */
export function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(`prompt() called without a TTY: ${question.trim()}`));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Bordered free-text prompt matching Claude Code's input box:
 *    ─────────────
 *    ❯
 *    ─────────────
 *  Returns the user's trimmed input. */
export async function promptBoxed(): Promise<string> {
  const cols = process.stdout.columns || 80;
  const rule = dim('─'.repeat(Math.max(40, Math.min(cols, 140))));
  console.log(rule);
  const answer = await prompt('❯ ');
  console.log(rule);
  return answer;
}

let _autoConfirm = false;
export function setAutoConfirm(val: boolean): void { _autoConfirm = val; }
export function getAutoConfirm(): boolean { return _autoConfirm; }

/** Reconstruct the current invocation with `--yes` appended, for self-correcting
 *  non-interactive confirmation hints. Shell-quotes args that need it. */
function rerunWithYes(): string {
  const args = process.argv.slice(2);
  if (!args.some(a => a === '--yes' || a === '-y')) args.push('--yes');
  const quote = (a: string) => (/[^\w@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
  return `gipity ${args.map(quote).join(' ')}`;
}

/** Ask for Y/n confirmation. Single-keypress - no Enter required.
 *
 *  - `opts.default` controls which answer Enter / unknown-key selects. Defaults to `'no'`.
 *  - `opts.skip` (or the global `--yes` flag) auto-returns `true`.
 *  - Renders a `[Y/n]:` or `[y/N]:` hint automatically - callers should NOT
 *    append their own y/N suffix (or a trailing `?`/`:`) to `question`.
 *  - In non-TTY environments without `--yes`, this EXITS the process with code 1
 *    (it never returns) - see the comment in the body for why. Pass
 *    `{ headless: 'no' }` for prompts that merely OFFER something optional,
 *    where declining is a normal successful outcome. */
export async function confirm(
  question: string,
  opts: { default?: 'yes' | 'no'; skip?: boolean; headless?: 'no' } = {},
): Promise<boolean> {
  const defaultYes = opts.default === 'yes';
  if (opts.skip ?? _autoConfirm) return true;
  if (!process.stdin.isTTY) {
    // Headless/agent context: no one can answer the prompt. For an optional
    // offer, declining and carrying on is the right answer (`headless: 'no'`).
    // For everything else the command did NOT do what it was asked to do, so
    // exit non-zero: an agent that pipes or suppresses output
    // (`gipity records delete games 1 --purge >/dev/null 2>&1`) otherwise sees
    // a clean exit 0 and believes the delete happened, then burns turns
    // discovering it silently cancelled. The exit status is the only signal
    // that survives redirection. The message echoes the exact command to
    // re-run so the fix is copy-paste, not a second guessing trip.
    if (opts.headless === 'no') return false;
    console.error(`Confirmation required (non-interactive). Re-run with --yes:\n  ${rerunWithYes()}`);
    process.exit(1);
  }
  const hint = defaultYes ? dim('[Y/n]') : dim('[y/N]');
  process.stdout.write(`${question} ${hint}: `);

  const { stdin } = process;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<boolean>(resolve => {
    stdin.once('data', (key: Buffer) => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      const ch = key.toString();
      if (ch === '\x03') { console.log(''); process.exit(130); }
      const k = ch.toLowerCase();
      let answer: boolean;
      if (k === 'y') answer = true;
      else if (k === 'n') answer = false;
      else answer = defaultYes; // Enter or any other key → default
      console.log(answer ? 'y' : 'n');
      resolve(answer);
    });
  });
}

/**
 * Single-keypress picker for 1–9 options.
 * Returns the 1-based index chosen, or `defaultIdx` on Enter.
 */
export function pickOne(
  label: string,
  max: number,
  defaultIdx = 1,
): Promise<number> {
  return new Promise(resolve => {
    process.stdout.write(`  ${bold(label)} (1-${max}) [${bold(String(defaultIdx))}]: `);
    const { stdin } = process;
    const wasRaw = stdin.isRaw ?? false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (key: Buffer) => {
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      const ch = key.toString();
      // Ctrl-C
      if (ch === '\x03') { console.log(''); process.exit(0); }
      // Enter → default
      if (ch === '\r' || ch === '\n') { console.log(String(defaultIdx)); return resolve(defaultIdx); }
      const n = parseInt(ch, 10);
      if (n >= 1 && n <= max) { console.log(String(n)); return resolve(n); }
      // Invalid key → default
      console.log(String(defaultIdx));
      resolve(defaultIdx);
    });
  });
}

/** Check if a file is likely binary by reading its first bytes */
export function isBinaryFile(buffer: Buffer): boolean {
  // Check for null bytes in first 8KB - reliable binary indicator
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/** Format an ISO timestamp as a relative age string */
export function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Format byte count as human-readable string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
