/**
 * Shared "finish linking a project to this machine" helper. Both `gipity init`
 * and `gipity project create` need to write `.gipity.json`, sync files, and
 * drop the Claude Code hooks/skills/gitignore into the target dir — consolidating
 * here keeps both call sites honest and the wording consistent.
 */
import { clearConfigCache, saveConfigAt, getApiBaseOverride, GipityConfig } from './config.js';
import { syncDown, syncUp } from './sync.js';
import { setupClaudeHooks, setupClaudeMd, setupGitignore, DEFAULT_SYNC_IGNORE } from './setup.js';

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
  /** When true, prompt before deleting local files during syncDown. */
  confirmDeletions?: boolean;
}

export interface FinalizeResult {
  pushed: number;
  pulled: number;
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

  let pushed = 0;
  let pulled = 0;
  try {
    const upResult = await syncUp();
    pushed = upResult.pushed;
    const downResult = await syncDown({ confirmDeletions: opts.confirmDeletions ?? false });
    pulled = downResult.pulled;
  } catch (err) {
    if (opts.sync === 'strict') throw err;
    // soft mode — swallow; caller can log
  }

  setupClaudeHooks();
  setupClaudeMd();
  setupGitignore();

  return { pushed, pulled };
}
