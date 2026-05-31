#!/usr/bin/env node
import { Command, Help, Option } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { setApiBaseOverride } from './config.js';
import { setAutoConfirm } from './utils.js';
import { GIPITY_TAGLINE } from './knowledge.js';
import { getAuth, getTimeRemaining, isExpired } from './auth.js';
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
import { planCommand } from './commands/plan.js';
import { fileCommand } from './commands/file.js';
import { claudeCommand } from './commands/claude.js';
import { addCommand } from './commands/add.js';
import { logsCommand } from './commands/logs.js';
import { pageCommand } from './commands/page.js';
import { recordsCommand } from './commands/records.js';
import { fnCommand } from './commands/fn.js';
import { serviceCommand } from './commands/service.js';
import { jobCommand } from './commands/job.js';
import { rbacCommand } from './commands/rbac.js';
import { auditCommand } from './commands/audit.js';
import { emailCommand } from './commands/email.js';
import { generateCommand } from './commands/generate.js';
import { skillCommand } from './commands/skill.js';
import { domainCommand } from './commands/domain.js';
import { realtimeCommand } from './commands/realtime.js';
import { testCommand } from './commands/test.js';
import { locationCommand } from './commands/location.js';
import { doctorCommand } from './commands/doctor.js';
import { updateCommand } from './commands/update.js';
import { relayCommand } from './commands/relay.js';
import { uninstallCommand } from './commands/uninstall.js';
import { approvalCommand } from './commands/approval.js';
import { gmailCommand } from './commands/gmail.js';
import { textCommand } from './commands/text.js';
import { HELP_SKILL_MAP, fetchAndPrintSkill } from './help-skills.js';
import { bold, dim, brand, muted, success } from './colors.js';
import { normalizeAliases } from './flag-aliases.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// Custom -v/--version output: include auth status so agents know whether
// the next CLI call will succeed. Intercepted before Commander parses,
// because Commander's built-in `.version()` only prints a string and exits.
{
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '-v' || args[0] === '--version')) {
    // Three states, not two: a stale auth.json reads as "have an account"
    // but its tokens may be expired. Calling that "Logged in (expired)" is
    // self-contradictory and reads as a bug; surface expiry as its own line
    // that points at the same fix as the not-logged-in case.
    const auth = getAuth();
    let authLine: string;
    if (!auth) {
      authLine = `${muted('Not logged in.')} Run: ${brand('gipity login')}`;
    } else if (isExpired()) {
      authLine = `${muted('Session expired for')} ${auth.email}${muted('. Run:')} ${brand('gipity login')}`;
    } else {
      authLine = `${success('Logged in')} as ${auth.email} ${muted(`(${getTimeRemaining()})`)}`;
    }
    console.log('');
    console.log(`${brand(bold('Gipity'))} ${muted(`v${pkg.version}`)}`);
    console.log(authLine);
    console.log('');
    process.exit(0);
  }
}

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

// Global value-options (`--api-base <url>`) are only meaningful before the
// subcommand. Without this, commander interleaves program + subcommand option
// parsing and mis-reads a subcommand's `.requiredOption()` as missing when a
// global value-option precedes it (e.g. `gipity --api-base X workflow create
// --from Y`). enablePositionalOptions draws the boundary at the first command.
program.enablePositionalOptions();

// ── Command groups (logical ordering within each) ──────────────────────
const commonGroup      = [skillCommand, projectCommand, addCommand, deployCommand];
const connectGroup     = [claudeCommand, relayCommand];
const projectGroup     = [domainCommand, statusCommand, initCommand];
const filesGroup       = [fileCommand, syncCommand, pushCommand, uploadCommand];
const appBuildingGroup = [testCommand, fnCommand, serviceCommand, jobCommand, dbCommand, logsCommand, workflowCommand, realtimeCommand, rbacCommand, auditCommand, recordsCommand];
const utilitiesGroup   = [pageCommand, sandboxCommand, generateCommand, emailCommand, gmailCommand, locationCommand, textCommand];
const agentGroup       = [chatCommand, memoryCommand, agentCommand, approvalCommand];
const setupGroup       = [loginCommand, logoutCommand, creditsCommand, planCommand, doctorCommand, updateCommand, uninstallCommand];

