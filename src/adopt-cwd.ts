/**
 * Shared helpers for adopting the current working directory as a Gipity
 * project. Used by both `gipity init` and `gipity claude`'s "Use this
 * directory" picker option.
 *
 * The whole flow:
 *   1. `scanForAdoption(cwd)` - bound the size to keep us from sucking in a
 *      huge monorepo or someone's $HOME by accident.
 *   2. `adoptCurrentDir(...)` - find-or-create a server project keyed by the
 *      cwd's slugified basename, then `finalizeLocalProject` to write
 *      `.gipity.json`, sync, and install hooks/skills/gitignore.
 */
import { readdirSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { get, post, ApiError } from './api.js';
import { isSyncIgnored, SUPPORTED_TOOLS } from './setup.js';
import { finalizeLocalProject } from './project-setup.js';
import { getProjectsRoot } from './relay/paths.js';
import * as relayState from './relay/state.js';

export interface ProjectData {
  short_guid: string;
  name: string;
  slug: string;
}

interface AgentData {
  short_guid: string;
  name: string;
}

export type AdoptTier = 'easy' | 'moderate' | 'refuse';

export interface AdoptScan {
  tier: AdoptTier;
  files: number;
  bytes: number;
  /** True once we hit the refuse threshold and stopped walking. */
  truncated: boolean;
}

const EASY_FILES = 200;
const EASY_BYTES = 100 * 1024 * 1024;        // 100 MB
const REFUSE_FILES = 2000;
const REFUSE_BYTES = 1024 * 1024 * 1024;     // 1 GB

/** Walk `cwd` (respecting `isSyncIgnored`) and bucket by file count + size.
 *  Bails out early once we cross either refuse threshold so a 1M-file dir
 *  doesn't take seconds to count. */
export function scanForAdoption(cwd: string): AdoptScan {
  let files = 0;
  let bytes = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (truncated) return;
      if (isSyncIgnored(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        if (files > REFUSE_FILES || bytes > REFUSE_BYTES) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(cwd);

  let tier: AdoptTier;
  if (truncated || files > REFUSE_FILES || bytes > REFUSE_BYTES) tier = 'refuse';
  else if (files > EASY_FILES || bytes > EASY_BYTES) tier = 'moderate';
  else tier = 'easy';

  return { tier, files, bytes, truncated };
}

/** Treat cwd as "empty" if it has no entries that aren't sync-ignored
 *  (dotfiles, node_modules, .git, etc.). When true, the picker should still
 *  offer the "what would you like to build?" prompt so Claude can scaffold
 *  in place. */
export function isLikelyEmpty(cwd: string): boolean {
  let entries: string[];
  try { entries = readdirSync(cwd); } catch { return true; }
  return entries.every(isSyncIgnored);
}

/** Hide-list for "Use this directory" - places where adopting cwd as a
 *  project is obviously wrong. Exact-match only; subdirectories are fine
 *  (e.g. `/tmp/scratch` is allowed, just not `/tmp` itself). */
export function canAdoptCwd(cwd: string): boolean {
  const norm = resolve(cwd);
  const home = resolve(homedir());

  // Exact root/home/system paths - adopting these would scoop the world.
  const blocked = new Set([
    sep,
    home,
    resolve(getProjectsRoot()),
    '/tmp', '/var', '/etc', '/usr', '/opt',
    '/mnt', '/mnt/c', '/mnt/d', '/mnt/wsl',
  ]);
  if (blocked.has(norm)) return false;

  // Workspace-parent heuristic: a directory at depth ≤1 below $HOME that
  // contains 3+ subdirectories with their own `.git/` is almost certainly
  // a parent like `~/Github/` - not a single project.
  if (norm.startsWith(home + sep)) {
    const depth = norm.slice(home.length + 1).split(sep).length;
    if (depth <= 1 && countGitRepoChildren(norm) >= 3) return false;
  }

  return true;
}

/** Count immediate subdirectories of `dir` that contain a `.git/` entry.
 *  Bounded to first 50 entries - enough to flag a workspace dir without
 *  walking everything. */
function countGitRepoChildren(dir: string): number {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }
  let count = 0;
  for (const name of entries.slice(0, 50)) {
    if (name.startsWith('.')) continue;
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
      const gitPath = join(child, '.git');
      if (statSync(gitPath)) count++;
    } catch { /* not a repo */ }
    if (count >= 3) return count;
  }
  return count;
}

/** Format `cwd` as a short two-segment tail for picker labels:
 *    /home/steve/Github/Gipity → ~/Github/Gipity (collapse home)
 *    /tmp/scratch              → /tmp/scratch
 *  Used to give the user enough context to recognize the dir without
 *  taking up the whole line. */
export function formatCwdLabel(cwd: string): string {
  const norm = resolve(cwd);
  const home = resolve(homedir());
  if (norm === home) return '~';
  if (norm.startsWith(home + sep)) {
    const tail = norm.slice(home.length + 1).split(sep);
    if (tail.length <= 2) return '~/' + tail.join('/');
    return '~/…/' + tail.slice(-2).join('/');
  }
  // Outside home: show parent/this for non-root paths.
  const parts = norm.split(sep).filter(Boolean);
  if (parts.length <= 1) return norm;
  return parts.slice(-2).join('/');
}

/** Format byte count handling KB/MB/GB. utils.formatSize tops out at MB,
 *  which prints "1024.0 MB" for the 1 GB refuse threshold. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface AdoptResult {
  project: ProjectData;
  isNew: boolean;
  agentGuid: string;
  accountSlug: string;
  applied: number;
}

/** Adopt `cwd` as a Gipity project. Mirrors `gipity init`'s flow:
 *    1. Slug = slugify(basename(cwd)) - provided by caller (so caller can
 *       validate/prompt as needed).
 *    2. Try to match an existing server project by slug; adopt if found.
 *    3. Otherwise POST /projects with relay-device wiring.
 *    4. Fetch agent + account, then `finalizeLocalProject` to write config,
 *       sync, and install hooks/skills/gitignore.
 *  Caller is responsible for the size-tier check before calling. */
export async function adoptCurrentDir(opts: {
  cwd: string;
  projectName: string;
  projectSlug: string;
  accountSlug: string;
  confirmDeletions: boolean;
  /** Force a specific agent guid; skip the auto-lookup. */
  agentOverride?: string;
  /** Subset of AI-tool primers to write. Defaults to all. */
  tools?: typeof SUPPORTED_TOOLS;
}): Promise<AdoptResult> {
  // Try to match an existing project by slug. Lets the user re-adopt a
  // project they previously created from this dir on another machine.
  let project: ProjectData | null = null;
  try {
    const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=1000');
    project = res.data.find(p => p.slug === opts.projectSlug) || null;
  } catch {
    // List failed - fall through to POST.
  }

  let isNew = false;
  if (!project) {
    const device = relayState.getDevice();
    const body: { name: string; slug: string; autoChat?: 'claude_code'; deviceGuid?: string } = {
      name: opts.projectName,
      slug: opts.projectSlug,
    };
    if (device) { body.autoChat = 'claude_code'; body.deviceGuid = device.guid; }
    try {
      const res = await post<{ data: ProjectData }>('/projects', body);
      project = res.data;
      isNew = true;
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        // Race: re-fetch and adopt the conflicting one (someone else just
        // took the slug - likely the same user from another tab).
        const res = await get<{ data: ProjectData[]; totalCount: number }>('/projects?limit=1000');
        const found = res.data.find(p => p.slug === opts.projectSlug);
        if (!found) throw err;
        project = found;
      } else {
        throw err;
      }
    }
  }

  // Fetch the project's agent (if any). An explicit override wins.
  let agentGuid = opts.agentOverride ?? '';
  if (!agentGuid) {
    try {
      const agents = await get<{ data: AgentData[] }>(`/projects/${project.short_guid}/agents`);
      if (agents.data.length > 0) agentGuid = agents.data[0].short_guid;
    } catch { /* no agents */ }
  }

  const { applied } = await finalizeLocalProject({
    dir: opts.cwd,
    projectGuid: project.short_guid,
    projectSlug: project.slug,
    projectName: project.name,
    accountSlug: opts.accountSlug,
    agentGuid,
    sync: 'strict',
    interactive: opts.confirmDeletions,
    tools: opts.tools,
  });

  return { project, isNew, agentGuid, accountSlug: opts.accountSlug, applied };
}

/** Re-export so callers can unify on these constants for messaging. */
export const ADOPT_THRESHOLDS = {
  EASY_FILES, EASY_BYTES, REFUSE_FILES, REFUSE_BYTES,
};
