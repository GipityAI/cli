/**
 * Shared project setup helpers used by both `init` and `claude`.
 */
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { SCAFFOLD_HOOK_WARNING } from './prompts.js';
import { SKILLS_CONTENT, BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE } from './knowledge.js';
import { getConfig } from './config.js';

export { SKILLS_CONTENT };

/** Canonical list of workstation artifacts that are NOT part of the project.
 *  Used as the single source of truth for three separate decisions:
 *    1. Cloud sync - these files/globs are excluded from push and pull.
 *    2. CLI file count (`listProjectFiles` in commands/claude.ts) - these don't
 *       count toward "is this project empty?" for scaffold-gate and empty-state
 *       prompt decisions.
 *    3. Scaffold collision check - these can never collide with a scaffold
 *       because they're already skipped by sync and by the empty check.
 *
 *  Mental model: a file in this list is a client-side artifact, not project
 *  content. `CLAUDE.md` is generated fresh per-session from `SKILLS_CONTENT`
 *  in knowledge.ts and is CLI-version-dependent - syncing it would churn on
 *  every CLI upgrade. `.gipity.json`, `.gipity/`, and `.claude/` are per-
 *  workstation configuration. */
/** Relative path of each per-tool primer file we generate. Single source of
 *  truth: both {@link DEFAULT_SYNC_IGNORE} and the `setup*Md` writers read from
 *  here, so adding a tool can't silently leak its primer into project sync.
 *  Every primer is a CLI-version-generated client-side artifact (regenerated
 *  from knowledge.ts each session), not project content - syncing one churns on
 *  every CLI upgrade, so all of them are sync-ignored. */
export const PRIMER_FILES = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  copilot: '.github/copilot-instructions.md',
  cursor: '.cursor/rules/gipity.mdc',
} as const;

export const DEFAULT_SYNC_IGNORE = [
  'node_modules', '.git', '.gipity.json', '.gipity/', '.claude/', '.gitignore',
  ...Object.values(PRIMER_FILES),
];

/** True if `name` (a top-level dir entry) is a workstation artifact that
 *  should be excluded from sync, file counts, and collision checks.
 *  Matches exact names, trailing-slash dir patterns, and dotfiles generally. */
export function isSyncIgnored(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (DEFAULT_SYNC_IGNORE.includes(name)) return true;
  if (DEFAULT_SYNC_IGNORE.includes(`${name}/`)) return true;
  return false;
}



// Permissions: auto-allow safe gipity commands in Claude Code
// Destructive commands (db drop, deploy prod, email, file rm/restore/rollback) are excluded
export const PERMISSIONS_SETTINGS = {
  permissions: {
    allow: [
      'Bash(gipity status *)',
      'Bash(gipity sync *)',
      'Bash(gipity push *)',
      'Bash(gipity test *)',
      'Bash(gipity add *)',
      'Bash(gipity deploy dev *)',
      'Bash(gipity domain *)',
      'Bash(gipity db query *)',
      'Bash(gipity db list *)',
      'Bash(gipity db create *)',
      'Bash(gipity memory *)',
      'Bash(gipity page *)',
      'Bash(gipity logs *)',
      'Bash(gipity sandbox *)',
      'Bash(gipity chat *)',
      'Bash(gipity skill *)',
      'Bash(gipity credits *)',
      'Bash(gipity file ls *)',
      'Bash(gipity file cat *)',
      'Bash(gipity file tree *)',
      'Bash(gipity file versions *)',
      'Bash(gipity records *)',
      'Bash(gipity fn *)',
      'Bash(gipity service *)',
      'Bash(gipity rbac *)',
      'Bash(gipity audit *)',
      'Bash(gipity generate *)',
      'Bash(gipity location *)',
      'Bash(gipity workflow *)',
      'Bash(gipity agent *)',
      'Bash(gipity project *)',
      'Bash(gipity login *)',
    ],
  },
};