const HELP_SECTIONS: Array<{ title: string; cmds: Command[] }> = [
  { title: 'Common',       cmds: commonGroup },
  { title: 'Connect',      cmds: connectGroup },
  { title: 'Project',      cmds: projectGroup },
  { title: 'Files',        cmds: filesGroup },
  { title: 'App building', cmds: appBuildingGroup },
  { title: 'Utilities',    cmds: utilitiesGroup },
  { title: 'Agent',        cmds: agentGroup },
  { title: 'Setup',        cmds: setupGroup },
];

program
  .name('gipity')
  .description(`${brand(bold('Gipity CLI'))} ${dim('-')} ${GIPITY_TAGLINE.replace(/\.$/, '')}\n\n  ${dim('Hosting, databases, deploys, workflows, code execution, and monitoring - one place, agent-tuned. Pair with Claude Code or use standalone.')}`)
  .version(pkg.version, '-v, --version')
  .addOption(new Option('--api-base <url>', 'API base URL').hideHelp())
  .option('-y, --yes', 'Skip confirmation prompts');

program.hook('preAction', () => {
  const globalOpts = program.opts();
  if (globalOpts.apiBase) setApiBaseOverride(globalOpts.apiBase);
  if (globalOpts.yes) setAutoConfirm(true);
});

// ── Custom top-level help: version banner + grouped commands ────────────
program.configureHelp({
  formatHelp(cmd, helper) {
    const cmdColWidth = Math.max(
      ...HELP_SECTIONS.flatMap(s => s.cmds.map(c => c.name().length)),
    );
    const padCmd = (s: string) => s.padEnd(cmdColWidth);
    const opts = helper.visibleOptions(cmd);
    const optColWidth = opts.length ? Math.max(...opts.map(o => helper.optionTerm(o).length)) : 0;
    const padOpt = (s: string) => s.padEnd(optColWidth);
    const lines: string[] = [];

    lines.push('');
    lines.push(`${brand(bold('Gipity CLI'))} ${muted(`v${pkg.version}`)}`);
    lines.push(dim(GIPITY_TAGLINE));
    lines.push(dim('Hosting, databases, deploys, workflows - one place. Pair with Claude Code or use standalone.'));
    lines.push(dim('Works with Claude Code, Codex, Aider, or any AI coding tool - no MCP server needed.'));
    lines.push('');

    lines.push(bold('Quick start:'));
    lines.push(`  ${brand('gipity login')}    ${dim('- authenticate first if you haven\'t already')}`);
    lines.push(`  ${brand('gipity init')}     ${dim('- link this dir + write CLAUDE.md/AGENTS.md primers for your AI tool')}`);
    lines.push(`  ${brand('gipity claude')}   ${dim('- or launch Claude Code with Gipity tools wired in')}`);
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

// ── Malformed invocation → print the error AND the command's help inline ──
// When an agent guesses the wrong shape (excess args, unknown command/option,
// missing arg), don't make it run `--help` as a second trip: Commander fires
// error() on the offending (sub)command, so showHelpAfterError(true) appends
// that exact command's help, and a labeled header names the canonical help
// invocation. addCommand doesn't inherit these settings, so apply recursively.
function fullCommandName(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}
function enableHelpAfterError(cmd: Command): void {
  cmd.showHelpAfterError(true);
  cmd.configureOutput({
    outputError: (str, write) =>
      write(`${str.replace(/\n+$/, '')}\n\nShowing \`${fullCommandName(cmd)} --help\`:\n`),
  });
  for (const sub of cmd.commands) enableHelpAfterError(sub);
}
enableHelpAfterError(program);

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

program.parse(normalizeAliases(process.argv, program));
