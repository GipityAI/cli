import { createInterface } from 'readline';
import { bold, dim } from './colors.js';

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
 *  daemon with `stdio: ['ignore', ...]`) — otherwise `readline` blocks
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

/** Ask for Y/n confirmation. Single-keypress — no Enter required.
 *
 *  - `opts.default` controls which answer Enter / unknown-key selects. Defaults to `'no'`.
 *  - `opts.skip` (or the global `--yes` flag) auto-returns `true`.
 *  - Renders a `[Y/n]` or `[y/N]` hint automatically — callers should NOT append
 *    their own y/N suffix to `question`.
 *  - In non-TTY environments without `--yes`, returns `false` and prints a hint. */
export async function confirm(
  question: string,
  opts: { default?: 'yes' | 'no'; skip?: boolean } = {},
): Promise<boolean> {
  const defaultYes = opts.default === 'yes';
  if (opts.skip ?? _autoConfirm) return true;
  if (!process.stdin.isTTY) {
    console.error('Confirmation required. Use --yes to skip prompts.');
    return false;
  }
  const hint = defaultYes ? dim('[Y/n]') : dim('[y/N]');
  process.stdout.write(`${question} ${hint} `);

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
  // Check for null bytes in first 8KB — reliable binary indicator
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