/** Absolute path to the bundled capture-runner script. Resolved once at
 *  install time so hook commands embed a stable `node <path>` command
 *  rather than `gipity …` (which would require re-running `gipity` every
 *  hook fire). Works whether the CLI is installed globally, linked, or
 *  run from a build output - `import.meta.url` always points at this
 *  file under `dist/`, and the runner sits at `dist/hooks/`. */
export function resolveCaptureRunnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'hooks', 'capture-runner.js');
}

// Cross-platform hooks using node -e (no bash/jq dependency).
//
// Two categories:
//   1. File-sync hooks (PreToolUse / PostToolUse / UserPromptSubmit):
//      installed unconditionally. Scaffold reminder + push/pull. Not
//      related to conversation capture.
//   2. Capture hooks (SessionStart / Stop / SubagentStop / SessionEnd, plus
//      a throttled PostToolUse for mid-run flushing): mirror a terminal
//      Claude Code session into the Gipity DB so the web CLI can display it
//      read-only. The PostToolUse capture entry is merged alongside the
//      file-sync one (see setupClaudeHooks). Toggled by the `captureHooks`
//      field in `.gipity.json` - default on.
export const HOOKS_SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        // Soft scaffold reminder. If this is a Gipity project (has
        // .gipity.json) AND has no scaffold markers (gipity.yaml, src/,
        // functions/, package.json), nudge the agent to scaffold first
        // when building an app. Non-blocking - exit 0 always; stderr is
        // visible to Claude as an advisory. Auto-quiet once any scaffold
        // marker appears, so it doesn't spam during normal editing.
        matcher: 'Write|Edit',
        hooks: [{
          type: 'command',
          // Embed warning as a single-quoted JS string (safe: shell double
          // quotes survive, and SCAFFOLD_HOOK_WARNING is plain ASCII without
          // single quotes or backslashes).
          command: `node -e "const fs=require('fs');if(!fs.existsSync('.gipity.json'))process.exit(0);const m=['gipity.yaml','src','functions','package.json'].some(p=>fs.existsSync(p));if(m)process.exit(0);process.stderr.write('${SCAFFOLD_HOOK_WARNING.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}\\n');process.exit(0)"`,
        }],
      },
    ],
    PostToolUse: [
      {
        // File sync for Write/Edit - push any edited file back to the
        // cloud workspace so web previews see the change.
        matcher: 'Write|Edit',
        hooks: [{
          type: 'command',
          command: `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d).tool_input?.file_path;if(!p||!require('fs').existsSync('.gipity.json'))process.exit(0);require('child_process').spawn('gipity',['push',p,'--quiet'],{stdio:'ignore',detached:true,shell:true}).unref()}catch{}})"`,
        }],
      },
    ],
    UserPromptSubmit: [
      {
        // Pull down any cloud-side file changes before the next turn so
        // the agent sees current state.
        matcher: '',
        hooks: [{
          type: 'command',
          command: `node -e "if(!require('fs').existsSync('.gipity.json'))process.exit(0);require('child_process').exec('gipity sync --json',(e,o)=>{if(e)process.exit(0);try{const r=JSON.parse(o);if(r.applied>0)console.log(JSON.stringify({systemMessage:'Gipity sync: '+(r.summary||'Files changed.')}))}catch{}})"`,
        }],
      },
    ],
  },
};

/** Build the four lifecycle-hook entries that invoke the bundled capture
 *  runner. Kept as a factory rather than a constant so the absolute
 *  runner path is resolved at install time, reflecting the CLI's current
 *  install location. */
function buildCaptureHookEntries(source: string): Record<string, any[]> {
  const runner = resolveCaptureRunnerPath();
  const cmd = (event: string): string => `node ${JSON.stringify(runner)} ${source} ${event}`;
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start') }] }],
    Stop:         [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: cmd('subagent-stop') }] }],
    SessionEnd:   [{ hooks: [{ type: 'command', command: cmd('session-end') }] }],
    // Mid-run incremental flush (matcher '' = every tool). Stop/SessionEnd only
    // fire on a CLEAN exit, so without this a session that's killed/crashes mid-run
    // (e.g. a long headless build that times out) loses its whole transcript. The
    // runner throttles this so it's cheap. Merged alongside the file-sync PostToolUse.
    PostToolUse:  [{ matcher: '', hooks: [{ type: 'command', command: cmd('post-tool-use') }] }],
  };
}

