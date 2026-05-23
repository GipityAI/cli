import { Command } from 'commander';
import { basename, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { getAccountSlug } from '../api.js';
import { getConfig, getConfigPath } from '../config.js';
import { getAuth } from '../auth.js';
import { slugify, setupClaudeHooks, setupGitignore, SUPPORTED_TOOLS } from '../setup.js';
import { success, error as clrError, info, muted, bold } from '../colors.js';
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

function resolveTools(forFlag: string | undefined): typeof SUPPORTED_TOOLS {
  if (!forFlag || forFlag === 'all') return SUPPORTED_TOOLS;
  const requested = forFlag.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const unknown = requested.filter(k => !TOOL_KEYS.includes(k) && k !== 'all');
  if (unknown.length) {
    throw new Error(`Unknown --for value(s): ${unknown.join(', ')}. Valid: ${TOOL_KEYS.join(', ')}, all`);
  }
  if (requested.includes('all')) return SUPPORTED_TOOLS;
  return SUPPORTED_TOOLS.filter(t => requested.includes(t.key));
}

export const initCommand = new Command('init')
  .description('Link this directory to a Gipity project (writes primer files so your AI coding tool understands Gipity)')
  .argument('[name]', 'Project name/slug (defaults to current directory name)')
  .option('--agent <guid>', 'Agent GUID to use')
  .option(
    '--for <tools>',
    `Which AI tool primer files to write (comma-separated). Default: all. Choices: ${TOOL_KEYS.join(', ')}, all`,
  )
  .addHelpText('after', `
Examples:
  $ gipity init                          Link cwd as a new project (slug = dir name).
  $ gipity init my-app                   Link cwd with an explicit slug.
  $ gipity init --for codex              Write only AGENTS.md (skip Claude/Cursor/etc).
  $ gipity init --for cursor,gemini      Write only the Cursor + Gemini primers.

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
    let tools: typeof SUPPORTED_TOOLS;
    try {
      tools = resolveTools(opts.for);
    } catch (e: any) {
      console.error(clrError(e.message));
      process.exit(1);
    }
    const wantsClaude = tools.some(t => t.key === 'claude');
    const writeAllPrimers = (): void => {
      for (const t of tools) t.setup();
    };
    const primerSummary = tools.map(t => t.label).join(', ');

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
        // Re-run setup in case hooks/skills are missing. Claude Code hooks
        // only matter when the Claude primer is being written.
        if (wantsClaude) setupClaudeHooks();
        writeAllPrimers();
        setupGitignore();
        console.log(success(`Refreshed primer files: ${primerSummary}.`));
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

      // Resolve project name
      const projectName = name || basename(cwd);
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
        console.error(muted('Move into a subdirectory, or use `gipity claude` and pick "Create new project".'));
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

      console.log(success(`Wrote primer files: ${primerSummary}.`));
      if (wantsClaude) {
        console.log(success('Ready! Run `gipity claude` for Claude Code, or open this directory in your other AI coding tool.'));
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
