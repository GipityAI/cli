import { Command } from 'commander';
import { basename, resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getAccountSlug } from '../api.js';
import { getConfig, getConfigPath, saveConfigAt } from '../config.js';
import { getAuth } from '../auth.js';
import { slugify, setupProjectTools, SUPPORTED_TOOLS, DEFAULT_TOOLS, DEFAULT_SYNC_IGNORE, resolveProjectTools, type SupportedTool } from '../setup.js';
import { AGENT_ADAPTERS } from '../agents/index.js';
import { success, error as clrError, info, muted, bold, brand } from '../colors.js';
import { confirm } from '../utils.js';
import {
  scanForAdoption,
  adoptCurrentDir,
  canAdoptCwd,
  formatBytes,
  formatCwdLabel,
  ADOPT_THRESHOLDS,
} from '../adopt-cwd.js';

const TOOL_KEYS = SUPPORTED_TOOLS.map(t => t.key);

/** The tool keys to pin in .gipity.json, or null to leave the project on
 *  auto-detect. Only an explicit `--for` pins: a bare `init` records nothing,
 *  so the project keeps tracking whatever the user installs later. `--for all`
 *  is an explicit choice too - it pins the full set on purpose. */
function pinnedToolKeys(forFlag: string | undefined, tools: SupportedTool[]): string[] | null {
  return forFlag ? tools.map(t => t.key) : null;
}

/** Which tools this `init` run sets up.
 *
 *  No `--for` defers to the project: its existing pin if it has one, else
 *  what's installed here (resolveProjectTools). Falling straight through to
 *  detection instead would make a bare re-run of `init` quietly widen a pinned
 *  project back out - `--for opencode` today, then a plain `gipity init`
 *  tomorrow re-adds every installed agent's primer.
 *
 *  On a FRESH init there is no config yet, so this is detection, as intended. */
function resolveTools(forFlag: string | undefined): SupportedTool[] {
  if (!forFlag) return resolveProjectTools();
  const requested = forFlag.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const unknown = requested.filter(k => !TOOL_KEYS.includes(k) && k !== 'all');
  if (unknown.length) {
    throw new Error(`Unknown --for value(s): ${unknown.join(', ')}. Valid: ${TOOL_KEYS.join(', ')}, all`);
  }
  // `all` expands to the default set; an opt-in tool still joins when named
  // alongside it (`--for all,aider`).
  return SUPPORTED_TOOLS.filter(
    t => requested.includes(t.key) || (!t.optIn && requested.includes('all')),
  );
}

