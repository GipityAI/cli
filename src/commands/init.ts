import { Command } from 'commander';
import { basename } from 'path';
import { getAccountSlug } from '../api.js';
import { getConfig } from '../config.js';
import { getAuth } from '../auth.js';
import { slugify, setupClaudeHooks, setupClaudeMd, setupAgentsMd, setupGitignore } from '../setup.js';
import { success, error as clrError, info, muted, bold } from '../colors.js';
import { confirm } from '../utils.js';
import {
  scanForAdoption,
  adoptCurrentDir,
  formatBytes,
  formatCwdLabel,
  ADOPT_THRESHOLDS,
} from '../adopt-cwd.js';

export const initCommand = new Command('init')
  .description('Set up a project')
  .argument('[name]', 'Project name/slug (defaults to current directory name)')
  .option('--agent <guid>', 'Agent GUID to use')
  .action(async (name: string | undefined, opts) => {
    try {
      // Check auth
      const auth = getAuth();
      if (!auth) {
        console.error(clrError('Not logged in. Run: gipity login'));
        process.exit(1);
      }

      // Check if already initialized
      const existing = getConfig();
      if (existing) {
        console.log(`Already linked to ${info(`"${existing.projectSlug}"`)} ${muted(`(${existing.projectGuid})`)}`);
        // Re-run setup in case hooks/skills are missing
        setupClaudeHooks();
        setupClaudeMd();
        setupAgentsMd();
        setupGitignore();
        console.log(success('Configuring Claude Code... done.'));
        return;
      }

      // Resolve project name
      const projectName = name || basename(process.cwd());
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
      });

      if (adopted.isNew) {
        console.log(success(`Created project "${adopted.project.name}" (${adopted.project.slug})`));
      } else {
        console.log(`Found existing project ${info(`"${adopted.project.name}"`)} ${muted(`(${adopted.project.slug})`)}`);
      }
      if (adopted.applied > 0) console.log(`Synced ${adopted.applied} change${adopted.applied > 1 ? 's' : ''} with Gipity.`);

      console.log(success('Configuring Claude Code... done.'));
      console.log(success('Ready! Run `claude` to start.'));
    } catch (err: any) {
      console.error(clrError(`Init failed: ${err.message}`));
      process.exit(1);
    }
  });
