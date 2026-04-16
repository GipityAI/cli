/**
 * All long-form prompt text the CLI hands to Claude Code lives here.
 *
 * If you're tweaking what the agent sees — the per-project CLAUDE.md, the
 * project-context preamble, the resume reminder, or the soft scaffold-warning
 * hook — edit it here, not in claude.ts/setup.ts. Those files import and
 * compose; this file owns the wording.
 *
 * Voice conventions:
 *  - Short imperative sentences. Plain markdown only.
 *  - No bold (`**`). No ALL-CAPS for emphasis — reserved for acronyms
 *    and identifiers (CLAUDE.md, GUID, SQL, etc.).
 *  - Section headings are `## `, lists are `-` or `1.`.
 */

// ---------------------------------------------------------------------------
// Canonical scaffold types. Keep in sync with VISIBLE_SCAFFOLD_TEMPLATES in
// platform/server/src/services/tools/handlers/app-scaffold.ts. `app-itsm` is
// intentionally omitted from guidance — still selectable via
// `gipity scaffold --type app-itsm`, just not a suggested default.
// ---------------------------------------------------------------------------

export interface ScaffoldType {
  key: string;
  for: string;
}

export const SCAFFOLD_TYPES: readonly ScaffoldType[] = [
  { key: 'web-simple',    for: 'Static page, canvas demo, visualization, physics toy, landing page, dashboard, single-page tool' },
  { key: 'web-fullstack', for: 'Frontend + backend — needs DB or serverless functions' },
  { key: '2d-game',       for: 'Phaser platformer / arcade / puzzle / endless runner' },
  { key: '3d-world',      for: 'Three.js + Rapier + Colyseus multiplayer world' },
  { key: 'api',           for: 'API only, no frontend' },
] as const;

export const SCAFFOLD_TYPE_KEYS = SCAFFOLD_TYPES.map(t => t.key).join('|');

export const SCAFFOLD_TYPE_PICKER = SCAFFOLD_TYPES
  .map(t => `    - \`${t.key}\` — ${t.for}`)
  .join('\n');

// ---------------------------------------------------------------------------
// Single source of truth for the build-vs-non-build rule.
// ---------------------------------------------------------------------------

export const BUILD_VS_NON_BUILD_RULE = [
  `## Build vs. one-off`,
  `Build request (deployable — web app, game, API): run \`gipity scaffold --type <type>\` before writing any files. Scaffolding wires up \`gipity.yaml\`, deploy config, and sync; hand-written files miss all of it. Pick the type:`,
  SCAFFOLD_TYPE_PICKER,
  `When unsure, default to \`web-simple\`. After scaffolding, edit the generated files, then \`gipity deploy dev\`.`,
  ``,
  `One-off task (PDF analysis, data exploration, media/document work, research, scratch): do not scaffold. Use \`gipity sandbox run\` for compute, or work with files directly.`,
  ``,
  `If ambiguous, ask one short clarifying question. Only skip scaffolding on a build request if the user explicitly says "don't scaffold".`,
].join('\n');

export const DEFINITION_OF_DONE = [
  `## Definition of done (build tasks)`,
  `1. \`gipity deploy dev\` succeeds and you have a live URL.`,
  `2. \`gipity browser <url>\` shows no console errors and the golden path works.`,
  `3. For apps with functions: \`gipity test\` passes.`,
  `4. You told the user the live URL.`,
  ``,
  `If any step fails, fix it before claiming done — do not report success on a broken deploy.`,
].join('\n');

export const CAPABILITIES_BLURB_SHORT =
  `Gipity gives this session: cloud hosting, Postgres, serverless functions, a sandboxed toolkit ` +
  `(ffmpeg, ImageMagick, pandas, pandoc, LibreOffice, etc.), headless browsers, file storage, email, ` +
  `image/TTS/video generation, web search, scheduled workflows, persistent memory, custom domains. ` +
  `Full reference is in CLAUDE.md. Prefer CLI commands and the sandbox over \`gipity chat\` — they're ` +
  `faster and don't burn LLM tokens. Naming: honor the user's chosen name; if inventing, blend "Gip" or "Gipity" in.`;

