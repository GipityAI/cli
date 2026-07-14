/**
 * Machine-level user preferences (~/.gipity/prefs.json) - the `gipity build`
 * picker's memory. Deliberately NOT in a project's .gipity.json: per-project
 * storage would re-ask the agent/model questions on every new project, which
 * defeats "hit enter twice".
 *
 * Shape:
 *   {
 *     "lastAgent": "claude",
 *     "lastModel": { "claude": "opus", "codex": null }   // per-agent so a
 *   }                                                    // Codex session never
 *                                                        // clobbers the Claude pick
 *
 * A `lastModel` of null/absent means "Agent default" - launch passes no
 * model flag and the agent's own model memory stays authoritative.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Prefs {
  lastAgent?: string;
  lastModel?: Record<string, string | null>;
}

const PREFS_PATH = join(homedir(), '.gipity', 'prefs.json');

export function readPrefs(): Prefs {
  if (!existsSync(PREFS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf-8'));
    return {
      lastAgent: typeof parsed.lastAgent === 'string' ? parsed.lastAgent : undefined,
      lastModel: parsed.lastModel && typeof parsed.lastModel === 'object' ? parsed.lastModel : undefined,
    };
  } catch {
    return {}; // unreadable prefs must never block a launch
  }
}

export function writePrefs(update: Partial<Prefs>): void {
  try {
    const current = readPrefs();
    const next: Prefs = {
      ...current,
      ...update,
      lastModel: { ...current.lastModel, ...update.lastModel },
    };
    mkdirSync(join(homedir(), '.gipity'), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(next, null, 2) + '\n');
  } catch {
    /* best-effort - prefs are a convenience */
  }
}
