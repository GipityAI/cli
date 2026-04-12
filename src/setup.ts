/**
 * Shared project setup helpers used by both `init` and `claude`.
 */
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
export const SKILLS_CONTENT = `# Gipity Integration

Gipity is a platform for cloud agents — AI agents that run on a server with persistent memory, storage, a database, a sandboxed runtime, and direct internet access. Gip is the cloud agent on Gipity.

This Claude Code session is connected to a Gipity project, so you have two ways to use the platform:

1. **Use Gipity directly via CLI** (fast, no agent overhead). The \`gipity\` CLI exposes ~30 commands covering the common cases: scaffold apps, deploy, query databases, call functions, run code in the sandbox, fetch logs, browse URLs, etc. Use these whenever possible.
2. **Delegate to Gip** (required for capabilities not in the CLI). The Gipity platform has 90+ tools total — most are only reachable by asking Gip. Use \`gipity chat "<task>"\` to hand off. Required for: video generation and understanding, music and sound effects, TTS/speech generation, Twitter/X search, Gmail, calendar operations, realtime multiplayer rooms, push notifications, and anything else that benefits from agent reasoning or multi-step orchestration.

**You are the developer.** Write files in this directory — they auto-sync to Gipity via hooks. Do NOT run \`npm install\`, \`npm start\`, \`node\`, or \`python\` locally; there is no local runtime. Code runs in the Gipity sandbox.

## Workflow

1. Write and edit files normally (auto-pushed to Gipity on every save)
2. \`gipity deploy dev\` → live URL instantly
3. \`gipity deploy prod\` when ready

## CLI Commands

| Command | Purpose |
|---------|---------|
| \`gipity scaffold [title]\` | Create app structure (\`--type web\`, \`--type 2d-game\`, or \`--type 3d-world\`) |
| \`gipity deploy [dev\\|prod]\` | Deploy and get live URL |
| \`gipity sync [up\\|down\\|check]\` | Manual file sync |
| \`gipity db create <name>\` | Create a project database |
| \`gipity db drop <name> [--project <slug>]\` | Drop a database (--project for cross-project) |
| \`gipity db query "SQL"\` | Run SQL on project database |
| \`gipity db list [--all]\` | List databases (--all for account-wide) |
| \`gipity fn list\\|call <name> [body]\\|logs <name>\` | Manage serverless functions |
| \`gipity memory list\\|read\\|write\` | Persistent key-value memory |
| \`gipity browser <url>\` | Inspect URL: console errors, timing, resources |
| \`gipity logs fn <name>\` | View function execution logs |
| \`gipity sandbox <lang> "code"\` | Execute code in cloud sandbox |
| \`gipity location [ip\\|lat lng]\` | IP geo / reverse-geocode / caller location |
| \`gipity chat <message>\` | Send a task to the Gipity agent |
| \`gipity skills list\` | List all available skill docs |
| \`gipity skills read <name>\` | Read detailed docs on a topic |
| \`gipity status\` | Check project and auth status |

All commands support \`--json\` for structured output. Use \`--help\` on any command for details (auto-fetches relevant skill docs from the server).

## Platform Capabilities

- **App hosting**: Deploy to dev/prod URLs on Gipity CDN
- **Databases**: Per-project PostgreSQL databases with SQL access
- **Serverless functions**: JavaScript functions callable via REST
- **Multiplayer**: Colyseus WebSocket rooms (relay and state-synced)
- **Image generation**: OpenAI (gpt-image-1, DALL-E 3) and BFL/Flux
- **Speech / TTS**: ElevenLabs and OpenAI voices
- **Audio/video processing**: FFmpeg, sox, transcription, source isolation
- **Web search**: Brave API
- **Browser automation**: Open URLs, screenshot, click, fill forms, console
- **Workflows**: Cron or webhook-triggered multi-step AI pipelines
- **Email**: SendGrid transactional email
- **Cloud sandbox**: Python, Node.js, Bash with 50+ pre-installed tools
- **Cross-model queries**: Ask GPT-5, Claude, etc. for second opinions

## Detailed Documentation

Run \`gipity skills list\` to see all available skill docs. Run \`gipity skills read <name>\` to read one. Key skills:

- **web-app-basics** — coding guidelines, file structure, HTML/CSS/JS patterns
- **app-development** — functions, database & API (write functions → deploy → test → call via REST)
- **app-auth** — user authentication (Sign in with Gipity)
- **app-realtime** — multiplayer rooms (Colyseus WebSocket)
- **3d-world** — 3D multiplayer game template (Three.js + Rapier + Colyseus)
- **2d-game** — 2D game template (Phaser 3)
- **sandbox-tools** — cloud sandbox capabilities and pre-installed tools

Load the relevant skill BEFORE starting a task — they contain the correct API patterns, code examples, and common mistakes.

## File Operations

All file creation and editing should happen locally — hooks auto-push changes to Gipity. Do NOT use \`gipity chat\` to create or edit files. Use \`gipity sync\` if files get out of sync. Files generated remotely by \`gipity chat\` (images, audio, etc.) also sync down automatically and can be referenced in your code like any local file.

## Authentication

1. \`gipity login --email user@example.com\` → sends a 6-digit code
2. \`gipity login --email user@example.com --code 123456\`

## Sync Behavior

- **Auto-push**: Files push to Gipity after every Write/Edit (hook)
- **Auto-pull**: Remote changes pull before each prompt (hook)
- **Tool-generated files sync too**: Images, audio, and other files created by \`gipity chat\` or remote agent tools are project files that auto-pull like any other
- **Deletes are safe**: Use \`rollback\` tool with a datetime to undo, or \`file_version_restore\` for individual files
`;


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

// Cross-platform hooks using node -e (no bash/jq dependency)
export const HOOKS_SETTINGS = {
  hooks: {
    PostToolUse: [{
      matcher: 'Write|Edit',
      hooks: [{
        type: 'command',
        command: `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d).tool_input?.file_path;if(!p||!require('fs').existsSync('.gipity.json'))process.exit(0);require('child_process').spawn('gipity',['push',p,'--quiet'],{stdio:'ignore',detached:true,shell:true}).unref()}catch{}})"`,
      }],
    }],
    UserPromptSubmit: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node -e "if(!require('fs').existsSync('.gipity.json'))process.exit(0);require('child_process').exec('gipity sync down --json',(e,o)=>{if(e)process.exit(0);try{const r=JSON.parse(o);if(r.pulled>0)console.log(JSON.stringify({systemMessage:'Gipity sync: '+(r.summary||'Files changed remotely.')}))}catch{}})"`,
      }],
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
