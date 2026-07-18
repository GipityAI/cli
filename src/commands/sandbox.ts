import { Command, Option } from 'commander';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, extname, relative, resolve, sep } from 'path';
import { post } from '../api.js';
import { resolveProjectContext, getConfigPath, getProjectRoot, shouldIgnore } from '../config.js';
import { SCRATCH_IGNORE } from '../setup.js';
import { sync } from '../sync.js';
import { error as clrError, dim } from '../colors.js';
import { run, parseDuration } from '../helpers/index.js';
import { createProgressReporter, withSpinner } from '../progress.js';

const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  bash: 'bash',
  sh: 'bash',
};

// Interpreter tokens accepted at the head of a `run <interpreter> <file>`
// invocation (e.g. `gipity sandbox run python build_report.py`), mirroring how
// you'd launch a script locally. Maps each token to the canonical language.
const INTERPRETERS: Record<string, string> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  node: 'javascript',
  js: 'javascript',
  javascript: 'javascript',
  bash: 'bash',
  sh: 'bash',
};

/** The three ways to pin a language, shown whenever none was pinned. */
const PIN_LANGUAGE_HELP = [
  '  gipity sandbox run bash "<code>"            # interpreter token (bash | python | node)',
  '  gipity sandbox run --language bash "<code>" # explicit flag (js | py | bash)',
  '  gipity sandbox run --file script.sh         # inferred from the file extension',
].join('\n');

// Words that open a code statement, not a command line. A single positional
// starting with one of these is a JS/Python snippet whose language we must not
// guess (see resolveLanguage) - everything here is either invalid in bash or,
// worse, VALID in bash with a different meaning (`export FOO=1`, `for ...`).
const CODE_OPENERS = new Set([
  'const', 'let', 'var', 'function', 'async', 'await', 'import', 'export',
  'console', 'require', 'print', 'def', 'class', 'lambda', 'from', 'return',
  'for', 'while', 'if', 'try', 'with',
]);

/**
 * True when a bare inline string is unmistakably a shell COMMAND LINE
 * (`node tests/game.test.js`, `ls -la`, `ffmpeg -i in.mp4 out.gif`) rather
 * than a code snippet. Deliberately conservative: one line, starts with a
 * plain command word (no parens/quotes/operators in it), not a code opener,
 * not an assignment (`x = 1` is Python-or-bash-ambiguous). Anything that
 * fails these checks still goes through the explicit-pin error below.
 */
export function looksLikeShellCommand(code: string): boolean {
  if (code.includes('\n')) return false;
  const m = /^([A-Za-z0-9_.~/-]+)(\s|$)/.exec(code.trim());
  if (!m) return false;
  const token = m[1].toLowerCase();
  if (CODE_OPENERS.has(token)) return false;
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(code)) return false; // assignment
  // A lone bare word (`foo`) is as likely a typo as a command; require either
  // arguments after the word or a path-shaped word (`./build.sh`, `bin/run`).
  return /\s\S/.test(code.trim()) || token.includes('/');
}

/**
 * Resolve the language from an explicit signal, or exit.
 *
 * Precedence: interpreter token > --language > --file extension > the
 * command-line heuristic above (bash).
 *
 * Beyond that there is no default. js/python/bash are mutually exclusive, and
 * plenty of snippets parse as more than one of them (`x = 1`, `a[0]`, `foo()`),
 * so a blanket default silently runs some fraction of input in the wrong
 * interpreter. The old behavior defaulted to JavaScript, which meant a shell
 * one-liner ran as JS and died with a Node `SyntaxError` at `/work/_run.js` -
 * after paying for a project sync and a server round trip. The one shape we DO
 * default is the unambiguous command line (`gipity sandbox run "node
 * tests/game.test.js"`): it was the single most common rejected invocation,
 * the CLI had everything it needed to run it, and no code snippet matches the
 * heuristic. Ambiguous snippets still fail here, costing nothing and saying
 * what to type. (`docs/skills/sandbox-tools.md` used to carry a hand-written
 * "always pin the language" warning to work around this; the CLI enforces it
 * now.)
 */