export function setupClaudeHooks(): void {
  const claudeDir = resolve(process.cwd(), '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // corrupted - overwrite
    }
  }

  // Merge capture hooks in only when the project opts in (default true).
  // `captureHooks === false` in `.gipity.json` disables the mirror-to-web
  // feature for this project without affecting the file-sync hooks.
  const captureEnabled = getConfig()?.captureHooks !== false;
  const captureEntries = captureEnabled ? buildCaptureHookEntries('claude-code') : {};

  // Merge per-event arrays rather than spread-overwriting: capture and file-sync
  // both register PostToolUse, and a plain spread would drop one of them.
  const mergedHooks: Record<string, any[]> = { ...HOOKS_SETTINGS.hooks };
  for (const [event, entries] of Object.entries(captureEntries)) {
    mergedHooks[event] = [...(mergedHooks[event] ?? []), ...entries];
  }
  settings.hooks = mergedHooks;

  // Merge permissions (additive - preserve user's existing allows)
  const perms = (settings as Record<string, any>).permissions || {};
  if (!perms.allow) perms.allow = [];
  for (const entry of PERMISSIONS_SETTINGS.permissions.allow) {
    if (!perms.allow.includes(entry)) {
      perms.allow.push(entry);
    }
  }
  (settings as Record<string, any>).permissions = perms;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/** Markers delimiting the Gipity-managed section of CLAUDE.md / AGENTS.md.
 *  HTML comments, so they're invisible in rendered markdown. These strings
 *  are stable - changing them would orphan the blocks in existing files. */
export const GIPITY_BLOCK_BEGIN = '<!-- BEGIN GIPITY INTEGRATION - auto-generated by gipity, do not edit this block -->';
export const GIPITY_BLOCK_END = '<!-- END GIPITY INTEGRATION -->';

/** The Gipity-owned section, marker-wrapped: the integration guide + the full
 *  scaffold rule + the definition of done. The rule and DoD used to be injected
 *  only into the interactive `gipity claude` seed; folding the *static* parts
 *  into the primer means every agent (Claude, Codex, Gemini, ...) gets them, and
 *  the seed no longer has to carry that context.
 *
 *  Per-project values (GUID, live URL) deliberately do NOT live here - baking
 *  them into a generated doc is the wrong layer. The CLI surfaces them where the
 *  agent actually looks: `gipity deploy` prints the live URL, `gipity status` and
 *  `gipity project info` show the URL + GUID. That keeps them authoritative and
 *  avoids stale values frozen into a file. */
function renderManagedBlock(): string {
  const body = [SKILLS_CONTENT, BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE].join('\n\n');
  return `${GIPITY_BLOCK_BEGIN}\n${body}\n${GIPITY_BLOCK_END}`;
}

/**
 * Pure core of `writeSkillsFile`: given a file's current content (or `null`
 * when the file does not exist), return what it should contain.
 *
 * The Gipity block is fully managed - every run replaces it with the current
 * SKILLS_CONTENT, so skill-catalog changes reach existing projects. Anything
 * outside the markers is the user's own content and is preserved verbatim.
 *
 *   - no file            -> the managed block
 *   - marked block found -> replace between the markers, keep the rest
 *   - legacy unmarked    -> from older CLIs the `# Gipity Integration` block
 *                           was appended last and ran to EOF; drop it and
 *                           append a fresh marked block
 *   - no Gipity block    -> append a marked block, keep the user's content
 *
 * Exported for unit testing.
 */
