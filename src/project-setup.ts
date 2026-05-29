/**
 * Shared "finish linking a project to this machine" helper. Both `gipity init`
 * and `gipity project create` need to write `.gipity.json`, sync files, and
 * drop the Claude Code hooks/skills/gitignore into the target dir - consolidating
 * here keeps both call sites honest and the wording consistent.
 */
import { clearConfigCache, saveConfigAt, getApiBaseOverride, GipityConfig } from './config.js';
import { sync } from './sync.js';
import { setupClaudeHooks, setupGitignore, SUPPORTED_TOOLS, DEFAULT_SYNC_IGNORE } from './setup.js';
import { substituteDir } from './template-vars.js';
import { muted } from './colors.js';

export interface FinalizeLocalProjectOpts {
  /** Absolute path to the project dir (already mkdir'd by the caller). */
  dir: string;
  projectGuid: string;
  projectSlug: string;
  /** Project display name — used to resolve `{{TITLE}}` and friends in any
   *  template files that contain placeholders. */
  projectName: string;
  accountSlug: string;
  agentGuid: string;
  /** When true, sync operations are non-fatal and fall through with a log. Used
   *  by `project create` where the remote project was just created and may not
   *  have anything to sync yet; set false for `init` which prefers to fail loud. */
  sync?: 'soft' | 'strict';
  /** Allow interactive bulk-deletion confirmation. Hook-driven callers pass false. */
  interactive?: boolean;
  /** Subset of AI-tool primers to write. Defaults to all of `SUPPORTED_TOOLS`
   *  (preserves the historical behavior of writing CLAUDE.md + AGENTS.md
   *  unconditionally, plus the new Gemini/Copilot/Cursor primers). */
  tools?: typeof SUPPORTED_TOOLS;
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

  // Resolve `{{PROJECT_GUID}}` / `{{TITLE}}` / `{{ANALYTICS_SCRIPT}}` etc.
  // BEFORE sync uploads. Otherwise a template's placeholder strings would
  // ship verbatim to production (we hit this with karaoke-captions where
  // `APP_GUID` resolved to the literal `'{{PROJECT_GUID}}'` and every API
  // call 404'd). Mirrors what installTemplate does server-side for `gipity
  // add` — keeps the two install paths behaviorally consistent.
  try {
    const sub = await substituteDir(opts.dir, {
      projectGuid: opts.projectGuid,
      projectName: opts.projectName,
    });
    if (sub.changed.length) {
      console.log(muted(`Resolved template vars in ${sub.changed.length} file${sub.changed.length > 1 ? 's' : ''}.`));
    }
    for (const u of sub.unresolved) {
      console.warn(muted(`  ${u.path}: unknown placeholder${u.tokens.length > 1 ? 's' : ''} ${u.tokens.join(', ')}`));
    }
  } catch (err) {
    // Substitution failure shouldn't block init — log and continue.
    console.warn(muted(`Template substitution skipped: ${(err as Error).message}`));
  }

  let applied = 0;
  try {
    const result = await sync({ interactive: opts.interactive ?? false });
    applied = result.applied;
  } catch (err) {
    if (opts.sync === 'strict') throw err;
    // soft mode - swallow; caller can log
  }

  const tools = opts.tools ?? SUPPORTED_TOOLS;
  // Claude hooks (file-sync + capture) only matter if the Claude primer is
  // being written. Skipping them for Codex/Gemini/Cursor-only inits avoids
  // littering `.claude/settings.json` into projects that don't use Claude.
  if (tools.some(t => t.key === 'claude')) setupClaudeHooks();
  for (const t of tools) t.setup();
  setupGitignore();

  return { applied };
}
