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

  // Resolve the deepest subcommand, stepping over any options (and their values)
  // that appear before or among the command words. A leading global option must
  // not stop resolution: `gipity --api-base <url> workflow create --from x` has
  // to still descend to `create` so its real `--from` is collected — otherwise
  // the `--from`→`--since` alias wrongly rewrites the command's own option. The
  // old code broke at the first `-`, so any global option masked every
  // subcommand flag below it.
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('-')) {
      // Skip a known value-taking option's separate-token value so it isn't
      // mistaken for a command word (e.g. the `<url>` after `--api-base`).
      const opt = findChainOption(chain, tok);
      if (opt && (opt.required || opt.optional) && !tok.includes('=') && i + 1 < args.length) {
        i++;
      }
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

/** Find an option matching `rawTok` (`--flag`, `-x`, or `--flag=value`) declared
 *  on any command resolved so far, so we know whether to skip a following value. */
function findChainOption(chain: Command[], rawTok: string) {
  const eq = rawTok.indexOf('=');
  const name = eq > 0 ? rawTok.slice(0, eq) : rawTok;
  for (const c of chain) {
    for (const opt of c.options) {
      if (opt.long === name || opt.short === name) return opt;
    }
  }
  return null;
}
