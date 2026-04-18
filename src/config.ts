import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface GipityConfig {
  projectGuid: string;
  projectSlug: string;
  accountSlug: string;
  agentGuid: string;
  conversationGuid: string | null;
  apiBase: string;
  ignore: string[];
}

const CONFIG_FILE = '.gipity.json';

let cached: GipityConfig | null = null;
let cachedPath: string | null = null;

/** Global --api-base override (set from root CLI option, takes precedence over config file) */
let apiBaseOverride: string | null = null;

export function setApiBaseOverride(url: string): void {
  apiBaseOverride = url;
}

export function getApiBaseOverride(): string | null {
  return apiBaseOverride;
}

/** Find .gipity.json starting from cwd and walking up */
function findConfigPath(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = resolve(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return null; // reached root
    dir = parent;
  }
}

export function getConfigPath(): string | null {
  if (cachedPath !== null) return cachedPath;
  cachedPath = findConfigPath();
  return cachedPath;
}

export function getConfig(): GipityConfig | null {
  if (cached) return cached;
  const path = getConfigPath();
  if (!path) return null;
  try {
    cached = JSON.parse(readFileSync(path, 'utf-8'));
    return cached;
  } catch {
    return null;
  }
}

export function requireConfig(): GipityConfig {
  const config = getConfig();
  if (!config) {
    console.error('Not a Gipity project. Run: gipity init');
    process.exit(1);
  }
  return config;
}

export interface ResolvedContext {
  config: GipityConfig;
  /** True when the config wasn't found via cwd-walk and we fell back to the user's Home project (or an explicit --project override). No local file tree to sync; commands should print a one-off banner and download artifacts to cwd. */
  oneOff: boolean;
}

/**
 * Resolve project context for commands that opt into the Home-fallback behavior.
 * Order: explicit projectOverride flag → cwd-walk for .gipity.json → server's default ("Home") project.
 * Errors clearly when not logged in or when the server has no default project for the user.
 */
export async function resolveProjectContext(opts?: { projectOverride?: string }): Promise<ResolvedContext> {
  const { getAuth } = await import('./auth.js');
  const { get, getAccountSlug } = await import('./api.js');
  const { dim } = await import('./colors.js');

  // 1. Explicit --project override always wins.
  if (opts?.projectOverride) {
    if (!getAuth()) {
      console.error('Not logged in. Run: gipity login');
      process.exit(1);
    }
    const target = opts.projectOverride;
    const res = await get<{ data: Array<{ short_guid: string; slug: string; name: string }> }>('/projects?limit=200');
    const match = res.data.find(p => p.short_guid === target || p.slug === target);
    if (!match) {
      console.error(`Project not found: ${target}`);
      process.exit(1);
    }
    const agents = await get<{ data: Array<{ short_guid: string }> }>(`/projects/${match.short_guid}/agents`);
    const accountSlug = await getAccountSlug();
    console.error(dim(`→ One-off mode: targeting project "${match.slug}" (--project override).`));
    console.error(dim(`→ Files are not synced — outputs will also be downloaded to ./ for you.`));
    return {
      config: {
        projectGuid: match.short_guid,
        projectSlug: match.slug,
        accountSlug,
        agentGuid: agents.data[0]?.short_guid ?? '',
        conversationGuid: null,
        apiBase: getApiBaseOverride() || 'https://a.gipity.ai',
        ignore: [],
      },
      oneOff: true,
    };
  }

  // 2. Standard cwd-walk.
  const local = getConfig();
  if (local) return { config: local, oneOff: false };

  // 3. Home fallback.
  if (!getAuth()) {
    console.error('Not logged in. Run: gipity login');
    process.exit(1);
  }
  const res = await get<{ data: { projectGuid: string; projectSlug: string; projectName: string; accountSlug: string; agentGuid: string | null } }>('/projects/default');
  if (!res.data?.projectGuid) {
    console.error('Could not resolve your Home project — please contact support.');
    process.exit(1);
  }
  console.error(dim(`→ One-off mode: no .gipity.json in cwd, using your Home project on the server.`));
  console.error(dim(`→ Files are not synced — outputs will also be downloaded to ./ for you.`));
  return {
    config: {
      projectGuid: res.data.projectGuid,
      projectSlug: res.data.projectSlug,
      accountSlug: res.data.accountSlug,
      agentGuid: res.data.agentGuid ?? '',
      conversationGuid: null,
      apiBase: getApiBaseOverride() || 'https://a.gipity.ai',
      ignore: [],
    },
    oneOff: true,
  };
}

export function clearConfigCache(): void {
  cached = null;
  cachedPath = null;
}

export function saveConfig(data: GipityConfig): void {
  const path = getConfigPath() || resolve(process.cwd(), CONFIG_FILE);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  cached = data;
  cachedPath = path;
}

/** Write `.gipity.json` at an explicit directory, bypassing the walk-up search.
 *  Use this when initializing a brand-new project directory so we never
 *  accidentally rewrite a parent project's config file. */
export function saveConfigAt(dir: string, data: GipityConfig): void {
  const path = resolve(dir, CONFIG_FILE);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  cached = data;
  cachedPath = path;
}

export function shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    // Simple glob matching: exact match, prefix match, or extension match
    if (filePath === pattern) return true;
    if (filePath.startsWith(pattern + '/')) return true;
    if (pattern.startsWith('*.') && filePath.endsWith(pattern.slice(1))) return true;
    if (pattern.endsWith('/') && filePath.startsWith(pattern)) return true;
    // Directory name match anywhere in path
    if (!pattern.includes('*') && !pattern.includes('/')) {
      if (filePath.split('/').includes(pattern)) return true;
    }
  }
  return false;
}
