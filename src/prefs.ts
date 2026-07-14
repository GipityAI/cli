/**
 * Machine-level user preferences (~/.gipity/prefs.json) - the `gipity build`
 * agent picker's memory. Deliberately NOT in a project's .gipity.json:
 * per-project storage would re-ask the agent question on every new project,
 * which defeats "hit enter twice".
 *
 * Shape:
 *   { "lastAgent": "claude" }
 *
 * The model is never stored: `gipity build` doesn't ask, so the agent's own
 * default (and its own model memory) stays authoritative unless the user
 * passes --model, which we forward verbatim.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Prefs {
  lastAgent?: string;
}

const PREFS_PATH = join(homedir(), '.gipity', 'prefs.json');

export function readPrefs(): Prefs {
  if (!existsSync(PREFS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf-8'));
    return {
      lastAgent: typeof parsed.lastAgent === 'string' ? parsed.lastAgent : undefined,
    };
  } catch {
    return {}; // unreadable prefs must never block a launch
  }
}

export function writePrefs(update: Partial<Prefs>): void {
  try {
    const current = readPrefs();
    const next: Prefs = { ...current, ...update };
    mkdirSync(join(homedir(), '.gipity'), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(next, null, 2) + '\n');
  } catch {
    /* best-effort - prefs are a convenience */
  }
}
