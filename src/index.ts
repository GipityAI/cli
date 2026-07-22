#!/usr/bin/env node
import { Command, Help, Option } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { setApiBaseOverride } from './config.js';
import { setAutoConfirm } from './utils.js';
import { installOutputFrame } from './helpers/output.js';
import { GIPITY_TAGLINE } from './knowledge.js';
import { getAuth, sessionExpired } from './auth.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { tokenCommand } from './commands/token.js';
import { keyCommand } from './commands/key.js';
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
import { storageCommand } from './commands/storage.js';
import { buildCommand, claudeCommand } from './commands/build.js';
import { addCommand } from './commands/add.js';
import { removeCommand } from './commands/remove.js';
import { saveCommand } from './commands/save.js';
import { loadCommand } from './commands/load.js';
import { logsCommand } from './commands/logs.js';
import { pageCommand } from './commands/page.js';
import { recordsCommand } from './commands/records.js';
import { fnCommand } from './commands/fn.js';
import { serviceCommand } from './commands/service.js';
import { secretsCommand } from './commands/secrets.js';
import { notifyCommand } from './commands/notify.js';
import { bugCommand } from './commands/bug.js';
import { paymentsCommand } from './commands/payments.js';
import { githubCommand } from './commands/github.js';
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
import { connectCommand } from './commands/setup.js';
import { uninstallCommand } from './commands/uninstall.js';
import { approvalCommand } from './commands/approval.js';
import { gmailCommand } from './commands/gmail.js';
import { textCommand } from './commands/text.js';
import { HELP_SKILL_MAP, fetchAndPrintSkill } from './help-skills.js';
import { bold, dim, brand, muted, success } from './colors.js';
import { normalizeAliases } from './flag-aliases.js';
import { installOutputTrace } from './trace.js';

// With GIPITY_TRACE_OUTPUT=1, tee all stdout/stderr to ~/.gipity/trace/
// (silent-success diagnosis, cli#125/#126/#108). No-op when the shim already
// installed the tee in this process - this covers gipcc/gipccd/direct runs.
installOutputTrace('index');

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// Local builds stamp dist/build-info.json (git SHA + dirty flag) via the npm
// `postbuild` hook, so `-v` can show whether the linked binary is your latest
// code. It is intentionally absent from published installs: the npm `files`
// allowlist ships only dist/**/*.js, so a released CLI prints a clean
// `v1.0.398` with no dev marker. package.json `version` stays the source of
// truth for the published release; this marker never touches it.
function versionLabel(): string {
  const base = `v${pkg.version}`;
  try {
    const info = JSON.parse(readFileSync(resolve(__dirname, 'build-info.json'), 'utf-8'));
    if (info?.sha) return `${base} (dev ${info.sha}${info.dirty ? ', modified' : ''})`;
  } catch {
    // No build-info.json (published install or pre-build) → clean version.
  }
  return base;
}

