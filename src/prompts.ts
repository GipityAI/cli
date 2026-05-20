/**
 * All long-form prompt text the CLI hands to Claude Code lives here.
 *
 * If you're tweaking what the agent sees - the per-project CLAUDE.md, the
 * project-context preamble, the resume reminder, or the soft scaffold-warning
 * hook - edit it here, not in claude.ts/setup.ts. Those files import and
 * compose; this file owns the wording.
 *
 * Voice conventions:
 *  - Short imperative sentences. Plain markdown only.
 *  - No bold (`**`). No ALL-CAPS for emphasis - reserved for acronyms
 *    and identifiers (CLAUDE.md, GUID, SQL, etc.).
 *  - Section headings are `## `, lists are `-` or `1.`.
 */

// ---------------------------------------------------------------------------
// Canonical scaffold types. Keep in sync with SCAFFOLD_TEMPLATES in
// platform/packages/shared/src/constants.ts.
//
// Visible types are the default picker. Hidden types are real, working
// templates that aren't yet promoted for default suggestions - the agent
// must NOT suggest them unsolicited, but SHOULD use them when the user
// explicitly asks for that domain ("build me a helpdesk" → app-itsm).
// ---------------------------------------------------------------------------

export interface ScaffoldType {
  key: string;
  for: string;
}

export const SCAFFOLD_TYPES: readonly ScaffoldType[] = [
  { key: 'web-simple',    for: 'Landing page, dashboard, calculator, canvas demo, visualization, animation, single-page tool' },
  { key: 'web-fullstack', for: 'Web app with login, database, or API - CRM, invoice tracker, booking system, admin panel' },
  { key: '2d-game',       for: 'Platformer, arcade, puzzle, endless runner, physics toy (Phaser 3)' },
  { key: '3d-world',      for: 'Multiplayer world, 3D sandbox, shooter, exploration, virtual showroom (Three.js + Rapier + Colyseus)' },
  { key: 'api',           for: 'Backend service, webhook, data pipeline, chatbot, cron job - no frontend' },
] as const;

export const HIDDEN_SCAFFOLD_TYPES: readonly ScaffoldType[] = [
  { key: 'app-itsm',      for: 'IT service management - helpdesk, ticketing, incident management, agent console + portal' },
] as const;

export const SCAFFOLD_TYPE_KEYS = SCAFFOLD_TYPES.map(t => t.key).join('|');

export const SCAFFOLD_TYPE_PICKER = SCAFFOLD_TYPES
  .map(t => `    - \`${t.key}\` - ${t.for}`)
  .join('\n');

export const HIDDEN_SCAFFOLD_PICKER = HIDDEN_SCAFFOLD_TYPES
  .map(t => `    - \`${t.key}\` - ${t.for}`)
  .join('\n');

// ---------------------------------------------------------------------------
// Single source of truth for the build-vs-non-build rule.
// ---------------------------------------------------------------------------

export const BUILD_VS_NON_BUILD_RULE = [
  `## When to add a template`,
  `If the user wants a deployable app (web, game, API): run \`gipity add <template>\` before writing any files. A template wires up \`gipity.yaml\`, deploy config, and sync; hand-written files miss all of it.`,
  `If it's a one-off task (analysis, media, data, research): skip it - use \`gipity sandbox run\` or work with files directly.`,
  `If ambiguous: ask one short clarifying question.`,
  ``,
  `Templates:`,
  SCAFFOLD_TYPE_PICKER,
  `When unsure, default to \`web-simple\`. After adding the template, edit the generated files, then \`gipity deploy dev\`.`,
  `Only skip this on a build request if the user explicitly says not to.`,
  ``,
  `Hidden types (do NOT suggest unsolicited - use only when the user explicitly asks for that domain):`,
  HIDDEN_SCAFFOLD_PICKER,
].join('\n');

export const DEFINITION_OF_DONE = [
  `## Definition of done (build tasks)`,
  `1. \`gipity deploy dev\` succeeds and you have a live URL.`,
  `2. \`gipity page-inspect <url>\` returns no console errors and the page loads (HTTP 200, no blank screen).`,
  `3. For apps with functions: \`gipity test\` passes.`,
  `4. You told the user the live URL.`,
  ``,
  `If any step fails, fix it before claiming done - do not report success on a broken deploy.`,
].join('\n');

