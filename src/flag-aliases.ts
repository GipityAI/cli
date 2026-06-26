import type { Command } from 'commander';

/**
 * Hidden long-flag aliases. Keys are tokens a user or LLM might type; values
 * are the canonical long flag commander knows about. Aliases are applied by
 * rewriting argv before commander parses, so `--help` output is unchanged.
 *
 * Rules for adding an alias:
 * - Must be a plausible LLM guess, not a typo fix.
 * - Never alias short flags.
 * - May collide with a real flag on a specific command (e.g. `--from` is a
 *   friendly alias for `--since` on `logs`, but a real required option on
 *   `workflow create`). Pass the resolved `program` to normalizeAliases and a
 *   token is left untouched whenever the command it targets declares it for
 *   real — so the real option always wins on the command that owns it.
 */
export const FLAG_ALIASES: Record<string, string> = {
  '--out': '--output',
  '--file': '--output',
  '--db': '--database',
  '--proj': '--project',
  '--lang': '--language',
  '--language-code': '--language',
  '--prov': '--provider',
  '--aspect': '--aspect-ratio',
  '--ratio': '--aspect-ratio',
  '--res': '--resolution',
  '--desc': '--description',
  '--body': '--data',
  '--src': '--source-dir',
  '--srcdir': '--source-dir',
  '--parallel': '--concurrency',
  '--max': '--limit',
  '--from': '--since',
  '--after': '--since',
  '--delay': '--wait',
};

export function normalizeAliases(argv: string[], program?: Command): string[] {
  // Flags the targeted command declares for real — never alias these, so a
  // command's own option always wins over a global guess.
  const realFlags = program ? collectRealFlags(argv, program) : new Set<string>();

  return argv.map(tok => {
    if (!tok.startsWith('--')) return tok;
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const name = tok.slice(0, eq);
      if (realFlags.has(name)) return tok;
      const canonical = FLAG_ALIASES[name];
      return canonical ? `${canonical}${tok.slice(eq)}` : tok;
    }
    if (realFlags.has(tok)) return tok;
    return FLAG_ALIASES[tok] ?? tok;
  });
}

/**
 * Resolve the deepest subcommand argv targets (descending program → command →
 * subcommand by name/alias) and return every long flag declared on it and its
 * ancestors. Used to suppress an alias when the resolved command owns that flag.
 */
function collectRealFlags(argv: string[], program: Command): Set<string> {
  // process.argv is [node, script, ...args]; start scanning at the first arg.
  const args = argv.slice(2);
  let cmd: Command = program;
  const chain: Command[] = [program];

  // Root value-options (e.g. `--api-base <url>`) may legitimately precede the
  // subcommand; skip them (and their value token) rather than ending resolution
  // there, so a command's own flag is still discovered when a global flag leads.
  const rootValueFlags = new Set(
    program.options.filter(o => o.long && o.required).map(o => o.long as string),
  );

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('-')) {
      if (!tok.includes('=') && rootValueFlags.has(tok)) i++; // consume its value
      continue;
    }
    const next = cmd.commands.find(c => c.name() === tok || c.aliases().includes(tok));
    if (!next) break;
    cmd = next;
    chain.push(next);
  }

  const flags = new Set<string>();
  for (const c of chain) {
    for (const opt of c.options) {
      if (opt.long) flags.add(opt.long);
    }
  }
  return flags;
}
