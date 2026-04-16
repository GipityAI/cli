/**
 * Shared project setup helpers used by both `init` and `claude`.
 */
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { SKILLS_CONTENT, SCAFFOLD_HOOK_WARNING } from './prompts.js';

export { SKILLS_CONTENT };

/** Canonical list of workstation artifacts that are NOT part of the project.
 *  Used as the single source of truth for three separate decisions:
 *    1. Cloud sync — these files/globs are excluded from push and pull.
 *    2. CLI file count (`listProjectFiles` in commands/claude.ts) — these don't
 *       count toward "is this project empty?" for scaffold-gate and empty-state
 *       prompt decisions.
 *    3. Scaffold collision check — these can never collide with a scaffold
 *       because they're already skipped by sync and by the empty check.
 *
 *  Mental model: a file in this list is a client-side artifact, not project
 *  content. `CLAUDE.md` is generated fresh per-session from `SKILLS_CONTENT`
 *  in prompts.ts and is CLI-version-dependent — syncing it would churn on
 *  every CLI upgrade. `.gipity.json`, `.gipity/`, and `.claude/` are per-
 *  workstation configuration. */
export const DEFAULT_SYNC_IGNORE = [
  'node_modules', '.git', '.gipity.json', '.gipity/', '.claude/',
  '.gitignore', 'CLAUDE.md',
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
      'Bash(gipity scaffold *)',
      'Bash(gipity deploy dev *)',
      'Bash(gipity domain *)',
      'Bash(gipity db query *)',
      'Bash(gipity db list *)',
      'Bash(gipity db create *)',
      'Bash(gipity memory *)',
      'Bash(gipity browser *)',
      'Bash(gipity logs *)',
      'Bash(gipity sandbox *)',
      'Bash(gipity chat *)',
      'Bash(gipity skills *)',
      'Bash(gipity credits *)',
      'Bash(gipity file ls *)',
      'Bash(gipity file cat *)',
      'Bash(gipity file tree *)',
      'Bash(gipity file versions *)',
      'Bash(gipity records *)',
      'Bash(gipity fn *)',
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

// Cross-platform hooks using node -e (no bash/jq dependency).
//
// Capture hooks (start/prompt/tool/stop/end/compact) forward Claude Code hook
// payloads to Gipity so the conversation is viewable in the web CLI. They pipe
// stdin directly to `gipity hook-capture <event>`, which guards on
// .gipity.json + auth and silently no-ops otherwise. See
// docs/feature-backlog/claude-code-web-cli-bridge.md.
// Buffer stdin fully before spawning the detached child and writing the
// payload to its stdin. Piping stdin directly + timing out on the parent
// truncates large payloads (big tool_response, long transcripts) when the
// parent exits before the pipe drains. Same shape as the Write|Edit push
// shim below.
function captureHook(event: string): string {
  return `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{if(!require('fs').existsSync('.gipity.json'))return;const p=require('child_process').spawn('gipity',['hook-capture','${event}'],{stdio:['pipe','ignore','ignore'],detached:true,shell:true});p.stdin.end(d);p.unref()})"`;
}

export const HOOKS_SETTINGS = {
  hooks: {
    SessionStart: [{
      matcher: '',
      hooks: [{ type: 'command', command: captureHook('start') }],
    }],
    SessionEnd: [{
      matcher: '',
      hooks: [{ type: 'command', command: captureHook('end') }],
    }],
    PreCompact: [{
      matcher: '',
      hooks: [{ type: 'command', command: captureHook('compact') }],
    }],
    PreToolUse: [
      {
        // Soft scaffold reminder. If this is a Gipity project (has
        // .gipity.json) AND has no scaffold markers (gipity.yaml, src/,
        // functions/, package.json), nudge the agent to scaffold first
        // when building an app. Non-blocking — exit 0 always; stderr is
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
        // File sync for Write/Edit (existing behavior)
        matcher: 'Write|Edit',
        hooks: [{
          type: 'command',
          command: `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d).tool_input?.file_path;if(!p||!require('fs').existsSync('.gipity.json'))process.exit(0);require('child_process').spawn('gipity',['push',p,'--quiet'],{stdio:'ignore',detached:true,shell:true}).unref()}catch{}})"`,
        }],
      },
      {
        // Conversation capture for every tool call
        matcher: '.*',
        hooks: [{ type: 'command', command: captureHook('tool') }],
      },
    ],
    UserPromptSubmit: [
      {
        // Sync down + optional system-message (existing behavior)
        matcher: '',
        hooks: [{
          type: 'command',
          command: `node -e "if(!require('fs').existsSync('.gipity.json'))process.exit(0);require('child_process').exec('gipity sync down --json',(e,o)=>{if(e)process.exit(0);try{const r=JSON.parse(o);if(r.pulled>0)console.log(JSON.stringify({systemMessage:'Gipity sync: '+(r.summary||'Files changed remotely.')}))}catch{}})"`,
        }],
      },
      {
        // Capture the user's prompt
        matcher: '',
        hooks: [{ type: 'command', command: captureHook('prompt') }],
      },
    ],
    Stop: [{
      matcher: '',
      hooks: [{ type: 'command', command: captureHook('stop') }],
    }],
  },
};

export function setupClaudeHooks(): void {
  const claudeDir = resolve(process.cwd(), '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // corrupted — overwrite
    }
  }

  settings.hooks = HOOKS_SETTINGS.hooks;

  // Merge permissions (additive — preserve user's existing allows)
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

export function setupClaudeMd(): void {
  const claudeMdPath = resolve(process.cwd(), 'CLAUDE.md');

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes('Gipity Integration')) return;
    writeFileSync(claudeMdPath, existing + '\n\n' + SKILLS_CONTENT);
  } else {
    writeFileSync(claudeMdPath, SKILLS_CONTENT);
  }
}

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