export const CAPABILITIES_BLURB_SHORT =
  `Full platform reference is in CLAUDE.md. ` +
  `Prefer CLI commands and the sandbox over \`gipity chat\` - they're faster and cheaper. ` +
  `Naming: honor the user's chosen name; if inventing, blend "Gip" or "Gipity" in.`;

// ---------------------------------------------------------------------------
// Header - appears at the top of every preamble (new, existing, fresh, resume)
// ---------------------------------------------------------------------------

/** Identity-only - used by light wrappers (resume) that don't need the full
 *  file-stats payload. */
export interface ProjectIdentityOpts {
  projectName: string;
  projectSlug: string;
  projectGuid: string;
  accountSlug: string;
  cwd: string;
}

/** Full context - what the fresh-session preamble needs. File stats are
 *  recursive aggregates from the VFS (caller owns the lookup). */
export interface ProjectContextOpts extends ProjectIdentityOpts {
  /** Recursive total of live files in the project's VFS. 0 = empty project. */
  fileCount: number;
  /** Recursive total of live folders. */
  folderCount: number;
  /** Sum of all file sizes in bytes. */
  totalBytes: number;
  /** Pre-formatted top-level entry listing for the header, e.g.
   *  "src/, gipity.yaml, README.md" or "(empty directory)". */
  topLevel: string;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function buildHeader(opts: ProjectContextOpts): string {
  const deployUrl = opts.accountSlug
    ? `https://dev.gipity.ai/${opts.accountSlug}/${opts.projectSlug}/`
    : '(not yet deployed)';
  // "Files" line is the agent's at-a-glance signal of project size and
  // shape. Counts are recursive (from the VFS DB), not just top-level -
  // prevents the bug where a scaffolded project with everything under
  // `src/` showed as "1 top-level entry (src/)" and looked nearly empty.
  const filesLine = opts.fileCount === 0
    ? `- Files: empty (no files yet)`
    : `- Files: ${opts.fileCount} file${opts.fileCount === 1 ? '' : 's'}` +
      ` in ${opts.folderCount} folder${opts.folderCount === 1 ? '' : 's'}` +
      ` (${humanBytes(opts.totalBytes)}) - ${opts.topLevel}`;
  return [
    `## Gipity project`,
    `- Name: ${opts.projectName} (slug: \`${opts.projectSlug}\`)`,
    `- Project GUID: \`${opts.projectGuid}\` (use as \`<PROJECT_GUID>\` in service calls)`,
    `- Directory: ${opts.cwd}`,
    `- Deploy URL: ${deployUrl}`,
    filesLine,
  ].join('\n');
}

const EMPTY_STATE_NOTE =
  `Directory is empty. Apply the scaffolding rule above before writing any files.`;

const EXISTING_STATE_NOTE = [
  `Project already has files. Before making changes:`,
  `- Read \`README.md\` / \`gipity.yaml\` if present to understand what's here.`,
  `- Load the relevant skill with \`gipity skill read <name>\` if you need the template's conventions.`,
  `- Edit in place. Don't add a template over an existing app.`,
  `- Exception: if the existing files are user content (media, data, notes) and the user wants to build an app around them, \`gipity add <template>\` is allowed - it refuses automatically if any file paths would collide.`,
].join('\n');

/** Compact project-context preamble - header + capabilities + state note + definition of done.
 *  The BUILD_VS_NON_BUILD_RULE (scaffold picker, scaffold types, default
 *  recommendations) only fires for empty projects. An existing project
 *  that already has a scaffold doesn't need to be told to pick a scaffold
 *  type - that guidance conflicts with EXISTING_STATE_NOTE's "edit in
 *  place, don't re-scaffold" and led to agents re-scaffolding over live
 *  projects. */
export function buildProjectContextBlock(opts: ProjectContextOpts): string {
  const isEmpty = opts.fileCount === 0;
  return [
    buildHeader(opts),
    ``,
    `## Session`,
    `You're pairing with the user on this project. ${CAPABILITIES_BLURB_SHORT}`,
    ``,
    isEmpty ? BUILD_VS_NON_BUILD_RULE : EXISTING_STATE_NOTE,
    ``,
    isEmpty ? EMPTY_STATE_NOTE : '',
    ``,
    DEFINITION_OF_DONE,
  ].join('\n').replace(/\n{3,}/g, '\n\n');
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
    return `${base}\n\nThe user's first message: "${opts.buildIdea}"\n\nGet started. Apply the scaffolding rule. Report back when you hit the definition of done.`;
  }
  return `${base}\n\nThe user started a blank project with no specific request. Briefly introduce yourself, highlight a few key capabilities, and ask what they want to build.`;
}