// ---------------------------------------------------------------------------
// Header — appears at the top of every preamble (new, existing, fresh, resume)
// ---------------------------------------------------------------------------

export interface ProjectContextOpts {
  projectName: string;
  projectSlug: string;
  projectGuid: string;
  accountSlug: string;
  cwd: string;
  /** Pre-computed top-level file listing string (caller owns the fs scan) */
  contents: string;
  /** Pre-computed top-level entry count (caller owns the fs scan). 0 = empty. */
  fileCount: number;
}

function buildHeader(opts: ProjectContextOpts): string {
  const deployUrl = opts.accountSlug
    ? `https://dev.gipity.ai/${opts.accountSlug}/${opts.projectSlug}/`
    : '(not yet deployed)';
  const entryLabel = opts.fileCount === 1 ? 'entry' : 'entries';
  return [
    `## Gipity project`,
    `- Name: ${opts.projectName} (slug: \`${opts.projectSlug}\`)`,
    `- GUID: \`${opts.projectGuid}\` — use as \`<PROJECT_GUID>\` in App Services calls`,
    `- Directory: ${opts.cwd}`,
    `- Deploy URL: ${deployUrl}`,
    `- Files: ${opts.fileCount} top-level ${entryLabel}${opts.fileCount > 0 ? ` (${opts.contents})` : ''}`,
  ].join('\n');
}

const EMPTY_STATE_NOTE =
  `Directory is empty. Apply the build-vs-one-off rule above before writing any files.`;

const EXISTING_STATE_NOTE = [
  `Project already has files. Before making changes:`,
  `- Read \`README.md\` / \`gipity.yaml\` if present to understand what's here.`,
  `- Load the relevant skill with \`gipity skills read <name>\` if you need the scaffold's conventions.`,
  `- Edit in place. Don't re-scaffold over an existing app.`,
  `- Exception: if the existing files are user content (media, data, notes) and the user wants to build an app around them, scaffolding is allowed — \`gipity scaffold\` will refuse automatically if any file paths would collide.`,
].join('\n');

/** Compact project-context preamble — header + capabilities + build rule + state note + definition of done. */
export function buildProjectContextBlock(opts: ProjectContextOpts): string {
  const isEmpty = opts.fileCount === 0;
  return [
    buildHeader(opts),
    ``,
    `## Session`,
    `You're pairing with the user on this project. ${CAPABILITIES_BLURB_SHORT}`,
    ``,
    BUILD_VS_NON_BUILD_RULE,
    ``,
    isEmpty ? EMPTY_STATE_NOTE : EXISTING_STATE_NOTE,
    ``,
    DEFINITION_OF_DONE,
  ].join('\n');
}

/** Project-context block + a brief greeting instruction. */
export function buildExistingProjectPrompt(opts: ProjectContextOpts): string {
  const isEmpty = opts.fileCount === 0;
  const greeting = isEmpty
    ? `Briefly greet the user and ask what they want to build.`
    : `Briefly greet the user, summarize what this project appears to be (based on the file listing and any README/CLAUDE.md/gipity.yaml), and ask what they want to work on next.`;
  return [buildProjectContextBlock(opts), ``, greeting].join('\n');
}

/** First-launch prompt for a brand-new (empty) project. Reuses buildProjectContextBlock. */
export function buildNewProjectPrompt(opts: ProjectContextOpts & { buildIdea: string }): string {
  const base = buildProjectContextBlock(opts);
  if (opts.buildIdea) {
    return `${base}\n\nThe user's first message: "${opts.buildIdea}"\n\nGet started. Apply the build-vs-one-off rule. Report back when you hit the definition of done.`;
  }
  return `${base}\n\nThe user started a blank project with no specific request. Briefly introduce yourself, highlight a few key capabilities, and ask what they want to build.`;
}

