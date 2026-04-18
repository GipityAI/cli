#!/usr/bin/env node
import { Command, Help } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { setApiBaseOverride } from './config.js';
import { setAutoConfirm } from './utils.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { syncCommand } from './commands/sync.js';
import { pushCommand } from './commands/push.js';
import { uploadCommand } from './commands/upload.js';
import { deployCommand } from './commands/deploy.js';
import { dbCommand } from './commands/db.js';
import { memoryCommand } from './commands/memory.js';
import { sandboxCommand } from './commands/sandbox.js';
import { chatCommand } from './commands/chat.js';
import { projectCommand } from './commands/project.js';
import { agentCommand } from './commands/agent.js';
import { workflowCommand } from './commands/workflow.js';
import { creditsCommand } from './commands/credits.js';
import { fileCommand } from './commands/file.js';
import { claudeCommand } from './commands/claude.js';
import { scaffoldCommand } from './commands/scaffold.js';
import { logsCommand } from './commands/logs.js';
import { pageInspectCommand } from './commands/page-inspect.js';
import { recordsCommand } from './commands/records.js';
import { fnCommand } from './commands/fn.js';
import { rbacCommand } from './commands/rbac.js';
import { auditCommand } from './commands/audit.js';
import { emailCommand } from './commands/email.js';
import { generateCommand } from './commands/generate.js';
import { skillsCommand } from './commands/skills.js';
import { domainCommand } from './commands/domain.js';
import { testCommand } from './commands/test.js';
import { locationCommand } from './commands/location.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand } from './commands/update.js';
import { relayCommand } from './commands/relay.js';
import { uninstallCommand } from './commands/uninstall.js';
import { HELP_SKILL_MAP, fetchAndPrintSkill } from './help-skills.js';
import { bold, dim, brand, muted } from './colors.js';
import { normalizeAliases } from './flag-aliases.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// ── Custom help formatting (subcommand pages keep default look) ─────────
function configureHelp(cmd: Command): void {
  cmd.configureHelp({
    formatHelp(cmd, helper) {
      const defaultHelp = Help.prototype.formatHelp.call(this, cmd, helper);
      return '\n' + defaultHelp + '\n';
    },
  });
}

const program = new Command();

// ── Command groups (logical ordering within each) ──────────────────────
// Order within each group is intentional: Setup follows the user's first-run
// path; Project follows the dev loop; Resources groups data → compute →
// observability → access; Agent flows chat → run → manage → bill.
const setupGroup     = [loginCommand, logoutCommand, initCommand, claudeCommand, relayCommand];
const projectGroup   = [statusCommand, syncCommand, pushCommand, uploadCommand, deployCommand, testCommand, scaffoldCommand, domainCommand];
const resourceGroup  = [dbCommand, memoryCommand, fileCommand, fnCommand, sandboxCommand, pageInspectCommand, generateCommand, logsCommand, recordsCommand, auditCommand, rbacCommand, emailCommand, skillsCommand, locationCommand];
const agentGroup     = [chatCommand, agentCommand, projectCommand, workflowCommand, creditsCommand];
const maintenanceGroup = [doctorCommand, updateCommand, uninstallCommand];

const HELP_SECTIONS: Array<{ title: string; cmds: Command[] }> = [
  { title: 'Setup',       cmds: setupGroup },
  { title: 'Project',     cmds: projectGroup },
  { title: 'Resources',   cmds: resourceGroup },
  { title: 'Agent',       cmds: agentGroup },
  { title: 'Maintenance', cmds: maintenanceGroup },
];

program
  .name('gipity')
  .description(`${brand(bold('Gipity CLI'))} ${dim('—')} Cloud agents for builders\n\n  ${dim('90+ tools, persistent memory, app hosting, databases, deploys. Pair with Claude Code or use standalone.')}`)
  .version(pkg.version, '-v, --version')
  .option('--api-base <url>', 'API base URL (e.g. http://localhost:7200)')
  .option('-y, --yes', 'Skip confirmation prompts');

program.hook('preAction', () => {
  const globalOpts = program.opts();
  if (globalOpts.apiBase) setApiBaseOverride(globalOpts.apiBase);
  if (globalOpts.yes) setAutoConfirm(true);
});

// ── Custom top-level help: version banner + grouped commands ────────────
program.configureHelp({
  formatHelp(cmd, helper) {
    // Command column: tight to the longest command name (don't let long
    // option terms like `--api-base <url>` blow out the gutter).
    const cmdColWidth = Math.max(
      ...HELP_SECTIONS.flatMap(s => s.cmds.map(c => c.name().length)),
    );
    const padCmd = (s: string) => s.padEnd(cmdColWidth);
    // Options get their own narrower column based on their own widths.
    const opts = helper.visibleOptions(cmd);
    const optColWidth = opts.length ? Math.max(...opts.map(o => helper.optionTerm(o).length)) : 0;
    const padOpt = (s: string) => s.padEnd(optColWidth);
    const lines: string[] = [];

    lines.push('');
    lines.push(`${brand(bold('Gipity CLI'))} ${muted(`v${pkg.version}`)}`);
    lines.push(dim('Cloud agents for builders — 90+ tools, persistent memory, app hosting,'));
    lines.push(dim('databases, deploys. Pair with Claude Code or use standalone.'));
    lines.push('');

    lines.push(bold('Quick start:'));
    lines.push(`  ${brand('gipity claude')}   ${dim('— launch Claude Code with Gipity tools wired in')}`);
    lines.push(`  ${brand('gipity login')}    ${dim('— authenticate first if you haven\'t already')}`);
    lines.push('');

    lines.push(bold('Usage:'));
    lines.push(`  ${cmd.name()} [options] [command]`);
    lines.push('');

    if (opts.length) {
      lines.push(bold('Options:'));
      for (const o of opts) {
        lines.push(`  ${padOpt(helper.optionTerm(o))}  ${helper.optionDescription(o)}`);
      }
      lines.push('');
    }

    for (const section of HELP_SECTIONS) {
      lines.push(bold(`${section.title}:`));
      for (const c of section.cmds) {
        const term = c.name();
        const desc = c.description();
        lines.push(`  ${padCmd(term)}  ${desc}`);
      }
      lines.push('');
    }

    lines.push(dim(`Run "${cmd.name()} <command> --help" for details on a specific command.`));
    lines.push('');
    return lines.join('\n');
  },
});

for (const cmd of HELP_SECTIONS.flatMap(s => s.cmds)) {
  configureHelp(cmd);
  program.addCommand(cmd);
}

// Auto-fetch related skill docs when --help is run on mapped commands
const argv = process.argv.slice(2);
const hasHelp = argv.includes('--help') || argv.includes('-h');
const mappedCmd = hasHelp ? argv.find(a => a in HELP_SKILL_MAP) : undefined;

if (mappedCmd) {
  const cmdObj = program.commands.find(c => c.name() === mappedCmd);
  if (cmdObj) {
    cmdObj.outputHelp();
    await fetchAndPrintSkill(HELP_SKILL_MAP[mappedCmd]);
    process.exit(0);
  }
}

program.parse(normalizeAliases(process.argv));
