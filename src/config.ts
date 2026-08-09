import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import ignore, { type Ignore } from 'ignore';

export interface GipityConfig {
  projectGuid: string;
  projectSlug: string;
  accountSlug: string;
  agentGuid: string;
  conversationGuid: string | null;
  apiBase: string;
  ignore: string[];
  /** Install Claude Code (and other remote agent) lifecycle hooks that
   *  mirror the terminal session into the Gipity DB so the web CLI can
   *  display it read-only. Default: true. Set false per-project to opt
   *  out of capture without losing the other integration features. */
  captureHooks?: boolean;
  /** Coding tools this project is set up for (SUPPORTED_TOOLS keys), pinned by
   *  `gipity init --for <tools>`. Absent = auto-detect from what's installed on
   *  the machine. Stored so the choice survives: `gipity build` and the relay
   *  daemon both call setupProjectTools() with no arguments, and without this
   *  they would re-add primers for every tool on the next run. */
  tools?: string[];
}

const CONFIG_FILE = '.gipity.json';

export const DEFAULT_API_BASE = 'https://a.gipity.ai';

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

/**
 * Hosts we will attach the account/device token to. `.gipity.json` is found by
 * walking up from cwd, so its `apiBase` is attacker-controllable: cloning a repo
 * (or installing a template) that ships `{"apiBase":"https://evil.example"}`
 * would otherwise redirect the very next `gipity` command's bearer — and, on
 * refresh, the 7-day refresh token — to that host. Tokens are account-global, so
 * that's account takeover from merely cd-ing into a poisoned tree. Only Gipity
 * hosts over https may receive tokens; the explicit `--api-base` flag is trusted
 * (it's how local dev points at localhost). */
export function isAllowedApiHost(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return hostname === 'gipity.ai' || hostname.endsWith('.gipity.ai');
  } catch {
    return false;
  }
}

const warnedHosts = new Set<string>();

/**
 * The API base for token-bearing requests. Precedence:
 *   1. explicit `--api-base` flag (trusted — any host, enables local dev)
 *   2. the project config's `apiBase`, but only if it's an allowed Gipity host
 *   3. the production default
 * A config `apiBase` that fails the allowlist is dropped (with a one-time
 * warning) rather than trusted — see {@link isAllowedApiHost}. */
export function resolveApiBase(): string {
  const override = getApiBaseOverride();
  if (override) return override;
  // GIPITY_API_BASE env is a trusted override (any host, like --api-base) so a
  // caller can point the CLI at a local dev server without passing the flag on
  // every command — e.g. GipRunner running builds against http://localhost:7201.
  const fromEnv = process.env.GIPITY_API_BASE;
  if (fromEnv) return fromEnv;
  const fromConfig = getConfig()?.apiBase;
  if (fromConfig) {
    if (isAllowedApiHost(fromConfig)) return fromConfig;
    if (!warnedHosts.has(fromConfig)) {
      warnedHosts.add(fromConfig);
      console.error(
        `⚠ Ignoring untrusted apiBase "${fromConfig}" from .gipity.json — not a gipity.ai host. Using ${DEFAULT_API_BASE}.`,
      );
    }
  }
  return DEFAULT_API_BASE;
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

/** Directory holding the project's `.gipity.json` (the project root), found by
 *  walking up from cwd. Returns null when there's no linked project in the tree
 *  (e.g. one-off mode), in which case callers should anchor to cwd. */
export function getProjectRoot(): string | null {
  const path = getConfigPath();
  return path ? dirname(path) : null;
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
    const res = await get<{ data: Array<{ short_guid: string; slug: string; name: string }> }>('/projects?limit=1000');
    const match = res.data.find(p => p.short_guid === target || p.slug === target);
    if (!match) {
      console.error(`Project not found: ${target}`);
      process.exit(1);
    }
    const agents = await get<{ data: Array<{ short_guid: string }> }>(`/projects/${match.short_guid}/agents`);
    const accountSlug = await getAccountSlug();
    console.error(dim(`→ (project: ${match.slug} · no file sync)`));
    console.error('');
    return {
      config: {
        projectGuid: match.short_guid,
        projectSlug: match.slug,
        accountSlug,
        agentGuid: agents.data[0]?.short_guid ?? '',
        conversationGuid: null,
        apiBase: getApiBaseOverride() || DEFAULT_API_BASE,
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
    console.error('Could not resolve your Home project - please contact support.');
    process.exit(1);
  }
  console.error(dim(`→ (project: ${res.data.projectName} · no file sync)`));
  console.error('');
  return {
    config: {
      projectGuid: res.data.projectGuid,
      projectSlug: res.data.projectSlug,
      accountSlug: res.data.accountSlug,
      agentGuid: res.data.agentGuid ?? '',
      conversationGuid: null,
      apiBase: getApiBaseOverride() || DEFAULT_API_BASE,
      ignore: [],
    },
    oneOff: true,
  };
}

/** The canonical live URL for a deployed project. This is THE place the
 *  dev/prod URL convention lives - every command that tells the user (or an
 *  agent) where their app is (`deploy`, `status`, `project info`) derives it
 *  here, so nothing ever has to reconstruct `dev.gipity.ai/<account>/<slug>/`
 *  by hand or guess a subdomain like `<slug>.gipity.app` (which doesn't
 *  resolve). Mirrors the server's deploy URL; `deploy` itself prints the
 *  server-authoritative URL, the read-only commands derive it from config. */
export function liveUrl(
  config: Pick<GipityConfig, 'accountSlug' | 'projectSlug'>,
  target: 'dev' | 'prod' = 'dev',
): string {
  const host = target === 'prod' ? 'app.gipity.ai' : 'dev.gipity.ai';
  return `https://${host}/${config.accountSlug}/${config.projectSlug}/`;
}

export function clearConfigCache(): void {
  cached = null;
  cachedPath = null;
}

export function saveConfig(data: GipityConfig): void {
  // saveConfig only ever *updates* an existing project config. It must never
  // create a new `.gipity.json`: a one-off command (e.g. `gipity chat`) run
  // in an unrelated folder resolves to the server's Home project, and a
  // create-on-save here would silently turn that folder - in the wild, often
  // `$HOME` itself - into a Gipity project. Creating a config is always an
  // explicit act and must go through `saveConfigAt(dir, …)`.
  const path = getConfigPath();
  if (!path) {
    throw new Error(
      'saveConfig: no .gipity.json found to update. ' +
      'Use saveConfigAt(dir, …) to create a new project config.',
    );
  }
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

/** Compiled matchers cached by their pattern set so the per-file `shouldIgnore`
 *  call in the sync loop doesn't rebuild the matcher every time. */
const ignoreMatcherCache = new Map<string, Ignore>();

/**
 * True if filePath (a POSIX-relative path under the project root) is excluded
 * by the given .gipityignore / config ignore patterns. Uses real gitignore
 * semantics via the "ignore" package, so all documented forms work: bare names
 * match in any directory (node_modules), a trailing slash means directory
 * (.gipity/), star-dot matches any depth (*.log), and the previously
 * unsupported forms (data/*.csv, anchored /build, double-star, and negation
 * with a leading bang) now behave as users expect.
 */
export function shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0) return false;
  const key = ignorePatterns.join('\n');
  let matcher = ignoreMatcherCache.get(key);
  if (!matcher) {
    matcher = ignore().add(ignorePatterns);
    ignoreMatcherCache.set(key, matcher);
  }
  // `ignore` wants a clean relative path; it rejects absolute paths and '.'.
  const rel = filePath.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return false;
  return matcher.ignores(rel);
}