// Custom -v/--version output: include auth status so agents know whether
// the next CLI call will succeed. Intercepted before Commander parses,
// because Commander's built-in `.version()` only prints a string and exits.
{
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '-v' || args[0] === '--version')) {
    // Three states, not two: a stale auth.json reads as "have an account"
    // but its session may be dead. "Expired" here means the refresh token
    // is gone (sessionExpired) - access-token expiry self-heals on the next
    // API call, so showing it would be a false alarm.
    const auth = getAuth();
    let authLine: string;
    if (!auth) {
      authLine = `${muted('Not logged in.')} Run: ${brand('gipity login')}`;
    } else if (sessionExpired()) {
      authLine = `${muted('Session expired for')} ${auth.email}${muted('. Run:')} ${brand('gipity login')}`;
    } else {
      authLine = `${success('Logged in')} as ${auth.email}`;
    }
    console.log('');
    console.log(`${brand(bold('Gipity'))} ${muted(versionLabel())}`);
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

// ── Command groups (lifecycle order; logical ordering within each) ─────
// Section names deliberately match the vocabulary of the generated CLAUDE.md
// primer and the skill docs ("build loop: add → edit → deploy → page
// inspect"), so an agent's first `--help` reads in the same terms as the rest
// of its context. Humans get the same win: sections follow the order you
// actually use them - orient, build, wire the backend, then everything else.
const startGroup     = [statusCommand, initCommand, skillCommand, projectCommand];
const buildGroup     = [addCommand, removeCommand, saveCommand, loadCommand, deployCommand, pageCommand, testCommand];
const backendGroup   = [dbCommand, fnCommand, secretsCommand, keyCommand, logsCommand, jobCommand, workflowCommand];
const servicesGroup  = [serviceCommand, generateCommand, notifyCommand, paymentsCommand, realtimeCommand, recordsCommand, rbacCommand, auditCommand, domainCommand, tokenCommand];
const filesGroup     = [syncCommand, fileCommand, pushCommand, uploadCommand, storageCommand];
const gipGroup       = [chatCommand, memoryCommand, agentCommand, approvalCommand, gmailCommand];
const utilitiesGroup = [sandboxCommand, emailCommand, locationCommand, textCommand, bugCommand];
const connectGroup   = [loginCommand, logoutCommand, buildCommand, connectCommand, relayCommand, githubCommand, creditsCommand, doctorCommand, updateCommand, uninstallCommand];

const HELP_SECTIONS: Array<{ title: string; cmds: Command[] }> = [
  { title: 'Start here',        cmds: startGroup },
  { title: 'App build & ship',  cmds: buildGroup },
  { title: 'App backend',       cmds: backendGroup },
  { title: 'App services',      cmds: servicesGroup },
  { title: 'Files',             cmds: filesGroup },
  { title: 'Gip (cloud agent)', cmds: gipGroup },
  { title: 'Utilities',         cmds: utilitiesGroup },
  { title: 'Connect & setup',   cmds: connectGroup },
];

// Per-command deep-docs cross-links, rendered as a "Docs:" epilog on each
// command's --help AND carried in the `help --json` manifest. This is the
// bridge agents actually need - from "found the command" to "know the API
// pattern" - without duplicating skill content in help text (skills stay the
// single source of truth; this maps names only). Keys must be real skill
// names (`gipity skill list`).
const SKILL_DOCS: Record<string, string> = {
  save: 'app-import',
  load: 'app-import',
  github: 'app-import',
  deploy: 'deploy',
  page: 'app-debugging',
  test: 'app-testing',
  db: 'app-database',
  fn: 'app-development',
  service: 'service-call',
  notify: 'app-notify',
  payments: 'app-payments',
  records: 'app-records',
  key: 'app-auth',
  realtime: 'app-realtime',
  job: 'jobs',
  sandbox: 'sandbox-tools',
  gmail: 'google-services',
  email: 'email',
  location: 'location',
};

program
  .name('gipity')
  .description(`${brand(bold('Gipity CLI'))} ${dim('-')} ${GIPITY_TAGLINE.replace(/\.$/, '')}\n\n  ${dim('Hosting, databases, deploys, workflows, code execution, and monitoring - one place, agent-tuned. Pair with Claude Code or use standalone.')}`)
  .version(pkg.version, '-v, --version')
  .addOption(new Option('--api-base <url>', 'API base URL').hideHelp())
  .option('-y, --yes', 'Skip confirmation prompts');

program.hook('preAction', (_thisCommand, actionCommand) => {
  const globalOpts = program.opts();
  if (globalOpts.apiBase) setApiBaseOverride(globalOpts.apiBase);
  // Honor `-y`/`--yes` whether it came before the subcommand (the global flag)
  // or after it (the per-command flag registered by enableYesEverywhere below),
  // so both `gipity -y records delete ...` and `gipity records delete ... --yes`
  // skip confirmation identically.
  if (globalOpts.yes || actionCommand.opts().yes) setAutoConfirm(true);
});

// Bracket non-JSON command output with leading/trailing blank lines centrally,
// so commands never hand-roll their own boundary spacing.
installOutputFrame(program);

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
    lines.push(`${brand(bold('Gipity CLI'))} ${muted(versionLabel())}`);
    lines.push(dim(GIPITY_TAGLINE));
    lines.push(dim('Hosting, databases, deploys, workflows - one place. Pair with Claude Code or use standalone.'));
    lines.push(dim('Works with Claude Code, Codex, Aider, or any AI coding tool - no MCP server needed.'));
    lines.push('');

    lines.push(bold('Quick start:'));
    lines.push(`  ${brand('gipity login')}    ${dim('- authenticate first if you haven\'t already')}`);
    lines.push(`  ${brand('gipity init')}     ${dim('- link this dir + wire up every coding agent on this machine')}`);
    lines.push(`  ${brand('gipity connect')}  ${dim('- connect this computer to gipity.ai so the web CLI can drive it')}`);
    lines.push(`  ${brand('gipity build')}    ${dim('- or start from anywhere: pick a project, pick your agent, go')}`);
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
    lines.push(dim(`Deep docs: "${cmd.name()} skill list". Machine-readable manifest: "${cmd.name()} help --json".`));
    lines.push('');
    return lines.join('\n');
  },
});

for (const cmd of HELP_SECTIONS.flatMap(s => s.cmds)) {
  configureHelp(cmd);
  // "Docs:" epilog bridging this command's --help to its skill doc.
  const skill = SKILL_DOCS[cmd.name()];
  if (skill) cmd.addHelpText('after', `Docs: gipity skill read ${skill}\n`);
  program.addCommand(cmd);
}

