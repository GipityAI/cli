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

// The build-vs-non-build rule and definition-of-done are now sourced from
// platform/docs/knowledge/*.md and regenerated into ./knowledge.ts. Edit the
// markdown, not this file. See `just sync-knowledge`.
import { BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE } from './knowledge.js';

// ---------------------------------------------------------------------------
// Canonical template catalog (CLI mirror). Keep in sync with TEMPLATES in
// platform/packages/shared/src/constants.ts. The CLI ships standalone, so it
// can't import @easyclaw/shared at runtime.
//
// Visible templates are the default picker. Hidden templates are real, working
// scaffolds that aren't yet promoted for default suggestions - the agent
// must NOT suggest them unsolicited, but SHOULD use them when the user
// explicitly asks for that domain ("build me a helpdesk" → app-itsm).
// ---------------------------------------------------------------------------

export interface TemplateEntry {
  key: string;
  for: string;
}

export const TEMPLATES: readonly TemplateEntry[] = [
  { key: 'web-simple',    for: 'Landing page, dashboard, calculator, canvas demo, visualization, animation, single-page tool' },
  { key: 'web-fullstack', for: 'Web app with login, database, or API - CRM, invoice tracker, booking system, admin panel' },
  { key: '2d-game',       for: 'Platformer, arcade, puzzle, endless runner, physics toy (Phaser 3)' },
  { key: '3d-world',      for: 'Multiplayer world, 3D sandbox, shooter, exploration, virtual showroom (Three.js + Rapier + Colyseus)' },
  { key: '3d-engine',     for: 'Minimal 3D multiplayer base - Three.js + Rapier + Colyseus, no gameplay; build your own on top' },
  { key: 'api',           for: 'Backend service, webhook, data pipeline, chatbot, cron job - no frontend' },
] as const;

export const HIDDEN_TEMPLATES: readonly TemplateEntry[] = [
  { key: 'app-itsm',      for: 'IT service management - helpdesk, ticketing, incident management, agent console + portal' },
] as const;

export const TEMPLATE_KEY_PATTERN = TEMPLATES.map(t => t.key).join('|');

export const TEMPLATE_PICKER = TEMPLATES
  .map(t => `    - \`${t.key}\` - ${t.for}`)
  .join('\n');

export const HIDDEN_TEMPLATE_PICKER = HIDDEN_TEMPLATES
  .map(t => `    - \`${t.key}\` - ${t.for}`)
  .join('\n');

// ---------------------------------------------------------------------------
// The build-vs-non-build rule and definition-of-done. Canonical source is
// platform/docs/knowledge/{build-vs-non-build,definition-of-done}.md;
// imported from the generated ./knowledge.ts above and re-exported here so
// the CLI's public prompt surface is unchanged.
// ---------------------------------------------------------------------------

export { BUILD_VS_NON_BUILD_RULE, DEFINITION_OF_DONE };

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
// Per-project CLAUDE.md / AGENTS.md body.
//
// The content (`SKILLS_CONTENT`) is sourced from
// platform/docs/knowledge/cli-integration.md and regenerated into
// ./knowledge.ts. setup.ts imports it from there directly. Edit the markdown.
// ---------------------------------------------------------------------------