// ---------------------------------------------------------------------------
// Non-interactive (-p) wraps - what the relay sends per message
// ---------------------------------------------------------------------------

/** Compact capability reminder - safe to include on every resumed-session message.
 *  Hedges against Claude compacting away the original context block mid-session. */
export const PLATFORM_REMINDER =
  `This project runs on the Gipity platform. All CLI commands and service APIs are documented in CLAUDE.md.`;

/** Tags that bracket the user's actual message inside a wrap. All agent-facing
 *  context and instructions live BEFORE the opening tag; nothing comes after
 *  the closing tag. The client-side `stripPreamble` renderer in
 *  `platform/client/src/ts/commands/claude-display.ts` looks for the same
 *  strings - keep the two copies in sync (there is a drift-guard test). */
export const USER_MSG_OPEN = '<gipity-user-message>';
export const USER_MSG_CLOSE = '</gipity-user-message>';

/** Standing instruction applied to every relay-dispatched message. Placed
 *  once, before the user message, so the model doesn't trip over a trailing
 *  instruction after it has already read the question. */
const RESPONSE_DIRECTIVE =
  `Respond to the user message below. Don't greet or reintroduce yourself.`;

/** Resume wrap: compact header + capability reminder + short framing.
 *  Takes identity only - resume doesn't need the full file stats
 *  (Claude already has the context from the initial start dispatch). */
export function buildResumeWrap(opts: ProjectIdentityOpts, userMsg: string): string {
  const deployUrl = opts.accountSlug
    ? `https://dev.gipity.ai/${opts.accountSlug}/${opts.projectSlug}/`
    : '(not yet deployed)';
  return [
    `Project: ${opts.projectName} (\`${opts.projectGuid}\`) - ${deployUrl}`,
    PLATFORM_REMINDER,
    `Resumed session - scaffold before building (see CLAUDE.md); skip for one-off tasks.`,
    ``,
    RESPONSE_DIRECTIVE,
    ``,
    USER_MSG_OPEN,
    userMsg,
    USER_MSG_CLOSE,
  ].join('\n');
}

