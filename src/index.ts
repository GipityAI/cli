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
import { browserCommand } from './commands/browser.js';
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
import { HELP_SKILL_MAP, fetchAndPrintSkill } from './help-skills.js';
import { bold, dim, brand } from './colors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// ── Custom help formatting (match Claude Code style) ────────────────────
function configureHelp(cmd: Command): void {
  cmd.configureHelp({
    formatHelp(cmd, helper) {
      const defaultHelp = Help.prototype.formatHelp.call(this, cmd, helper);
      return '\n' + defaultHelp + '\n';
    },
  });
}

const program = new Command();

program
  .name('gipity')
  .description(`${brand(bold('Gipity CLI'))} ${dim('—')} AI Agent Super Computer\n\n  ${dim('App hosting, databases, deployment, sandboxed execution, and 90+ AI tools — zero setup.')}`)
  .version(pkg.version, '-v, --version')
  .option('--api-base <url>', 'API base URL (e.g. http://localhost:7200)')
  .option('-y, --yes', 'Skip confirmation prompts');

program.hook('preAction', () => {
  const globalOpts = program.opts();
  if (globalOpts.apiBase) setApiBaseOverride(globalOpts.apiBase);
  if (globalOpts.yes) setAutoConfirm(true);
});

configureHelp(program);

// ── Setup commands ──────────────────────────────────────────────────────
const setupGroup = [loginCommand, logoutCommand, initCommand, claudeCommand];
// ── Project commands ────────────────────────────────────────────────────
const projectGroup = [statusCommand, syncCommand, pushCommand, deployCommand, testCommand, scaffoldCommand, domainCommand];
// ── Resource commands ───────────────────────────────────────────────────
const resourceGroup = [dbCommand, memoryCommand, fileCommand, sandboxCommand, logsCommand, browserCommand, recordsCommand, fnCommand, rbacCommand, auditCommand, emailCommand, generateCommand, skillsCommand, locationCommand];
// ── Agent commands ──────────────────────────────────────────────────────
const agentGroup = [chatCommand, projectCommand, agentCommand, workflowCommand, creditsCommand];

for (const cmd of [...setupGroup, ...projectGroup, ...resourceGroup, ...agentGroup]) {
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

program.parse();
