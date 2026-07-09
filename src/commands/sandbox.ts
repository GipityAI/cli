import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'fs';
import { dirname, extname, relative } from 'path';
import { post } from '../api.js';
import { resolveProjectContext, getConfigPath, shouldIgnore } from '../config.js';
import { SCRATCH_IGNORE } from '../setup.js';
import { sync } from '../sync.js';
import { error as clrError, dim } from '../colors.js';
import { run } from '../helpers/index.js';
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
  .option('--timeout <seconds>', 'Execution timeout in seconds', '30')
  .option(
    '--input <path>',
    'Narrow to specific project files instead of auto-mirroring the whole tree (repeatable). Use this only for >1 GB projects or when you want surgical control.',
    (v: string, prev?: string[]) => [...(prev ?? []), v],
  )
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
By default the whole project is auto-mirrored into /work/ (up to 1 GB) -
so your code can reference project files by their relative path, and any
file you write lands back in the project. No manual copy needed.

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

  # Run a script file directly (language inferred from .py)
  $ gipity sandbox run --file build_report.py
  $ gipity sandbox run python build_report.py   # same thing, interpreter shorthand
  $ gipity sandbox run bash "echo hi; ffmpeg -version"   # inline, language pinned

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
      console.error(clrError('Pass either an inline <code> arg or --file <path>, not both'));
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

    // Args are good - now it's worth resolving (and announcing) the project.
    const { config } = await resolveProjectContext();

    const timeout = parseInt(opts.timeout, 10);
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
        outputFiles?: string[];
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
    });
    const res = opts.json
      ? await doRun()
      : await withSpinner('Running in sandbox…', doRun, { done: null });

    // Pull sandbox-written outputs down to the local cwd automatically. The
    // server has already mirrored them into the project (VFS) and handed back
    // the exact list, so honoring it here means files land locally without a
    // manual `gipity sync` - same auto-pull contract `gipity chat` uses on its
    // `filesChanged` flag. Skip in one-off mode (no local project to sync into).
    const pulledLocal = !!(res.data.outputFiles?.length && getConfigPath());
    if (pulledLocal) {
      await sync({ interactive: false, progress: opts.json ? undefined : createProgressReporter() });
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...res.data, filesSynced: pulledLocal }));
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
      if (res.data.outputFiles && res.data.outputFiles.length > 0) {
        console.log(`\nOutput files ${pulledLocal ? 'synced to this directory' : 'saved to project'}:`);
        for (const f of res.data.outputFiles) console.log(`${f}`);
      }
      if (res.data.exitCode !== 0) {
        // No "did you mean another language?" hint is needed: the language is now
        // always something the caller pinned, never a silent default we chose.
        process.exit(res.data.exitCode);
      }
    }
  }));
