/**
 * Shared project setup helpers used by both `init` and `start-cc`.
 */
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { CODING_GUIDELINES } from './coding-guidelines.js';
import { GIP_3DW_GUIDE } from './gip3dw-guide.js';
import { CLI_COMMANDS, PLATFORM_SERVICES } from './platform-overview.js';

export const SKILLS_CONTENT = `# Gipity Integration

Most AI tools give you a chatbot. We gave ours a computer. Gipity is an AI agent with 90+ tools and a full cloud platform — app hosting, databases, file storage, deployment, workflows, code execution, and more. Use it standalone or plug it into Claude Code to give your local agent cloud superpowers.

**You are the developer.** Write HTML, JS, CSS, Python — whatever the project needs — directly in this directory. Files auto-sync to Gipity's cloud via hooks. There is no local runtime; do NOT run \`npm install\`, \`npm start\`, \`node\`, or \`python\` locally.

## Workflow

1. Write and edit files normally (auto-pushed to Gipity on every save)
2. \`gipity deploy dev\` → get a live URL instantly
3. \`curl <url>\` or WebFetch to verify
4. \`gipity deploy prod\` when ready

${CLI_COMMANDS}

## Processing & Code Execution

Do NOT install tools or run heavy processing locally. Gipity has a cloud sandbox accessible via \`gipity chat\` with extensive tools pre-installed:

- **Image/video**: ImageMagick, FFmpeg, Graphviz, gnuplot, optipng, gifsicle, potrace, webp, exiftool, mediainfo
- **Documents**: LibreOffice (headless), pandoc, wkhtmltopdf, ghostscript, qpdf, poppler-utils
- **Python**: pandas, numpy, matplotlib, scipy, sympy, pillow, openpyxl, python-docx, python-pptx, reportlab, cairosvg, seaborn, qrcode, requests, bs4, Jinja2, faker
- **Audio**: sox, FFmpeg
- **Data**: jq, sqlite3, csvkit, datamash, miller, xmlstarlet
- **Compile**: GCC/G++, mingw-w64 (Windows cross-compile)

Use \`gipity chat\` to have the platform do it. Example: \`gipity chat "resize all images in src/images to 800px wide"\`

## File Operations

All file creation and editing should happen locally — hooks auto-push changes to Gipity. Do NOT use \`gipity chat\` to create or edit files. Use \`gipity sync\` if files get out of sync. Use \`gipity file ls\` and \`gipity file cat\` to browse remote files without syncing.

${PLATFORM_SERVICES}

Use \`gipity chat\` to access these from the CLI. Example: \`gipity chat "generate a hero image for the landing page"\`

${GIP_3DW_GUIDE}

${CODING_GUIDELINES}

## Authentication

Login is a two-step process that works non-interactively:

1. \`gipity login --email user@example.com\` → sends a 6-digit code to that email
2. Ask the user for the code, then: \`gipity login --email user@example.com --code 123456\`

Check auth status: \`gipity status\`
Log out: \`gipity logout\`

## Sync Behavior

- **Auto-push**: Files push to Gipity after every Write/Edit (hook)
- **Auto-pull**: Remote changes pull before each prompt (hook)
- **Manual**: \`gipity sync check\` to see pending changes
- **Deletes are safe**: All file deletions are soft deletes. Use \`gipity checkpoint list\` and \`gipity checkpoint restore <id>\` to undo any delete or revert to a previous state.

## Debugging

- \`gipity browser <url>\` — open a deployed URL and get JS console errors, failed resources (404s), and page load timing. Useful when something looks broken after deploy.
- \`gipity logs fn <name>\` — view recent function execution logs with error messages and timing. Use when API calls return errors.
- \`gipity sync check\` — verify local and remote files are in sync if things seem stale.
- \`gipity checkpoint restore <id>\` — undo a bad change by restoring to a previous file snapshot.
`;


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