/** Fresh wrap: full project context + the user's message. */
export function buildFreshWrap(contextBlock: string, userMsg: string): string {
  return [
    contextBlock,
    ``,
    RESPONSE_DIRECTIVE,
    ``,
    USER_MSG_OPEN,
    userMsg,
    USER_MSG_CLOSE,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// PreToolUse soft-warning hook (advisory message printed to stderr)
// ---------------------------------------------------------------------------

/** Plain ASCII, no apostrophes or backslashes - embedded inside a node -e shell command. */
export const SCAFFOLD_HOOK_WARNING =
  `[gipity] Heads up: this project has no app yet. If you are building an app/game/API to deploy, ` +
  `stop and run: gipity add <${SCAFFOLD_TYPE_KEYS}>  (default: web-simple). ` +
  `If this is a one-off task (analysis, data, PDFs, scratch work), proceed.`;

// ---------------------------------------------------------------------------
// Per-project CLAUDE.md (written by `gipity claude` / `gipity init` setup)
// ---------------------------------------------------------------------------

export const SKILLS_CONTENT = `# Gipity Integration

Gipity is the agent-tuned platform where AI-built apps live. Real compute, storage, hosting, databases, deployment, workflows, code execution, and monitoring - always on. Gip is the cloud agent that runs on Gipity.

This Claude Code session is connected to a Gipity project. Prefer the cheapest option that works - CLI and sandbox are instant and free, app services are runtime HTTP calls, \`gipity chat\` burns LLM tokens:

1. CLI commands (fast, no agent overhead). The \`gipity\` CLI covers add, deploy, db, fn, logs, browser, sync, memory, skill, and more. Run \`gipity --help\` for the full list. All commands support \`--json\`.
2. Cloud sandbox via \`gipity sandbox run\` - Docker container with pre-installed tools for media (ffmpeg, ImageMagick, sox), documents (pandoc, LibreOffice), and data (pandas, matplotlib, sqlite3). Run \`gipity skill read sandbox-tools\` for the full toolkit. No network from inside the sandbox - fetch what you need before sending it in.
3. App services - runtime HTTP endpoints your deployed app calls directly at \`https://a.gipity.ai/api/<PROJECT_GUID>/services/*\`. Available: LLM, TTS, image, sound, music, transcribe, video, file upload, realtime. Load the matching skill (\`app-llm\`, \`app-tts\`, etc.) before writing service code - they have the schemas, auth pattern, and common-mistake guards. For one-off generation during development, prefer \`gipity generate <image|video|...>\` or \`gipity chat\`.
4. Delegate to Gip (\`gipity chat "<task>"\`) - only when the work genuinely needs agent reasoning or a tool not in the CLI, sandbox, or app services. Required for: Twitter/X search, Gmail, calendar, push notifications, video understanding, audio source isolation, cross-model second opinions, multi-step orchestration. Don't use \`gipity chat\` for anything the sandbox can do - it's slower and burns tokens.

You are the developer. Write files in this directory - they auto-sync to Gipity via hooks. Don't run \`npm install\`, \`npm start\`, \`node\`, or \`python\` locally; there is no local runtime. Code runs in the Gipity sandbox.

## When to add a template

The full rule and definition of done are injected at the top of every session context. In short: if the user asks you to build something deployable (web app, game, API), run \`gipity add <template>\` first (default \`web-simple\`); if it's a one-off task (analysis, PDFs, data work), use \`gipity sandbox run\` instead. To add a reusable building block to an existing app (e.g. multiplayer), \`gipity add <kit>\`.

## CLI quick reference

Key commands: \`gipity add <template|kit>\`, \`gipity deploy dev\`, \`gipity sandbox run\`, \`gipity page-inspect <url>\`, \`gipity db query "SQL"\`, \`gipity fn call <name>\`, \`gipity skill read <name>\`.
Run \`gipity --help\` for the full list. Use \`--help\` on any command for details.

## Files and sync

Write files locally - hooks auto-push to Gipity on every save. Remote-generated files (images, audio from \`gipity chat\`) auto-pull. Use \`gipity sync\` if things get out of sync. Deletes are safe - use \`rollback\` with a datetime to undo, or \`file_version_restore\` for individual files.

## Skills (detailed documentation)

Run \`gipity skill list\` to see all available skill docs. Run \`gipity skill read <name>\` to read one. Load the relevant skill before starting a task - they contain the correct API patterns, code examples, and common mistakes.

App services skills (load before calling \`/services/*\` endpoints):
- \`app-llm\` - chat completions, streaming, image input
- \`app-tts\` - voices, multi-speaker, languages
- \`app-image\` - providers, sizes, aspect ratios
- \`app-audio\` - sound effects, music, transcription
- \`app-video\` - Veo models, aspect, resolution
- \`app-files\` - uploads, variants, file listing
- \`app-auth\` - sign in with Gipity, popup vs redirect
- \`app-realtime\` - Colyseus rooms, relay vs state

Other key skills:
- \`web-app-basics\` - coding guidelines, file structure, HTML/CSS/JS patterns
- \`app-development\` - functions, database and API
- \`3d-world\` - 3D multiplayer game template (Three.js + Rapier + Colyseus)
- \`2d-game\` - 2D game template (Phaser 3)
- \`sandbox-tools\` - cloud sandbox capabilities and pre-installed tools
- \`tts-guide\` - agent-side speech tools (different from the \`app-tts\` HTTP service)
`;