// Hidden legacy launcher: `gipity claude` predates `gipity build` and stays
// working forever (deployed relay daemons and the GUI installer invoke it)
// but is no longer advertised - not in help, not in the manifest, not in docs.
configureHelp(claudeCommand);
program.addCommand(claudeCommand, { hidden: true });

// ── `gipity help [command]` + `help --json` machine-readable manifest ───
// The JSON manifest is generated from the SAME commander registry that
// renders human help, so it cannot drift: name, args, options, subcommands,
// group, and the skill cross-link per command. Meant for agents and tooling
// that want the full surface in one parseable shot instead of N --help calls.
program.helpCommand(false); // replace the builtin so we can add --json
interface ManifestOption { flags: string; description: string }
interface ManifestCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  args: Array<{ name: string; required: boolean; description: string }>;
  options: ManifestOption[];
  subcommands: ManifestCommand[];
  skill: string | null;
}
function manifestCommand(c: Command): ManifestCommand {
  return {
    name: c.name(),
    aliases: c.aliases().slice(),
    description: c.description(),
    usage: `gipity ${fullCommandPath(c)} ${c.usage()}`.trim(),
    args: c.registeredArguments.map(a => ({
      name: a.name(),
      required: a.required,
      description: a.description || '',
    })),
    options: c.options.filter(o => !o.hidden).map(o => ({ flags: o.flags, description: o.description })),
    subcommands: c.commands.filter(sc => !(sc as Command & { _hidden?: boolean })._hidden).map(manifestCommand),
    skill: SKILL_DOCS[c.name()] ?? null,
  };
}
function fullCommandPath(c: Command): string {
  const parts: string[] = [];
  for (let cur: Command | null = c; cur && cur.parent; cur = cur.parent) parts.unshift(cur.name());
  return parts.join(' ');
}
program.addCommand(
  new Command('help')
    .description('Show help; --json emits the full command manifest for agents/tools')
    .argument('[command]', 'Show help for this command')
    .option('--json', 'Output every command (args, options, subcommands, docs links) as JSON')
    .action((name: string | undefined, opts: { json?: boolean }) => {
      if (opts.json) {
        const manifest = {
          name: 'gipity',
          version: pkg.version,
          docs: 'Run `gipity skill list` for deep task docs; each command may carry a `skill` cross-link.',
          sections: HELP_SECTIONS.map(s => ({
            title: s.title,
            commands: s.cmds.map(manifestCommand),
          })),
        };
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      if (name) {
        const target = program.commands.find(c => c.name() === name || c.aliases().includes(name));
        if (target) target.help();
      }
      program.help();
    }),
);

// ── Malformed invocation → print the command's help inline, error FIRST and LAST ──
// When an agent guesses the wrong shape (excess args, unknown command/option,
// missing arg), don't make it run `--help` as a second trip: render that exact
// command's help inline. The one-line error is printed TWICE, bracketing the
// help. Agents bound context by piping CLI output through `| tail` OR `| head`,
// and either one alone silently eats a single copy of the error: a `head -20`
// over the 90-odd lines of root help shows the banner and nothing else, reading
// as success-with-no-result. Bracketing means whichever end survives truncation
// still carries the failure, while the help in between keeps doing its job (a
// guessed `gipity browser` still surfaces the real `page` from the catalog).
// addCommand doesn't inherit this, so apply recursively. (We render help
// ourselves rather than via showHelpAfterError so we control where the error
// lands.)
function fullCommandName(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}
// Resolve the deepest (sub)command the user actually targeted by walking the
// command tree against the leading positional tokens of argv (skipping flags,
// and a root value-option's value). Used at error time to render the RIGHT
// command's help — see enableHelpAfterError below for why we can't just capture
// the command in a closure.
function resolveTargetCommand(argv: string[]): Command {
  const args = argv.slice(2);
  const rootValueFlags = new Set(
    program.options.filter(o => o.long && o.required).map(o => o.long as string),
  );
  let cmd: Command = program;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('-')) {
      if (!tok.includes('=') && rootValueFlags.has(tok)) i++; // consume its value
      continue;
    }
    const next = cmd.commands.find(c => c.name() === tok || c.aliases().includes(tok));
    if (!next) break; // first non-subcommand operand ends the command chain
    cmd = next;
  }
  return cmd;
}
// ── Excess positional → name it, and map `key=value` back to `--key` ──
// Commander's stock excess-arguments error is just a count ("Expected 1 argument
// but got 2"), which leaves an agent to guess WHICH token was wrong. A very
// common miss is carrying an option over as a positional in `key=value` shape -
// `gipity add 3d-engine title="Blocks"` - where the fix is `--title`. Override
// the message once (the method lives on the shared prototype, so this covers
// every command) to name the offending token(s) and, when one is key=value
// shaped, point straight at the flag they meant. Bracketing/help still work:
// this only changes the string handed to outputError below.
(Command.prototype as unknown as { _excessArguments(a: string[]): void })._excessArguments =
  function (this: Command, receivedArgs: string[]): void {
    if ((this as unknown as { _allowExcessArguments: boolean })._allowExcessArguments) return;
    const expected = (this as unknown as { registeredArguments: unknown[] }).registeredArguments.length;
    const excess = receivedArgs.slice(expected);
    const forSubcommand = this.parent ? ` for '${this.name()}'` : '';
    const list = excess.map(a => `'${a}'`).join(', ');
    let message = `error: unexpected extra argument${excess.length === 1 ? '' : 's'} ${list}${forSubcommand}.`;
    const kv = excess.map(a => /^([A-Za-z][\w-]*)=/.exec(a)).find(Boolean);
    if (kv) {
      message += ` Options are passed as \`--${kv[1]} <value>\`, not \`${kv[1]}=...\` - did you mean \`--${kv[1]}\`?`;
    }
    (this as unknown as { error(m: string, o: { code: string }): void })
      .error(message, { code: 'commander.excessArguments' });
  };

