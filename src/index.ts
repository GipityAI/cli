#!/usr/bin/env node
import { Command, Help } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { setApiBaseOverride } from './config.js';
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
import { apiCommand } from './commands/api.js';
import { projectCommand } from './commands/project.js';
import { agentCommand } from './commands/agent.js';
import { workflowCommand } from './commands/workflow.js';
import { creditsCommand } from './commands/credits.js';
import { fileCommand } from './commands/file.js';
import { startCcCommand } from './commands/start-cc.js';
import { scaffoldCommand } from './commands/scaffold.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { logsCommand } from './commands/logs.js';
import { browserCommand } from './commands/browser.js';
import { recordsCommand } from './commands/records.js';
import { fnCommand } from './commands/fn.js';
import { rbacCommand } from './commands/rbac.js';
import { auditCommand } from './commands/audit.js';
import { emailCommand } from './commands/email.js';
import { generateCommand } from './commands/generate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// ── ANSI helpers ────────────────────────────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

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
  .description(`${bold('Gipity CLI')} ${dim('—')} cloud infrastructure for every project\n\n  ${dim('Hosting, databases, deployment, sandboxed execution, and AI — zero setup.')}`)
  .version(pkg.version, '-v, --version')
  .option('--api-base <url>', 'API base URL (e.g. http://localhost:7200)');

program.hook('preAction', () => {
  const apiBase = program.opts().apiBase;
  if (apiBase) setApiBaseOverride(apiBase);
});

configureHelp(program);

// ── Setup commands ──────────────────────────────────────────────────────
const setupGroup = [loginCommand, logoutCommand, initCommand, startCcCommand];
// ── Project commands ────────────────────────────────────────────────────
const projectGroup = [statusCommand, syncCommand, pushCommand, deployCommand, scaffoldCommand, checkpointCommand];
// ── Resource commands ───────────────────────────────────────────────────
const resourceGroup = [dbCommand, memoryCommand, fileCommand, sandboxCommand, apiCommand, logsCommand, browserCommand, recordsCommand, fnCommand, rbacCommand, auditCommand, emailCommand, generateCommand];
// ── Agent commands ──────────────────────────────────────────────────────
const agentGroup = [chatCommand, projectCommand, agentCommand, workflowCommand, creditsCommand];

for (const cmd of [...setupGroup, ...projectGroup, ...resourceGroup, ...agentGroup]) {
  configureHelp(cmd);
  program.addCommand(cmd);
}

program.parse();