export function applySkillsBlock(existing: string | null): string {
  const block = renderManagedBlock();
  if (existing === null) return block + '\n';

  let next: string;
  const beginIdx = existing.indexOf(GIPITY_BLOCK_BEGIN);
  if (beginIdx !== -1) {
    // Marked block - replace between the markers, preserve everything else.
    const endAt = existing.indexOf(GIPITY_BLOCK_END, beginIdx);
    const after = endAt !== -1 ? existing.slice(endAt + GIPITY_BLOCK_END.length) : '\n';
    next = existing.slice(0, beginIdx) + block + after;
  } else {
    // No markers. A legacy block always ran from the `# Gipity Integration`
    // heading to EOF (older CLIs appended it last); with no such heading the
    // whole file is the user's own content.
    const legacyIdx = existing.indexOf('# Gipity Integration');
    const head = (legacyIdx !== -1 ? existing.slice(0, legacyIdx) : existing).trimEnd();
    next = (head ? head + '\n\n' : '') + block + '\n';
  }
  return next.endsWith('\n') ? next : next + '\n';
}

/** Write or refresh the Gipity integration block in a primer file.
 *  Skips the write when nothing changed, to avoid needless file churn.
 *  `wrap` lets a tool prepend tool-specific frontmatter (e.g. Cursor's .mdc). */
function writeSkillsFile(relPath: string, wrap?: (block: string) => string): void {
  const path = resolve(process.cwd(), relPath);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const baseNext = applySkillsBlock(existing);
  // Frontmatter wrap only applies on first write (no existing content).
  // Re-runs preserve user content outside the managed block, including
  // any frontmatter they may have added themselves.
  const next = wrap && existing === null ? wrap(baseNext) : baseNext;
  if (next !== existing) writeFileSync(path, next);
}

export function setupClaudeMd(): void {
  writeSkillsFile(PRIMER_FILES.claude);
}

export function setupAgentsMd(): void {
  writeSkillsFile(PRIMER_FILES.codex);
}

/** Gemini CLI auto-discovers GEMINI.md in the working directory. */
export function setupGeminiMd(): void {
  writeSkillsFile(PRIMER_FILES.gemini);
}

/** GitHub Copilot CLI (and Copilot in VS Code) auto-discovers
 *  `.github/copilot-instructions.md`. */
export function setupCopilotMd(): void {
  writeSkillsFile(PRIMER_FILES.copilot);
}

/** Cursor reads rule files from `.cursor/rules/`. The `.mdc` format wants
 *  YAML frontmatter; `alwaysApply: true` makes it load on every chat. */
export function setupCursorMd(): void {
  writeSkillsFile(PRIMER_FILES.cursor, (block) =>
    `---\ndescription: Gipity platform integration - CLI, sandbox, app services\nalwaysApply: true\n---\n\n${block}`,
  );
}

/** All supported coding-tool primers and the function that writes each.
 *  Order matters for help-text rendering and the `all` expansion. */
export const SUPPORTED_TOOLS: Array<{ key: string; label: string; setup: () => void }> = [
  { key: 'claude',  label: 'Claude Code (CLAUDE.md)',                              setup: setupClaudeMd },
  { key: 'codex',   label: 'OpenAI Codex (AGENTS.md)',                             setup: setupAgentsMd },
  { key: 'gemini',  label: 'Gemini CLI (GEMINI.md)',                               setup: setupGeminiMd },
  { key: 'copilot', label: 'GitHub Copilot (.github/copilot-instructions.md)',     setup: setupCopilotMd },
  { key: 'cursor',  label: 'Cursor (.cursor/rules/gipity.mdc)',                    setup: setupCursorMd },
];

export function setupGitignore(): void {
  const gitignorePath = resolve(process.cwd(), '.gitignore');
  const entries = ['.gipity/', '.gipity.json'];

  if (existsSync(gitignorePath)) {
    let content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const toAdd = entries.filter(e => !lines.includes(e));
    if (toAdd.length > 0) {
      content = content.trimEnd() + '\n' + toAdd.join('\n') + '\n';
      writeFileSync(gitignorePath, content);
    }
  } else {
    writeFileSync(gitignorePath, entries.join('\n') + '\n');
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
