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
  '--no-sync-output': '--discard-output',
  '--max': '--limit',
  '--from': '--since',
  '--after': '--since',
  '--delay': '--wait',
};

export function normalizeAliases(argv: string[], program?: Command): string[] {
  // Flags the targeted command declares for real — never alias these, so a
  // command's own option always wins over a global guess.
  const target = program ? resolveTarget(argv, program) : null;
  const realFlags = new Set<string>();
  for (const c of target?.chain ?? []) {
    for (const opt of c.options) if (opt.long) realFlags.add(opt.long);
  }

  const aliased = argv.map(tok => {
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
  return target ? rewriteKeyValuePositionals(aliased, target) : aliased;
}

/**
 * `key=value` positional -> `--key=value`, when it can only have meant the flag.
 *
 * Agents keep carrying an option over as a bare `key=value` positional
 * (`gipity add 2d-game title="Brick Breaker"`), the form many CLIs and
 * Makefiles accept. Rather than error and cost a retry turn, read it as the
 * option - but only when that is unambiguous: the token sits PAST the
 * command's declared positionals (so it can't be a real argument that merely
 * contains `=`, like a SQL string or an env assignment for `sandbox run`), the
 * command has no variadic argument to soak it up, and `--key` (or its alias) is
 * a value-taking option the targeted command actually declares. Anything else is
 * left alone, so commander's excess-argument error still names it.
 */
function rewriteKeyValuePositionals(argv: string[], target: ResolvedTarget): string[] {
  const { leaf, chain, firstOperand } = target;
  const declared = leaf.registeredArguments;
  if (leaf.commands.length > 0 || declared.some(a => a.variadic)) return argv;
  const options = chain.flatMap(c => c.options);
  const byLong = new Map(options.filter(o => o.long).map(o => [o.long as string, o]));
  const byShort = new Map(options.filter(o => o.short).map(o => [o.short as string, o]));
  const takesValue = (tok: string): boolean => {
    if (tok.includes('=')) return false;
    const o = byLong.get(tok) ?? byShort.get(tok);
    return !!o && (o.required || o.optional);
  };

  const out = argv.slice();
  let positional = 0;
  for (let i = firstOperand; i < out.length; i++) {
    const tok = out[i];
    if (tok === '--') break; // everything after is a literal operand
    if (tok.startsWith('-')) {
      if (takesValue(tok)) i++; // skip its value
      continue;
    }
    const index = positional++;
    if (index < declared.length) continue;
    const kv = /^([A-Za-z][\w-]*)=([\s\S]*)$/.exec(tok);
    if (!kv) continue;
    const flag = [`--${kv[1]}`, FLAG_ALIASES[`--${kv[1]}`]].find(f => {
      const o = f ? byLong.get(f) : undefined;
      return !!o && (o.required || o.optional);
    });
    if (flag) out[i] = `${flag}=${kv[2]}`;
  }
  return out;
}

export interface ResolvedTarget {
  /** program -> ... -> the deepest subcommand argv names. */
  chain: Command[];
  leaf: Command;
  /** Index in argv just past the last subcommand name. */
  firstOperand: number;
  /** The first operand that is not a subcommand of `leaf`, if any. */
  operand?: string;
}

/**
 * Resolve the deepest subcommand argv targets (descending program → command →
 * subcommand by name/alias). Used to suppress an alias when the resolved command
 * owns that flag, and to find the command's operands.
 */
export function resolveTarget(argv: string[], program: Command): ResolvedTarget {
  let cmd: Command = program;
  const chain: Command[] = [program];

  // Root value-options (e.g. `--api-base <url>`) may legitimately precede the
  // subcommand; skip them (and their value token) rather than ending resolution
  // there, so a command's own flag is still discovered when a global flag leads.
  const rootValueFlags = new Set(
    program.options.filter(o => o.long && o.required).map(o => o.long as string),
  );

  // process.argv is [node, script, ...args]; start scanning at the first arg.
  let firstOperand = 2;
  let operand: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('-')) {
      if (!tok.includes('=') && rootValueFlags.has(tok)) i++; // consume its value
      continue;
    }
    const next = cmd.commands.find(c => c.name() === tok || c.aliases().includes(tok));
    if (!next) { operand = tok; break; }
    cmd = next;
    chain.push(next);
    firstOperand = i + 1;
  }
  return { chain, leaf: cmd, firstOperand, operand };
}