// ---------------------------------------------------------------------------
// Non-interactive (-p) wraps — what the relay sends per message
// ---------------------------------------------------------------------------

/** Compact capability reminder — safe to include on every resumed-session message.
 *  Hedges against Claude compacting away the original context block mid-session. */
export const PLATFORM_REMINDER =
  `This project runs on the Gipity hosting platform. The \`gipity\` CLI exposes 90+ tools — common ones: ` +
  `\`gipity deploy dev\`, \`gipity browser <url>\`, \`gipity sandbox run\`, \`gipity test\`, \`gipity fn call\`. ` +
  `Run \`gipity skills list\` for the full skill catalog; full platform reference is in \`CLAUDE.md\`.`;

/** Resume wrap: header + capability reminder + short framing. */
export function buildResumeWrap(opts: ProjectContextOpts, userMsg: string): string {
  return [
    buildHeader(opts),
    ``,
    PLATFORM_REMINDER,
    `Resumed session — apply the build-vs-one-off rule for new features; files auto-sync on save.`,
    ``,
    `User message: ${userMsg}`,
    ``,
    `Answer directly. Do not greet or reintroduce yourself.`,
  ].join('\n');
}

/** Fresh wrap: full project context + the user's message. */
export function buildFreshWrap(contextBlock: string, userMsg: string): string {
  return `${contextBlock}\n\nUser message: ${userMsg}\n\nAnswer directly. Do not greet or reintroduce yourself.`;
}

// ---------------------------------------------------------------------------
// PreToolUse soft-warning hook (advisory message printed to stderr)
// ---------------------------------------------------------------------------

/** Plain ASCII, no apostrophes or backslashes — embedded inside a node -e shell command. */
export const SCAFFOLD_HOOK_WARNING =
  `[gipity] Heads up: this project has no scaffold yet. If you are building an app/game/API to deploy, ` +
  `stop and run: gipity scaffold --type <${SCAFFOLD_TYPE_KEYS}>  (default: web-simple). ` +
  `If this is a one-off task (analysis, data, PDFs, scratch work), proceed.`;

// ---------------------------------------------------------------------------
// Per-project CLAUDE.md (written by `gipity claude` / `gipity init` setup)
// ---------------------------------------------------------------------------