function enableHelpAfterError(cmd: Command): void {
  cmd.configureOutput({
    // Render the offending command's full help (via outputHelp, so addHelpText
    // blocks are included) FIRST, then the one-line error LAST. Both go to the
    // same writeErr stream synchronously, so the order holds. We do NOT call
    // showHelpAfterError - that would render help a second time, before the error.
    //
    // We must resolve the target command from argv rather than capturing `cmd`
    // here: commander shares ONE _outputConfiguration object across a command
    // and all its subcommands (copyInheritedSettings copies it by reference, and
    // configureOutput mutates it in place). So every subcommand's closure would
    // clobber its siblings', leaving only the last-registered subcommand's — and
    // an unknown option on `fn call` would print `fn delete`'s help. Installing
    // one identical, self-resolving handler everywhere sidesteps the clobber.
    outputError: (str, write) => {
      const target = resolveTargetCommand(process.argv);
      const msg = str.replace(/\n+$/, '');
      write(`${msg}\n\n`);
      write(`Showing \`${fullCommandName(target)} --help\`:\n\n`);
      target.outputHelp({ error: true });
      write(`\n${msg}\n`);
    },
  });
  for (const sub of cmd.commands) enableHelpAfterError(sub);
}
enableHelpAfterError(program);

// ── `-y`/`--yes` accepted AFTER any subcommand, not only before it ──────
// The global `-y` lives on `program`, so Commander parses it only when it
// precedes the subcommand (`gipity -y records delete ...`). Agents and humans
// instinctively append it instead (`gipity records delete ... --yes`), which
// Commander would reject as an unknown option and dump help for. Register the
// flag on every leaf command so both positions work identically; the preAction
// hook honors whichever one was set. Skip commands that already declare their
// own `--yes` (e.g. `fn delete`, `db drop`, `remove`) to avoid a duplicate.
function enableYesEverywhere(cmd: Command): void {
  if (cmd.commands.length > 0) {
    for (const sub of cmd.commands) enableYesEverywhere(sub);
    return;
  }
  const hasYes = cmd.options.some(o => o.long === '--yes' || o.short === '-y');
  if (!hasYes) cmd.addOption(new Option('-y, --yes', 'Skip confirmation prompts').hideHelp());
}
enableYesEverywhere(program);

// Auto-fetch related skill docs when --help is run on a doc-bearing TOP-LEVEL
// command (e.g. `gipity fn --help`, `gipity db --help`). It must NOT fire for a
// subcommand's help: `gipity db query --help` should render commander's own
// usage for `db query`, not the parent's help plus a skill doc. So only trigger
// when the first token is a mapped command and nothing after it is a subcommand
// (every remaining token is a flag).
const argv = process.argv.slice(2);
const hasHelp = argv.includes('--help') || argv.includes('-h');
const topCmd = argv[0];
const targetsTopCmdOnly = argv.slice(1).every(a => a.startsWith('-'));
const mappedCmd =
  hasHelp && targetsTopCmdOnly && topCmd in HELP_SKILL_MAP ? topCmd : undefined;

if (mappedCmd) {
  const cmdObj = program.commands.find(c => c.name() === mappedCmd);
  if (cmdObj) {
    cmdObj.outputHelp();
    await fetchAndPrintSkill(HELP_SKILL_MAP[mappedCmd]);
    process.exit(0);
  }
}

// parseAsync (not parse) so commander awaits each command's returned promise
// before its postAction hook - that ordering is what keeps the output frame's
// trailing blank line after the command's async output instead of before it.
await program.parseAsync(normalizeAliases(process.argv, program));
