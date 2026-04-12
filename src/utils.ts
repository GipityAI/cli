import { createInterface } from 'readline';
import { bold } from './colors.js';

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

/** Prompt the user for input on stdin */
export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

let _autoConfirm = false;
export function setAutoConfirm(val: boolean): void { _autoConfirm = val; }
export function getAutoConfirm(): boolean { return _autoConfirm; }

/** Ask for y/N confirmation. Skips if auto-confirm is set or `skip` is true.
 *  Rejects safely in non-TTY environments without --yes. */
export async function confirm(question: string, skip?: boolean): Promise<boolean> {
  if (skip ?? _autoConfirm) return true;
  if (!process.stdin.isTTY) {
    console.error('Confirmation required. Use --yes to skip prompts.');
    return false;
  }
  const answer = await prompt(question);
  return answer.toLowerCase() === 'y';
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