export const initCommand = new Command('init')
  .description('Link this directory to a project')
  .addHelpText('after', `\nWrites CLAUDE.md/AGENTS.md primer files so your AI coding tool understands Gipity, and installs the Gipity skills + file-sync hooks. By default it only sets up the tools actually installed here (${AGENT_ADAPTERS.map(a => a.displayName).join(', ')}, …) - use --for to choose explicitly.`)
  .argument('[name]', 'Project name/slug (defaults to current directory name)')
  .option('--agent <guid>', 'Agent GUID to use')
  .option('--no-capture', 'Don\'t record Claude Code sessions in this directory to your Gipity project (sets captureHooks: false in .gipity.json)')
  .option(
    '--for <tools>',
    `Which AI tool primer files to write (comma-separated). Default: the tools detected on this machine. An explicit --for is remembered in .gipity.json, so later commands don't re-add the others. Choices: ${TOOL_KEYS.join(', ')}, all`,
  )
  .addHelpText('after', `
Examples:
  $ gipity init                          Link cwd as a new project (slug = dir name);
                                         sets up the tools installed on this machine.
  $ gipity init my-app                   Link cwd with an explicit slug.
  $ gipity init --for opencode           Only opencode - pinned, so a later
                                         gipity build won't re-add the others.
  $ gipity init --for all                Every tool, whether installed or not.
  $ gipity init --for codex              AGENTS.md + Codex skills/sync hooks only.
  $ gipity init --for grok               AGENTS.md + the Gipity plugin in Grok only.
  $ gipity init --for cursor,gemini      Write only the Cursor + Gemini primers.
  $ gipity init --for aider              AGENTS.md + a read: entry in .aider.conf.yml
                                         (aider auto-reads nothing, so it's opt-in).

Working with an existing Gipity project:
  - If cwd's name matches the remote project's slug, init auto-adopts it.
  - Otherwise, init creates a new project. To point cwd at a different existing
    project after init, switch and pull:
        $ gipity project --json          List your projects (machine-readable).
        $ gipity project <slug>          Switch this dir's linked project.
        $ gipity sync                    Pull the project's files down.
`)
  .action(async (name: string | undefined, opts) => {
    // Resolve the requested tool primer set up front so a bad --for value
    // fails fast with a clear message instead of going through the catch.
    let tools: SupportedTool[];
    try {
      tools = resolveTools(opts.for);
    } catch (e: any) {
      console.error(clrError(e.message));
      process.exit(1);
    }
    const wantsClaude = tools.some(t => t.key === 'claude');
    const primerSummary = tools.map(t => t.label).join(', ');
    // Name what was left out, and how to get it. Silence here is what made the
    // old write-everything default feel arbitrary in the other direction: a
    // user with one agent could not tell whether a missing primer was a
    // decision or a bug.
    const skipped = DEFAULT_TOOLS.filter(d => !tools.some(t => t.key === d.key));
    const skippedNote = skipped.length
      ? `${muted(`Skipped (not installed here): ${skipped.map(t => t.key).join(', ')} - add with`)} ${brand(`gipity init --for ${skipped.map(t => t.key).join(',')}`)}${muted('.')}`
      : null;

    try {
      // Check auth
      const auth = getAuth();
      if (!auth) {
        console.error(clrError('Not logged in. Run: gipity login'));
        process.exit(1);
      }

      const cwd = process.cwd();

      // Already a project root *here* - just re-run setup. `init` deliberately
      // checks only cwd, never an ancestor: it is the explicit "make this
      // directory a project" verb (the `git init` analog) and must not be
      // shadowed by a parent project's config the way walk-up commands are.
      if (existsSync(resolve(cwd, '.gipity.json'))) {
        const existing = getConfig();
        console.log(`Already linked to ${info(`"${existing?.projectSlug ?? ''}"`)} ${muted(`(${existing?.projectGuid ?? ''})`)}`);
        // Re-run setup in case primers/hooks/skills are missing - each tool's
        // integration self-gates on its binary and current-version state.
        setupProjectTools(tools);
        // The config's ignore list was frozen at link time, so a workstation
        // artifact introduced by a newer CLI (e.g. aider's .aider.conf.yml)
        // would sync up as project content. Union in the current defaults.
        if (existing) {
          let changed = false;
          const cur = existing.ignore ?? (existing.ignore = []);
          const missing = DEFAULT_SYNC_IGNORE.filter(e => !cur.includes(e));
          if (missing.length) {
            cur.push(...missing);
            changed = true;
          }
          // `--no-capture` on a re-init is the documented way to opt an
          // existing project out of session recording. One-way from flags:
          // a bare re-run never silently reverses an explicit opt-out
          // (delete the key or set it true in .gipity.json to re-enable).
          if (opts.capture === false && existing.captureHooks !== false) {
            existing.captureHooks = false;
            changed = true;
          }
          // An explicit --for re-pins the project. Without persisting it,
          // `gipity build` (which calls setupProjectTools() with no arguments)
          // would re-add every tool's primer on its next run.
          const pinned = pinnedToolKeys(opts.for, tools);
          if (pinned && JSON.stringify(existing.tools ?? null) !== JSON.stringify(pinned)) {
            existing.tools = pinned;
            changed = true;
          }
          if (changed) saveConfigAt(cwd, existing);
        }
        console.log(success(`Refreshed primer files: ${primerSummary}.`));
        if (skippedNote) console.log(skippedNote);
        if (opts.capture === false) {
          console.log(success('Session recording disabled for this project (captureHooks: false in .gipity.json).'));
        }
        return;
      }

      // Refuse $HOME / system roots - adopting one as a project root would
      // make sync walk the whole machine.
      if (!canAdoptCwd(cwd)) {
        console.error(clrError(`${formatCwdLabel(cwd)} can't be used as a Gipity project root.`));
        console.error(muted('Run `gipity init` from a dedicated project directory.'));
        process.exit(1);
      }

      // Heads-up if this would create a project nested inside an existing one.
      const ancestorConfigPath = getConfigPath();
      if (ancestorConfigPath) {
        console.log(muted(`Note: ${formatCwdLabel(dirname(ancestorConfigPath))} is already a Gipity project.`));
        const ok = await confirm(
          `Create a separate nested project at ${bold(formatCwdLabel(cwd))}?`,
          { default: 'no' },
        );
        if (!ok) { console.log(muted('Aborted.')); process.exit(1); }
      }

      // Resolve project name. Server caps name at 100 chars; clamp so a very
      // long dir name doesn't trip a "Too big" 400 (slugify clamps the slug).
      const projectName = (name || basename(cwd)).slice(0, 100);
      const projectSlug = slugify(projectName);

      if (!projectSlug) {
        console.error(clrError('Could not derive a valid project slug. Provide a name: gipity init my-app'));
        process.exit(1);
      }

      // Size-tier safety: refuse huge dirs, confirm moderate ones, silently
      // adopt easy ones. Same check as the `gipity claude` picker.
      const scan = scanForAdoption(process.cwd());
      if (scan.tier === 'refuse') {
        const sizeStr = scan.truncated ? `>${formatBytes(ADOPT_THRESHOLDS.REFUSE_BYTES)}` : formatBytes(scan.bytes);
        const fileStr = scan.truncated ? `>${ADOPT_THRESHOLDS.REFUSE_FILES}` : `${scan.files}`;
        console.error(clrError(`Directory has ${fileStr} files (${sizeStr}) - too large to adopt as a Gipity project.`));
        console.error(muted('Move into a subdirectory, or use `gipity build` and pick "Create new project".'));
        process.exit(1);
      }
      if (scan.tier === 'moderate') {
        const ok = await confirm(
          `About to adopt ${bold(String(scan.files))} files (${bold(formatBytes(scan.bytes))}) at ${bold(formatCwdLabel(process.cwd()))}. Continue?`,
          { default: 'yes' },
        );
        if (!ok) { console.log(muted('Aborted.')); process.exit(1); }
      }

      const accountSlug = await getAccountSlug();
      const adopted = await adoptCurrentDir({
        cwd: process.cwd(),
        projectName,
        projectSlug,
        accountSlug,
        confirmDeletions: true,
        agentOverride: opts.agent || undefined,
        tools,
      });

      if (adopted.isNew) {
        console.log(success(`Created project "${adopted.project.name}" (${adopted.project.slug})`));
      } else {
        console.log(`Found existing project ${info(`"${adopted.project.name}"`)} ${muted(`(${adopted.project.slug})`)}`);
      }
      if (adopted.applied > 0) console.log(`Synced ${adopted.applied} change${adopted.applied > 1 ? 's' : ''} with Gipity.`);

      // Session recording opt-out. Written after adopt so it lands in the
      // freshly created .gipity.json regardless of how the link happened.
      const pinnedFresh = pinnedToolKeys(opts.for, tools);
      if (opts.capture === false || pinnedFresh) {
        try {
          const cfg = JSON.parse(readFileSync(resolve(cwd, '.gipity.json'), 'utf-8'));
          if (opts.capture === false) cfg.captureHooks = false;
          if (pinnedFresh) cfg.tools = pinnedFresh;
          saveConfigAt(cwd, cfg);
        } catch { /* config missing/unreadable - nothing to record */ }
      }

      console.log(success(`Wrote primer files: ${primerSummary}.`));
      if (skippedNote) console.log(skippedNote);
      if (wantsClaude) {
        console.log(success(`Ready! Run your coding agent here (${AGENT_ADAPTERS.map(a => a.key).join(', ')}), or \`gipity build\` to launch one with a picker.`));
        // Recording happens by default (however Claude Code is launched), so
        // say so up front - consent should be explicit, not discovered later.
        if (opts.capture === false) {
          console.log(muted('Session recording is off for this project (captureHooks: false in .gipity.json).'));
        } else {
          console.log(muted('Claude Code sessions here are recorded to your Gipity project (view at prompt.gipity.ai). Opt out: gipity init --no-capture.'));
        }
      } else {
        console.log(success('Ready! Open this directory in your AI coding tool.'));
      }
    } catch (err: any) {
      // `fetch failed` is Node's TypeError when DNS/connect fails. Translate
      // it to something an agent can act on instead of a cryptic stack line.
      const msg = err?.message ?? String(err);
      if (msg === 'fetch failed' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(msg)) {
        console.error(clrError('Init failed: could not reach Gipity servers.'));
        console.error(muted('Check your network connection and try again. Sandboxed environments often have no outbound network - run this on a machine with internet access.'));
      } else {
        console.error(clrError(`Init failed: ${msg}`));
      }
      process.exit(1);
    }
  });
