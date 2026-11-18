/**
 * changelog.ts - what's new in Gipity, read from the server's GET /changelog
 * (platform/CHANGELOG.md), plus the small machine-level memory of what this
 * user has already seen (~/.gipity/changelog.json):
 *
 *   { "baselineCli": "1.1.42",   CLI version when this file was first written;
 *                                 `--newer` starts here until something is seen
 *     "seenEntry": "2026-11-18-scoped-api-keys",
 *     "seenDate": "2026-11-18",   newest entry the user (or their agent) viewed
 *     "noticedCli": "1.1.42" }    last CLI version the update notice ran on
 *
 * `gipity changelog --newer` lists entries above the seen one, and after the
 * CLI auto-updates the first interactive command prints one line saying how
 * many there are.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GIPITY_DIR } from './updater/state.js';
import { compareSemver } from './updater/check.js';
import { publicRequest } from './api.js';
import { muted, brand } from './colors.js';

export interface ChangelogEntry {
  id: string;
  date: string;
  title: string;
  server: string | null;
  cli: string | null;
  bullets: string[];
  breaking: string[];
  skills: string[];
}

export interface ChangelogState {
  baselineCli?: string;
  seenEntry?: string;
  seenDate?: string;
  noticedCli?: string;
}

const STATE_FILE = () => join(GIPITY_DIR, 'changelog.json');

export function readChangelogState(): ChangelogState | null {
  if (!existsSync(STATE_FILE())) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as ChangelogState : null;
  } catch {
    return null; // a corrupt file is rebuilt; it only remembers what was seen
  }
}

export function writeChangelogState(state: ChangelogState): void {
  mkdirSync(GIPITY_DIR, { recursive: true });
  writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2) + '\n');
}

/** Read the state, creating it with this CLI version as the baseline. */
export function ensureChangelogState(currentCli: string): ChangelogState {
  const existing = readChangelogState();
  if (existing) return existing;
  const fresh: ChangelogState = { baselineCli: currentCli, noticedCli: currentCli };
  writeChangelogState(fresh);
  return fresh;
}

export async function fetchChangelog(
  query: { since?: string; last?: number },
  timeoutMs?: number,
): Promise<ChangelogEntry[]> {
  const params = new URLSearchParams();
  if (query.since) params.set('since', query.since);
  if (query.last !== undefined) params.set('last', String(query.last));
  const res = await publicRequest<{ data: { entries: ChangelogEntry[] } }>(
    'GET', `/changelog?${params}`, undefined, undefined, timeoutMs,
  );
  return res.data.entries;
}

/** Entries the user hasn't seen: above the seen entry, or (nothing seen yet)
 *  everything that shipped after the CLI version they started from. */
export async function fetchNewer(state: ChangelogState, currentCli: string, timeoutMs?: number): Promise<ChangelogEntry[]> {
  if (state.seenEntry && state.seenDate) {
    const entries = await fetchChangelog({ since: state.seenDate }, timeoutMs);
    const at = entries.findIndex((e) => e.id === state.seenEntry);
    return at === -1 ? entries.filter((e) => e.date > state.seenDate!) : entries.slice(0, at);
  }
  return fetchChangelog({ since: `cli:${state.baselineCli ?? currentCli}` }, timeoutMs);
}

/** Every filter returns entries from the newest down, so the first one shown
 *  is the newest the user has now seen. */
export function markSeen(state: ChangelogState, shown: ChangelogEntry[]): ChangelogState {
  if (shown.length === 0) return state;
  const next = { ...state, seenEntry: shown[0].id, seenDate: shown[0].date };
  writeChangelogState(next);
  return next;
}

/** `gipity changelog --newer` in one line, or null when there's nothing new. */
export function updateNoticeLine(count: number): string | null {
  if (count <= 0) return null;
  return `${muted(`${count} update${count === 1 ? '' : 's'} since you last looked:`)} ${brand('gipity changelog --newer')}`;
}

/**
 * Called before every command. Records the baseline on first run. On the first
 * interactive (TTY, non-JSON) command after the CLI's version went up (the
 * auto-updater installed a new one), prints one line with the number of unseen
 * entries, once. Never prints off a TTY or with --json, and never delays a
 * command by more than the short fetch timeout; a failed fetch prints nothing
 * (the notice is a hint, and `gipity changelog --newer` reports real errors).
 */
export async function maybePrintUpdateNotice(
  currentCli: string,
  opts: { interactive: boolean; timeoutMs?: number; print?: (line: string) => void },
): Promise<void> {
  const state = ensureChangelogState(currentCli);
  if (!opts.interactive) return;
  if (state.noticedCli && compareSemver(currentCli, state.noticedCli) <= 0) return;
  writeChangelogState({ ...state, noticedCli: currentCli });
  let count: number;
  try {
    count = (await fetchNewer(state, currentCli, opts.timeoutMs ?? 2000)).length;
  } catch {
    return;
  }
  const line = updateNoticeLine(count);
  if (line) (opts.print ?? console.log)(line);
}