export function resolveLanguage(opts: {
  langFromInterp?: string;
  langOpt?: string;
  filePath?: string;
  inlineCode?: string;
}): string {
  const explicit = opts.langFromInterp
    ?? (opts.langOpt ? LANG_MAP[opts.langOpt.toLowerCase()] ?? opts.langOpt : undefined);

  if (explicit && !['javascript', 'python', 'bash'].includes(explicit)) {
    console.error(clrError(`Invalid language: ${opts.langOpt}. Use: js, py, or bash`));
    process.exit(1);
  }
  if (explicit) return explicit;

  const fromExt = opts.filePath
    ? LANG_MAP[extname(opts.filePath).slice(1).toLowerCase()]
    : undefined;
  if (fromExt) return fromExt;

  if (opts.filePath) {
    console.error(clrError(`Cannot infer the language of ${opts.filePath} from its extension (expected .js, .py, or .sh).`));
    console.error(dim(`Pass --language explicitly:\n  gipity sandbox run --language py --file ${opts.filePath}`));
    process.exit(1);
  }
  if (opts.inlineCode && looksLikeShellCommand(opts.inlineCode)) return 'bash';

  console.error(clrError('No language specified for inline code.'));
  console.error(dim(`Pin it one of three ways:\n${PIN_LANGUAGE_HELP}`));
  process.exit(1);
}

