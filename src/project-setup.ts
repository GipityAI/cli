/**
 * Shared "finish linking a project to this machine" helper. Both `gipity init`
 * and `gipity project create` need to write `.gipity.json`, sync files, and
 * drop the Claude Code hooks/skills/gitignore into the target dir - consolidating
 * here keeps both call sites honest and the wording consistent.
 */
import { clearConfigCache, saveConfigAt, getApiBaseOverride, GipityConfig } from './config.js';
import { sync } from './sync.js';
import { setupClaudeHooks, setupClaudeMd, setupAgentsMd, setupGitignore, DEFAULT_SYNC_IGNORE } from './setup.js';

export interface FinalizeLocalProjectOpts {
  /** Absolute path to the project dir (already mkdir'd by the caller). */
  dir: string;
  projectGuid: string;
  projectSlug: string;
  accountSlug: string;
  agentGuid: string;
  /** When true, sync operations are non-fatal and fall through with a log. Used
   *  by `project create` where the remote project was just created and may not
   *  have anything to sync yet; set false for `init` which prefers to fail loud. */
  sync?: 'soft' | 'strict';
  /** Allow interactive bulk-deletion confirmation. Hook-driven callers pass false. */
  interactive?: boolean;
}

export interface FinalizeResult {
  applied: number;
}

/** Write `.gipity.json` in `dir`, chdir into it so the hook/skill writers
 *  target the right place, sync files, and install Claude Code hooks/skills/
 *  gitignore. Returns sync counts so callers can print a summary. */
export async function finalizeLocalProject(opts: FinalizeLocalProjectOpts): Promise<FinalizeResult> {
  const config: GipityConfig = {
    projectGuid: opts.projectGuid,
    projectSlug: opts.projectSlug,
    accountSlug: opts.accountSlug,
    agentGuid: opts.agentGuid,
    conversationGuid: null,
    apiBase: getApiBaseOverride() || 'https://a.gipity.ai',
    ignore: [...DEFAULT_SYNC_IGNORE],
  };

  saveConfigAt(opts.dir, config);
  process.chdir(opts.dir);
  clearConfigCache();

  let applied = 0;
  try {
    const result = await sync({ interactive: opts.interactive ?? false });
    applied = result.applied;
  } catch (err) {
    if (opts.sync === 'strict') throw err;
    // soft mode - swallow; caller can log
  }

  setupClaudeHooks();
  setupClaudeMd();
  setupAgentsMd();
  setupGitignore();

  return { applied };
}