export const SKILLS_CONTENT = `# Gipity Integration

Gipity is a platform for cloud agents — AI agents that run on a server with persistent memory, storage, a database, a sandboxed runtime, and direct internet access. Gip is the cloud agent on Gipity.

This Claude Code session is connected to a Gipity project. You have four ways to use the platform — try them in this order before falling back to \`gipity chat\`:

1. CLI commands (fast, no agent overhead). The \`gipity\` CLI exposes ~30 commands covering scaffold/deploy/db/fn/logs/browser/sync/memory/skills/etc. Use these whenever possible.
2. Cloud sandbox via \`gipity sandbox run\` (fast, no agent overhead, no deploy needed). The sandbox is a Docker container with a huge pre-installed toolkit — use it for any one-off media, data, or build task instead of delegating to Gip:
   - Media: \`ffmpeg\` (transcode, trim, concat, extract audio, generate thumbnails, splice video), \`ImageMagick\` (resize, convert, composite, OCR-friendly preprocess), \`sox\` (audio mix/normalize/effects), \`exiftool\`, \`mediainfo\`, \`optipng\`, \`gifsicle\`, \`webp\`, \`potrace\` (raster→SVG)
   - Documents: \`pandoc\` (any-to-any docs), \`LibreOffice\` headless (DOCX/XLSX/PPTX↔PDF), \`wkhtmltopdf\`, \`poppler-utils\` (PDF text/image extract), \`ghostscript\`, \`qpdf\`, \`python-docx\`, \`python-pptx\`, \`openpyxl\`, \`reportlab\`, \`cairosvg\`
   - Data / analysis: Python with \`pandas\`, \`numpy\`, \`scipy\`, \`sympy\`, \`matplotlib\`, \`seaborn\`, \`pillow\`, \`bs4\`, \`requests\`, \`pyyaml\`, \`jinja2\`, \`tabulate\`, plus \`csvkit\`, \`miller\`, \`datamash\`, \`jq\`, \`xmlstarlet\`, \`sqlite3\`
   - Misc: \`Graphviz\`, \`gnuplot\`, \`qrcode\`, \`p7zip\`, \`GCC/G++\`, \`Rust\` (rustc/cargo), \`mingw-w64\` (Windows cross-compile)
   - Languages: Node 20, Python 3, Bash. Workspace files are auto-injected; output files auto-extract back to the project. Sticky session per user (state persists across calls). No network from inside the sandbox — fetch what you need before sending it in.

   Examples:
   \`\`\`bash
   gipity sandbox run --lang bash "ffmpeg -i input.mp4 -vf scale=640:-1 -c:a copy out.mp4"
   gipity sandbox run --lang bash "convert input.png -resize 200x200 thumb.jpg"   # ImageMagick
   gipity sandbox run --lang py   "import pandas as pd; print(pd.read_csv('sales.csv').groupby('region').total.sum())"
   gipity sandbox run --lang bash "libreoffice --headless --convert-to pdf report.docx"
   gipity sandbox run --lang bash "pandoc article.md -o article.pdf"
   \`\`\`
3. Call app services directly from your app (no agent overhead, runtime endpoints). LLM, TTS, image, sound, music, transcription, video, file upload, and realtime multiplayer are HTTP endpoints under \`https://a.gipity.ai/api/<PROJECT_GUID>/services/*\` — see the app services section below. These are for the deployed app to call at runtime; for one-off generation during development, prefer \`gipity generate <image|video|...>\` or \`gipity chat\`.
4. Delegate to Gip (\`gipity chat "<task>"\`) — only when the work genuinely needs agent reasoning or a tool that isn't in the CLI, the sandbox, or the app services. Required for: Twitter/X search, Gmail, calendar operations, push notifications, video understanding, audio source isolation, cross-model second opinions, multi-step orchestration. Don't use \`gipity chat\` to run ffmpeg, ImageMagick, pandas, LibreOffice, pandoc, or anything else listed in the sandbox toolkit above — \`gipity sandbox run\` is faster and doesn't burn tokens.

You are the developer. Write files in this directory — they auto-sync to Gipity via hooks. Don't run \`npm install\`, \`npm start\`, \`node\`, or \`python\` locally; there is no local runtime. Code runs in the Gipity sandbox.

## Build vs. one-off

The full build-vs-one-off rule and definition of done are injected at the top of every session context. In short: if the user asks you to build something deployable (web app, game, API), run \`gipity scaffold --type <type>\` first (default \`web-simple\`); if it's a one-off task (analysis, PDFs, data work), use \`gipity sandbox run\` — do not scaffold.

## Remote control

This session can be driven from the Gipity web CLI on any browser (desktop or phone). The first \`gipity claude\` run on this machine pairs the device and starts the relay daemon automatically. Once paired, typing \`/claude\` (or \`/cc\`) in the web CLI enters dispatch mode; each message queues a new \`gipity claude -p "…"\` session here and streams the captured conversation back to their browser. If the user asks how to use Gipity from their phone or another browser, point them at \`gipity relay --help\`.

## Workflow

1. Write and edit files normally (auto-pushed to Gipity on every save)
2. \`gipity deploy dev\` → live URL instantly
3. \`gipity deploy prod\` when ready

## CLI commands

| Command | Purpose |
|---------|---------|
| \`gipity scaffold [title]\` | Create app structure. \`--type\` is required. Canonical types: \`${SCAFFOLD_TYPE_KEYS}\`. Run \`gipity scaffold --help\` for the full list. |
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
| \`gipity status\` | Check project and auth status (project GUID, slug, auth state) |

All commands support \`--json\` for structured output. Use \`--help\` on any command for details (auto-fetches relevant skill docs from the server).

## Platform capabilities

- App hosting — deploy to dev/prod URLs on Gipity CDN
- Databases — per-project PostgreSQL databases with SQL access
- Serverless functions — JavaScript functions callable via REST
- Multiplayer — Colyseus WebSocket rooms (relay and state-synced)
- Image generation — OpenAI (gpt-image-1, DALL-E 3) and BFL/Flux
- Speech / TTS — ElevenLabs and OpenAI voices
- Audio/video processing — FFmpeg, sox, transcription, source isolation
- Web search — Brave API
- Browser automation — open URLs, screenshot, click, fill forms, console
- Workflows — cron or webhook-triggered multi-step AI pipelines
- Email — SendGrid transactional email
- Cloud sandbox — Python, Node.js, Bash with 50+ pre-installed tools
- Cross-model queries — ask GPT-5, Claude, etc. for second opinions

## App services (HTTP endpoints your deployed app can call)

Every project automatically exposes platform services at \`https://a.gipity.ai/api/<PROJECT_GUID>/services/*\`. Your frontend or function calls these directly — don't write a server-side wrapper function for them, and don't fall back to browser APIs (e.g. \`window.speechSynthesis\`). Billing defaults to your credits (\`owner_pays\`); no setup needed.

Your \`<PROJECT_GUID>\` is printed in the session context header on every launch, and also via \`gipity status --json\`.

| Service | Endpoint | Purpose |
|---------|----------|---------|
| LLM | \`POST /services/llm\` | OpenAI-style chat completions (Anthropic + OpenAI models, streaming) |
| TTS | \`POST /services/tts\` | Text-to-speech → MP3 URL (ElevenLabs/OpenAI/Gemini) |
| Image | \`POST /services/image\` | Image generation (OpenAI/BFL/Gemini) |
| Sound effects | \`POST /services/sound\` | ElevenLabs SFX from text |
| Music | \`POST /services/music\` | ElevenLabs music from prompt |
| Transcribe (STT) | \`POST /services/transcribe\` | Multipart audio → text |
| Video | \`POST /services/video\` | Veo 3.1 video with audio |
| Files | \`POST /uploads/init\` + \`/uploads/complete\` | Presigned S3 uploads up to 30 GB |
| Realtime | \`wss://rt.gipity.ai\` | Colyseus rooms (relay or state) |

### Universal auth — mint an app token

\`\`\`js
const r = await fetch('https://a.gipity.ai/api/token', {  // must be absolute URL, POST
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: '<PROJECT_GUID>' })
});
const { data: { token } } = await r.json();              // token is at .data.token
\`\`\`
Send on every service call as \`X-App-Token: <token>\`. For \`auth: user\` functions or \`user_pays\` services also pass \`credentials: 'include'\` so the \`.gipity.ai\` session cookie travels.

Common mistakes the agent should avoid:
- Relative URL \`/api/token\` (hits app host, 404) — always absolute \`https://a.gipity.ai/api/token\`
- Reading \`json.token\` instead of \`json.data.token\`
- Treating the project GUID as the bearer token
- Writing a server-side TTS \`speak\` function or a \`useBrowserTts\` fallback — just call \`/services/tts\` from the browser and \`new Audio(url).play()\`
- Calling \`client.getAvailableRooms()\` for realtime — that method doesn't exist; use \`GET https://rt.gipity.ai/rooms?room=<name>&token=<t>\`

### Quick examples

LLM:
\`\`\`js
const r = await fetch(\`https://a.gipity.ai/api/\${APP}/services/llm\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], model: 'gpt-5-mini' })
});
const { choices } = await r.json();
// choices[0].message.content
\`\`\`

TTS:
\`\`\`js
const r = await fetch(\`https://a.gipity.ai/api/\${APP}/services/tts\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({ text: 'Hello world', provider: 'elevenlabs' })
});
const { url } = await r.json();
new Audio(url).play();
\`\`\`

Transcribe:
\`\`\`js
const fd = new FormData();
fd.append('audio', file);                    // mp3/wav/m4a, up to 100MB
fd.append('diarize', 'true');                // optional
const r = await fetch(\`https://a.gipity.ai/api/\${APP}/services/transcribe\`, {
  method: 'POST',
  headers: { 'X-App-Token': token },         // do not set Content-Type for FormData
  body: fd
});
const { text } = await r.json();
\`\`\`

File upload (helper script handles progress + multipart for 5GB+ files):
\`\`\`html
<script src="https://media.gipity.ai/scripts/gipity-upload.js"></script>
<script>
  const result = await Gipity.upload(file, { appGuid: '<PROJECT_GUID>', appToken: token });
  // result.url, result.guid
</script>
\`\`\`

For full request/response schemas, parameters, error codes, and edge cases (streaming, image input, multi-speaker TTS, Veo aspect ratios, multipart uploads, popup auth flow, Colyseus room safety patterns), load the matching skill before writing code.

## Detailed documentation

Run \`gipity skills list\` to see all available skill docs. Run \`gipity skills read <name>\` to read one.

App services skills (load before calling \`/services/*\` endpoints — they contain the canonical request/response schemas, examples, and common-mistake guards):

- \`app-llm\` — \`/services/llm\` (chat completions, streaming, image input, model list)
- \`app-tts\` — \`/services/tts\` (voices, multi-speaker Gemini, languages)
- \`app-image\` — \`/services/image\` (providers, sizes, aspect ratios)
- \`app-audio\` — \`/services/sound\`, \`/services/music\`, \`/services/transcribe\`
- \`app-video\` — \`/services/video\` (Veo models, aspect, resolution)
- \`app-files\` — \`/uploads/init\`+\`/uploads/complete\`, \`gipity-upload.js\` helper, variants, file listing
- \`app-auth\` — sign in with Gipity, popup vs redirect, \`auth/status\`, error codes
- \`app-realtime\` — Colyseus rooms (relay vs state), \`MapSchema\` init guard, room discovery

Other key skills:

- \`web-app-basics\` — coding guidelines, file structure, HTML/CSS/JS patterns
- \`app-development\` — functions, database & API (write functions → deploy → test → call via REST)
- \`3d-world\` — 3D multiplayer game template (Three.js + Rapier + Colyseus)
- \`2d-game\` — 2D game template (Phaser 3)
- \`sandbox-tools\` — cloud sandbox capabilities and pre-installed tools
- \`tts-guide\` — agent-side speech tools (\`speech_generate\`, \`voice_set\`, sound/music) — different from the \`app-tts\` HTTP service

Load the relevant skill before starting a task — they contain the correct API patterns, code examples, and common mistakes.

## File operations

All file creation and editing should happen locally — hooks auto-push changes to Gipity. Don't use \`gipity chat\` to create or edit files. Use \`gipity sync\` if files get out of sync. Files generated remotely by \`gipity chat\` (images, audio, etc.) also sync down automatically and can be referenced in your code like any local file.

## Authentication

1. \`gipity login --email user@example.com\` → sends a 6-digit code
2. \`gipity login --email user@example.com --code 123456\`

## Sync behavior

- Auto-push — files push to Gipity after every Write/Edit (hook)
- Auto-pull — remote changes pull before each prompt (hook)
- Tool-generated files sync too — images, audio, and other files created by \`gipity chat\` or remote agent tools auto-pull like any other
- Deletes are safe — use \`rollback\` with a datetime to undo, or \`file_version_restore\` for individual files
`;
