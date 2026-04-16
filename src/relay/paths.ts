/**
 * Shared path/dir helpers used by both the daemon and `gipity claude`.
 * Extracted from `commands/claude.ts` so the daemon can reuse it without
 * pulling in the whole command module.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** Directory under which all remote-materialized Gipity projects live.
 *  Default: `~/GipityProjects/`. User-overridable via
 *  `~/.gipity/settings.json` → `projectsDir`. First call writes the
 *  default into settings.json so it's discoverable. */
export function getProjectsRoot(): string {
  const settingsPath = join(homedir(), '.gipity', 'settings.json');
  const defaultDir = join(homedir(), 'GipityProjects');
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.projectsDir) return resolve(settings.projectsDir);
    } else {
      mkdirSync(join(homedir(), '.gipity'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ projectsDir: defaultDir }, null, 2) + '\n');
    }
  } catch { /* fall through */ }
  return defaultDir;
}
