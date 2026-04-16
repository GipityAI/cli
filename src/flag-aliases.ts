/**
 * Hidden long-flag aliases. Keys are tokens a user or LLM might type; values
 * are the canonical long flag commander knows about. Aliases are applied by
 * rewriting argv before commander parses, so `--help` output is unchanged.
 *
 * Rules for adding an alias:
 * - Must be globally unambiguous across all subcommands.
 * - Must be a plausible LLM guess, not a typo fix.
 * - Never alias short flags.
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

export function normalizeAliases(argv: string[]): string[] {
  return argv.map(tok => {
    if (!tok.startsWith('--')) return tok;
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const name = tok.slice(0, eq);
      const canonical = FLAG_ALIASES[name];
      return canonical ? `${canonical}${tok.slice(eq)}` : tok;
    }
    return FLAG_ALIASES[tok] ?? tok;
  });
}