/** Truncate one arg for echoing back, so a 2 KB fragment doesn't flood the terminal. */
function preview(arg: string): string {
  const flat = arg.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/**
 * Inline code arrived as several positional args, which means the caller's shell
 * split it before the CLI ever saw it. The old message ("Unrecognized
 * invocation") just restated the rules and left the caller to guess which one it
 * broke - an agent that hits this typically retries the same mangled quoting.
 *
 * So: show the fragments we actually received (the split point is the evidence),
 * then name the usual cause. On PowerShell a double-quoted string interpolates
 * `$(...)` and backslash is NOT an escape character, so a POSIX-style
 * `"... $(cmd) ... \"$f\" ..."` one-liner both runs `cmd` locally and terminates
 * the string early at `\"`. That is exactly how one quoted arg becomes many.
 */
function explainSplitArgs(args: string[]): string {
  const looksInterpolated = args.some(a => a.includes('$(') || a.includes('`'));
  const lines = [
    clrError(`Inline code must be a single argument, but ${args.length} were received:`),
    ...args.slice(0, 4).map((a, i) => dim(`  ${i + 1}: ${preview(a)}`)),
    ...(args.length > 4 ? [dim(`  ... and ${args.length - 4} more`)] : []),
    '',
    'Your shell split the code before the CLI saw it.',
  ];
  if (looksInterpolated) {
    lines.push(
      dim('In PowerShell a double-quoted string interpolates $(...), and backslash does not'),
      dim('escape a quote - so a POSIX one-liner runs its subshell locally and ends early.'),
    );
  }
  lines.push(
    '',
    'Fix, in order of preference:',
    dim('  1. Put the code in a file (best for anything with quotes, $(...), or newlines):'),
    '       gipity sandbox run --file script.sh',
    dim('  2. Use the interpreter shorthand on a file:'),
    '       gipity sandbox run bash script.sh',
    dim('  3. Keep it inline, but as ONE argument your shell will not split:'),
    "       gipity sandbox run --language bash 'echo hi'",
  );
  return lines.join('\n');
}

// Regex fragments for the scratch directory names, derived from SCRATCH_IGNORE
// so this can never drift from what sync actually ignores. Each pattern's
// trailing '/' is dropped, dots are escaped, and a leading-`*` glob (`*_tmp/`)
// becomes a filename-char run so `frames_tmp/` is matched too. `shouldIgnore`
// is the authoritative filter downstream, so a slightly broad candidate here is
// harmless — it just gets dropped if sync wouldn't actually ignore it.
const SCRATCH_DIR_PATTERNS = SCRATCH_IGNORE
  .map((p) => p.replace(/\/$/, ''))
  .filter(Boolean)
  .map((p) => p.replace(/[.]/g, '\\.').replace(/\*/g, '[A-Za-z0-9._-]*'));

/**
 * References to a scratch directory inside a code body — the files the sandbox's
 * auto-mirror will NOT carry, because sync ignores the scratch namespaces. Two
 * shapes of the same trap are matched:
 *   - project-relative `tmp/nimbus.pdf` (how you name a root file locally), and
 *   - mirror-absolute `/work/tmp/nimbus.pdf` (how you name that same file inside
 *     the container, where the auto-mirror lands the project under /work/).
 * Both are returned project-relative (the `/work/` prefix stripped) so the caller
 * can resolve them on local disk and print a clean path. Deliberately NOT matched:
 * `/tmp/out` (the container's own writable /tmp is fine) nor `mytmp/x` (word
 * boundary). Covers every SCRATCH_IGNORE namespace, including the `*_tmp/` glob.
 * Returns the distinct referenced paths. Exported for tests.
 */
export function scratchRefsInCode(code: string): string[] {
  const dirs = SCRATCH_DIR_PATTERNS.join('|');
  if (!dirs) return [];
  // Match either a `/work/`-prefixed reference or a bare one that is not preceded
  // by a slash (absolute/nested path) or a word/dot char (mytmp/, a.tmp/).
  const re = new RegExp(`(?:\\/work\\/|(?<![\\w/.]))(?:${dirs})\\/[A-Za-z0-9._\\-\\/]+`, 'g');
  return [...new Set((code.match(re) ?? []).map((m) => m.replace(/^\/work\//, '')))];
}

/**
 * True when the code WRITES `p` at its FIRST use, so the file is produced inside
 * the sandbox and any later reference (an `ls`/`cat` to inspect it, a second
 * pass over it) reads that in-sandbox copy rather than an unmirrored input. Two
 * output shapes are recognized, judged at the path's first occurrence:
 *   - a flagged/redirected output: `-o p`, `-of p`, `--output p`, `> p`, `>> p`, `tee p`;
 *   - an ffmpeg trailing-positional output: ffmpeg names its output as the last
 *     positional (NO `-o` flag), so a path in an ffmpeg segment that is not the
 *     `-i`/`--input` argument is an output.
 * This keeps the write-then-inspect pattern in one script working (ffmpeg writes
 * tmp/clip.mp4, then `ls tmp/clip.mp4`), while still catching a genuine staged
 * INPUT read whose first use is not a write (`cat tmp/x`, `pandoc tmp/x.md ...`,
 * `open('tmp/x')`, `ffmpeg -i tmp/x ...`). It also lets the normal iterate loop
 * through: a scratch OUTPUT lands locally after the first run, so on a re-run it
 * exists, but its first reference is still the write.
 */
export function isWriteTarget(code: string, p: string): boolean {
  const path = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:\\/work\\/)?${path}(?![\\w./-])`).exec(code);
  if (!m) return false;
  const idx = m.index;
  const before = code.slice(Math.max(0, idx - 40), idx);
  // Flagged / redirected output position immediately before the path.
  if (/(?:^|[\s'"`;(])(?:-o|-of|--out(?:put)?[= ]|>>?|tee(?:\s+-a)?)\s*['"`]?(?:\/work\/)?$/.test(before)) return true;
  // ffmpeg's output is a trailing positional (no `-o`): a path in an ffmpeg
  // segment that isn't the `-i`/`--input` argument is an output.
  const segStart = Math.max(
    code.lastIndexOf('&&', idx), code.lastIndexOf('||', idx),
    code.lastIndexOf(';', idx), code.lastIndexOf('|', idx), code.lastIndexOf('\n', idx),
  );
  // segStart points at the FIRST char of the separator; a two-char operator
  // (`&&`/`||`) leaves its second char in the slice, so strip any leading
  // operator/space chars before reading the command word. Without this, the
  // canonical `mkdir -p tmp && ffmpeg -i a.png tmp/out.mp4` idiom left a stray
  // `&` that defeated the command extractor and false-blocked the re-run.
  const seg = code.slice(segStart + 1, idx).replace(/^[\s&|;]+/, '');
  const cmd = /^\s*([A-Za-z0-9_./-]+)/.exec(seg)?.[1]?.split('/').pop()?.toLowerCase();
  const afterInputFlag = /(?:^|[\s'"`])(?:-i|--input)[= ]\s*['"`]?$/.test(before);
  return cmd === 'ffmpeg' && !afterInputFlag;
}

/** Project-relative path from the process cwd, or undefined when there's
 *  no local config (one-off mode) or the cwd is at/above the project root. */
function resolveRelativeCwd(): string | undefined {
  const configPath = getConfigPath();
  if (!configPath) return undefined;
  const projectRoot = dirname(configPath);
  const rel = relative(projectRoot, process.cwd());
  if (!rel || rel.startsWith('..')) return undefined;
  return rel.split(/[\\/]/).filter(Boolean).join('/');
}

export const sandboxCommand = new Command('sandbox')
  .description('Run code in a sandbox');

sandboxCommand
  .command('run [args...]')
  .description('Run code')
  // No default. js/python/bash are mutually exclusive and the same snippet can
  // parse as more than one of them, so an implicit default silently runs code in
  // the wrong interpreter. Every invocation must pin the language via this flag,
  // an interpreter token, or a --file extension - see resolveLanguage().
  .option('--language <language>', 'Language: js, py, or bash (required unless pinned by an interpreter token or --file extension)')
  .option('--file <path>', 'Read the code body from a file instead of the inline <code> arg; --language is inferred from the extension when not given')
  // `--code "<code>"` is the natural first guess for passing inline code (the
  // positional arg is the canonical spelling). Accept it as a working alias
  // rather than bouncing the guess into an unknown-option --help detour.
  .addOption(new Option('--code <code>', 'Alias for the positional inline <code> arg').hideHelp())
  // `bash -c '<code>'` and `node -e '<code>'` are the universal ways to run an
  // inline command, and an agent reaches for them by reflex - but the bare
  // `-c` / `-e` used to hit commander's OWN parser first ("unknown option
  // '-c'"), before the interpreter-token logic below ever ran. Declaring them
  // as hidden inline-code aliases makes the idiom just work: `-c`/`--cmd`
  // implies bash, `-e`/`--eval` implies node, and a leading `bash`/`python`/
  // `node` token still pins the language (so `python -c '...'` runs as python).
  .addOption(new Option('-c, --cmd <code>', 'Inline code (bash idiom: `sandbox run bash -c "<code>"`)').hideHelp())
  .addOption(new Option('-e, --eval <code>', 'Inline code (node idiom: `sandbox run node -e "<code>"`)').hideHelp())
  .option('--timeout <seconds>', 'Execution timeout. Bare number = seconds; or pass an explicit unit that means the same on both this and `page eval --timeout`, e.g. --timeout 90s.', '30')
  .option(
    '--input <path>',
    'Narrow to specific project files instead of auto-mirroring the whole tree (repeatable). Use this only for >1 GB projects or when you want surgical control.',
    (v: string, prev?: string[]) => [...(prev ?? []), v],
  )
  // Named "discard", not "no-sync": in Gipity vocabulary "sync" means the
  // local<->cloud file sync, so a no-sync spelling reads as "give me the file
  // locally, just don't sync it" - which is the tmp/ scratch path below, not
  // this flag. Collected as an array so the flag is repeatable.
  .option(
    '--discard-output <glob>',
    'Discard run outputs matching this glob entirely - not saved, not returned (repeatable). To LOOK at an output without keeping it, write it under tmp/ instead: scratch outputs land on local disk only and never enter the project. Supports *, **, and dir/ prefixes.',
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
By default the whole project is auto-mirrored into /work/ (up to 1 GB) -
so your code can reference project files by their relative path, and any
file you write lands back in the project. No manual copy needed.

Exception: tmp/ is scratch. An output written under tmp/ comes back to
your local tmp/ for inspection but is never saved to the project - use it
for previews and other look-once artifacts (no cleanup needed). To drop
an output entirely, --discard-output <glob>.

Use --input only for projects over the auto-mirror cap, or when you want
to restrict what the sandbox sees.

No network, and the toolset is fixed - pip/npm/apt installs won't work.
Use only preinstalled tools, or pull external inputs into the project first.

Examples:

  # Auto-mirror: code sees the whole project at /work/
  $ gipity sandbox run --language bash \\
      "cwebp -q 82 src/images/elephant.png -o src/images/elephant.webp"

  # Python reading a project CSV (auto-mirror)
  $ gipity sandbox run --language python \\
      "import pandas as pd; print(pd.read_csv('data/sales.csv').describe())"

  # Preview a generated PDF without saving the preview: write it to tmp/
  $ gipity sandbox run bash \\
      "pdftoppm -png -r 90 docs/report.pdf tmp/preview"
  # -> tmp/preview-1.png lands on local disk only; Read it, done.

  # Run a script file directly (language inferred from .py)
  $ gipity sandbox run --file build_report.py
  $ gipity sandbox run python build_report.py   # same thing, interpreter shorthand
  $ gipity sandbox run bash "echo hi; ffmpeg -version"   # inline, language pinned
  $ gipity sandbox run bash -c "ffmpeg -version"         # the bash -c idiom also works
  $ gipity sandbox run node -e "console.log(process.version)"  # and node -e

  # Surgical: only these files are mirrored in
  $ gipity sandbox run --language bash \\
      --input src/images/hero.png \\
      "optipng -o5 src/images/hero.png"

Files written under /work/ sync back to the project at the same relative
path. The sandbox runs with WorkingDir set to your current CLI cwd, so
relative paths in your code resolve where you'd expect.

Pre-installed: Python (pandas, numpy, matplotlib, Pillow, scipy, bs4),
CLI tools (ImageMagick, FFmpeg, webp/cwebp, optipng, jq, pandoc, exiftool,
GCC/Rust).
`)
  .action((args: string[] = [], opts) => run('Sandbox', async () => {
    // Everything below this point is pure argument validation - it reads the local
    // filesystem and nothing else. It runs BEFORE resolveProjectContext() so a
    // malformed invocation fails on the spot instead of first paying a project
    // lookup (and printing a misleading "→ (project: …)" banner) only to reject
    // the args a moment later.

    // Resolve the positional args into either inline code or a script-file path.
    // `run <interpreter> <file>` (e.g. `run python build_report.py`) is the natural
    // mental model, so accept it: a leading interpreter token + a path becomes
    // --file with the language pinned by the interpreter. A single positional is
    // inline code, same as before.
    let inlineCode: string | undefined;
    let filePath: string | undefined = opts.file;
    let langFromInterp: string | undefined;
    // Inline code may arrive via a flag alias instead of the positional slot:
    //   --code            language-agnostic (needs --language or an interpreter token)
    //   --cmd / -c        the `bash -c '<code>'` idiom → implies bash
    //   --eval / -e       the `node -e '<code>'` idiom → implies node
    // Fold whichever was given into the positional slot before the shape checks,
    // preserving a leading interpreter token (`python -c '...'` stays python).
    const flagCode = opts.code ?? opts.cmd ?? opts.eval;
    if (flagCode !== undefined) {
      // The positional slot may legitimately hold ONLY a leading interpreter
      // token that pins the language; anything more is a duplicate copy of the code.
      const leadIsInterp = args.length === 1 && INTERPRETERS[args[0].toLowerCase()] !== undefined;
      if (args.length > (leadIsInterp ? 1 : 0)) {
        console.error(clrError('Pass the code once: either positionally or via --code/--cmd/-c/--eval/-e, not both'));
        process.exit(1);
      }
      const interp = leadIsInterp ? args[0]
        : opts.cmd !== undefined ? 'bash'
        : opts.eval !== undefined ? 'node'
        : undefined;
      args = interp ? [interp, flagCode] : [flagCode];
    }
    if (args.length >= 2 && INTERPRETERS[args[0].toLowerCase()] !== undefined) {
      langFromInterp = INTERPRETERS[args[0].toLowerCase()];
      const rest = args.slice(1).join(' ');
      // `run python build_report.py` -> a script file; `run bash "echo hi"` -> inline code.
      if (existsSync(rest) && statSync(rest).isFile()) filePath = rest;
      else inlineCode = rest;
    } else if (args.length === 1) {
      inlineCode = args[0];
    } else if (args.length > 1) {
      console.error(explainSplitArgs(args));
      process.exit(1);
    }

    if (inlineCode !== undefined && filePath) {
      console.error(clrError('Pass the code ONE way, not both: an inline <code> arg OR --file <path>.'));
      console.error(dim("  inline:  gipity sandbox run bash 'echo hi'"));
      console.error(dim('  file:    gipity sandbox run --file script.sh'));
      process.exit(1);
    }
    if (inlineCode === undefined && !filePath) {
      console.error(clrError('Provide an inline <code> arg or --file <path>'));
      process.exit(1);
    }

    let source = inlineCode;
    if (filePath) {
      try {
        source = readFileSync(filePath, 'utf8');
      } catch {
        console.error(clrError(`Cannot read file: ${filePath}`));
        process.exit(1);
      }
    }

    // Language precedence: interpreter token > --language > file extension >
    // unambiguous-command-line heuristic (bash). resolveLanguage() exits when
    // nothing pins one and the input isn't command-shaped, rather than guessing.
    // This runs BEFORE the project sync and the server round trip below, so a
    // missing language costs nothing but the message.
    const language = resolveLanguage({ langFromInterp, langOpt: opts.language, filePath, inlineCode });

    // Validate --discard-output globs while we're still pre-network: an empty
    // pattern (e.g. a quoting mishap) would silently match nothing server-side.
    const discardOutput: string[] = opts.discardOutput ?? [];
    if (discardOutput.some((g) => !g.trim())) {
      console.error(clrError('--discard-output requires a non-empty glob (e.g. --discard-output "*.ppm")'));
      process.exit(1);
    }

    // Args are good - now it's worth resolving (and announcing) the project.
    const { config } = await resolveProjectContext();

    // A bare number is native SECONDS; an explicit suffix (90s / 1500ms / 2m) is
    // portable with `page eval --timeout` and converted to seconds here.
    const durOpt = parseDuration(opts.timeout, 's');
    const timeout = durOpt ? Math.max(1, Math.round(durOpt.value)) : parseInt(opts.timeout, 10);
    const cwd = resolveRelativeCwd();

    // A scratch path is never synced, so it can never reach the VFS the sandbox
    // mirrors from - `--input tmp/frame.png` would fail inside the container with
    // a bare "no such file". Catch it here, where we can say why.
    const scratchInputs = (opts.input ?? []).filter(
      (p: string) => shouldIgnore(p.replace(/\\/g, '/').replace(/^\.\//, ''), SCRATCH_IGNORE),
    );
    if (scratchInputs.length) {
      console.error(clrError(`Scratch paths are never mirrored into the sandbox: ${scratchInputs.join(', ')}`));
      console.error(dim(`  ${SCRATCH_IGNORE.join(', ')} are ignored by sync, so the sandbox never sees them.`));
      console.error(dim('  Stage inputs at a real project path (src/, docs/, assets/) and delete them afterward.'));
      process.exit(1);
    }

    // Same trap, one step less obvious: a scratch file referenced as an INPUT
    // from inside the code body (not via --input). The auto-mirror skips the
    // scratch namespaces, so the container hits a bare "No such file" for a path
    // the caller can plainly see on local disk. Catch it here, pre-sync, with the
    // reason. We flag a reference only when that scratch file ACTUALLY EXISTS
    // locally — which cleanly separates a staged input (must exist to be read)
    // from a scratch OUTPUT target like `tmp/preview.png` (valid; doesn't exist
    // yet, and outputs written under tmp/ come back on their own).
    if (source) {
      const scratchReads = scratchRefsInCode(source).filter(
        (p) => shouldIgnore(p, SCRATCH_IGNORE)
          && existsSync(resolve(process.cwd(), p))
          // A previous run's OUTPUT lands locally, so on a re-run it exists -
          // but a path written at its FIRST use (ffmpeg output, -o, >) is
          // produced in the sandbox, so a later inspect (`ls`/`cat`) in the same
          // script reads that copy, not the mirror. Only a genuine staged input
          // read (first use isn't a write) is blocked.
          && !isWriteTarget(source, p),
      );
      if (scratchReads.length) {
        console.error(clrError(`Scratch files are never mirrored into the sandbox, so it can't read: ${scratchReads.join(', ')}`));
        console.error(dim(`  ${SCRATCH_IGNORE.join(', ')} are ignored by sync, so the sandbox never sees them.`));
        console.error(dim('  Stage the input at a real project path (src/, docs/, assets/) and delete it afterward.'));
        console.error(dim('  (Writing OUTPUT under tmp/ is fine — scratch outputs come back to your local tmp/.)'));
        process.exit(1);
      }
    }

    // Push local working-tree changes up before executing. The sandbox mirrors
    // the *server* (VFS), not the local cwd, so any input staged outside Claude's
    // Write/Edit auto-push hook - a Bash `cp`/`ffmpeg`/redirect, or any external
    // process - would otherwise be invisible to the run and the first invocation
    // would silently miss its inputs. Syncing first makes the auto-mirror reflect
    // local state however files got there - with the one exception of the scratch
    // namespaces above, which sync ignores and so the mirror never carries.
    // Bidirectional + CAS, so it's a cheap manifest check when nothing changed.
    // Symmetric with the post-run pull below. Skip in one-off mode (no project).
    if (getConfigPath()) {
      await sync({ interactive: false, progress: opts.json ? undefined : createProgressReporter() });
    }

    type SandboxResponse = {
      data: {
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
        timedOut: boolean;
        stdoutTruncated?: boolean;
        stderrTruncated?: boolean;
        outputFiles?: string[];
        skippedOutputFiles?: string[];
        scratchFiles?: { path: string; contentBase64: string }[];
        mirroredCount?: number;
        autoMirrorSkipped?: { reason: string; totalBytes: number };
        mirrorWarnings?: string[];
      };
    };
    // The run blocks until the sandbox finishes (up to the timeout); animate the
    // wait, then clear the spinner so stdout/stderr is the result. JSON skips it.
    const doRun = () => post<SandboxResponse>(`/projects/${config.projectGuid}/sandbox/execute`, {
      code: source,
      language,
      timeout: isNaN(timeout) ? 30 : timeout,
      input_files: opts.input,
      cwd,
      // The filter must run SERVER-side (in the output extractor): skipping
      // only in the CLI would still write the files into project storage and
      // make every later sync propose deleting them. (`noSyncOutput` is the
      // wire name for --discard-output.)
      noSyncOutput: discardOutput.length ? discardOutput : undefined,
    });
    const res = opts.json
      ? await doRun()
      : await withSpinner('Running in sandbox...', doRun, { done: null });

    // Pull sandbox-written outputs down to the local cwd automatically. The
    // server has already mirrored them into the project (VFS) and handed back
    // the exact list, so honoring it here means files land locally without a
    // manual `gipity sync` - same auto-pull contract `gipity chat` uses on its
    // `filesChanged` flag. Skip in one-off mode (no local project to sync into).
    const pulledLocal = !!(res.data.outputFiles?.length && getConfigPath());
    if (pulledLocal) {
      await sync({ interactive: false, progress: opts.json ? undefined : createProgressReporter() });
    }

    // Scratch outputs (tmp/ and friends) never enter the project: the server
    // returns their bytes inline instead of persisting them, and we land them
    // here. The scratch namespace is ignored by sync in both directions, so
    // the file exists on local disk only - inspect it, no cleanup required.
    const scratchWritten: string[] = [];
    if (res.data.scratchFiles?.length) {
      const base = resolve(getProjectRoot() ?? process.cwd());
      for (const f of res.data.scratchFiles) {
        const rel = f.path.replace(/\\/g, '/');
        const abs = resolve(base, rel);
        if (abs !== base && !abs.startsWith(base + sep)) continue; // traversal guard
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(f.contentBase64, 'base64'));
        scratchWritten.push(rel);
      }
    }

    if (opts.json) {
      const { scratchFiles: _omit, ...rest } = res.data;
      console.log(JSON.stringify({ ...rest, scratchFiles: scratchWritten, filesSynced: pulledLocal }));
    } else {
      if (res.data.autoMirrorSkipped) {
        console.error(dim(`Note: ${res.data.autoMirrorSkipped.reason}`));
      }
      if (res.data.mirrorWarnings && res.data.mirrorWarnings.length > 0) {
        console.error(dim(`Note: ${res.data.mirrorWarnings.length} project file(s) could not be mirrored into the sandbox and were skipped:`));
        for (const w of res.data.mirrorWarnings) console.error(dim(`  - ${w}`));
      }
      if (res.data.stdout) console.log(res.data.stdout);
      if (res.data.stderr) console.error(res.data.stderr);
      if (res.data.timedOut) console.error(`[Timed out after ${res.data.durationMs}ms]`);
      if (res.data.stdoutTruncated || res.data.stderrTruncated) {
        console.error(dim('Note: output truncated at 256 KB. Write large results to a file instead of printing them.'));
      }
      if (res.data.outputFiles && res.data.outputFiles.length > 0) {
        // Only claim a file is "synced to this directory" once it is actually on
        // local disk - a sync that ran is not the same as a file that landed.
        const projectRoot = getProjectRoot();
        const landed = (f: string) => pulledLocal && !!projectRoot && existsSync(resolve(projectRoot, f));
        const onDisk = res.data.outputFiles.filter(landed);
        const notOnDisk = res.data.outputFiles.filter((f: string) => !landed(f));
        if (onDisk.length > 0) {
          console.log('\nOutput files synced to this directory:');
          for (const f of onDisk) console.log(`${f}`);
        }
        if (notOnDisk.length > 0) {
          console.log('\nOutput files saved to project:');
          for (const f of notOnDisk) console.log(`${f}`);
          if (pulledLocal) console.log(dim("Not pulled locally - run 'gipity sync' to fetch them."));
        }
        // A sandbox output that lands directly at the project ROOT (a bare
        // filename, no directory) is almost always a throwaway probe, not a
        // real asset - real assets live under src/, functions/, assets/, etc.
        // Root files sync and are picked up by the deploy `files` phase, so a
        // stray one ships unless the caller remembers to delete it. Point at
        // tmp/ (local-only, never synced or deployed) at the moment of use so
        // the next probe never has to be hand-cleaned off a deployable path.
        const rootStrays = [...onDisk, ...notOnDisk].filter((f: string) => !f.includes('/'));
        if (rootStrays.length > 0) {
          console.log(dim(`\nNote: ${rootStrays.join(', ')} landed at the project root and will deploy with the files phase.`));
          console.log(dim('For a throwaway probe or fixture, write it under tmp/ instead - scratch outputs stay on local disk and never sync or deploy.'));
        }
      }
      if (scratchWritten.length > 0) {
        console.log('\nScratch outputs (local only - never synced or deployed):');
        for (const f of scratchWritten) console.log(`${f}`);
      }
      if (res.data.skippedOutputFiles && res.data.skippedOutputFiles.length > 0) {
        console.log(dim('\nDiscarded (--discard-output):'));
        for (const f of res.data.skippedOutputFiles) console.log(dim(`${f}`));
      }
      // Silent-failure guard: a command that exits 0 yet leaves a 0-byte output
      // almost always failed silently - a broken ffmpeg filter, or an OOM the
      // shell swallowed. Without this the only signal is an `ls -la` afterward,
      // and the agent burns a turn inferring "the encode failed" from a file
      // size. Name it at the moment it happens, for scratch (bytes returned
      // inline) and synced outputs (stat on local disk) alike.
      if (res.data.exitCode === 0) {
        const emptyScratch = (res.data.scratchFiles ?? [])
          .filter((f) => f.contentBase64.length === 0)
          .map((f) => f.path.replace(/\\/g, '/'));
        const root = getProjectRoot();
        const emptyOutputs = pulledLocal && root
          ? (res.data.outputFiles ?? []).filter((f: string) => {
              try { return statSync(resolve(root, f)).size === 0; } catch { return false; }
            })
          : [];
        const empties = [...new Set([...emptyScratch, ...emptyOutputs])];
        if (empties.length > 0) {
          console.error(dim(`Note: ${empties.join(', ')} was written but is empty (0 bytes) - the command exited 0 but likely failed silently (a broken filter, or an out-of-memory kill the shell swallowed). Re-check the command, or shrink the job if it may have run out of memory.`));
        }
      }
      if (res.data.exitCode !== 0) {
        // A process killed by a signal exits 128+signal. 137 (SIGKILL) on the
        // sandbox is almost always the OS OOM-killer - the raw `/work/_run.sh:
        // Killed` line the shell prints never says so, so a bare retry at the
        // same size just OOMs again. Name it and point at the usual fix.
        if (res.data.exitCode === 137) {
          console.error(clrError('The sandbox process was killed (exit 137) - it ran out of memory.'));
          console.error(dim('  Shrink the job: for ffmpeg, downscale (-vf scale=640:-2) and add -preset ultrafast;'));
          console.error(dim('  for ImageMagick, lower -density/-resize. Process in smaller chunks if it still OOMs.'));
        }
        // No "did you mean another language?" hint is needed: the language is now
        // always something the caller pinned, never a silent default we chose.
        process.exit(res.data.exitCode);
      }
    }
  }));
