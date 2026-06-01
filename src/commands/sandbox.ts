import { Command } from 'commander';
import { dirname, relative } from 'path';
import { post, ApiError } from '../api.js';
import { resolveProjectContext, getConfigPath } from '../config.js';
import { error as clrError, dim } from '../colors.js';
import { run } from '../helpers/index.js';

const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  bash: 'bash',
  sh: 'bash',
};

type SandboxExecResult = {
  data: {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    outputFiles?: string[];
    mirroredCount?: number;
    autoMirrorSkipped?: { reason: string; totalBytes: number };
  };
};

/** Server emits this when every container is occupied. Transient + retryable,
 *  not a real execution failure. */
const BUSY_RE = /all containers busy/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isAllContainersBusy(res: SandboxExecResult): boolean {
  return res.data.exitCode !== 0 && BUSY_RE.test(res.data.stderr ?? '');
}

/** POST the sandbox execute request, retrying with exponential backoff (1s,
 *  doubling, capped at 8s) while all containers are busy, up to `budgetMs`.
 *  Returns null if still busy at the deadline. Non-busy errors propagate. */
async function executeWithBackoff(
  path: string, body: unknown, budgetMs: number, quiet: boolean,
): Promise<SandboxExecResult | null> {
  const deadline = Date.now() + budgetMs;
  let backoffMs = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await post<SandboxExecResult>(path, body);
      if (!isAllContainersBusy(res)) return res;
    } catch (err) {
      if (!(err instanceof ApiError && BUSY_RE.test(err.message))) throw err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const delay = Math.min(backoffMs, remaining);
    if (!quiet) {
      console.error(dim(`All sandbox containers busy; retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt})...`));
    }
    await sleep(delay);
    backoffMs = Math.min(backoffMs * 2, 8000);
  }
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
  .command('run <code>')
  .description('Run code')
  .option('--language <language>', 'Language: js, py, or bash', 'js')
  .option('--timeout <seconds>', 'Execution timeout in seconds', '30')
  .option('--wait <seconds>', 'Max seconds to wait/back off for a free container when all are busy', '60')
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

Examples:

  # Auto-mirror: code sees the whole project at /work/
  $ gipity sandbox run --language bash \\
      "cwebp -q 82 src/images/elephant.png -o src/images/elephant.webp"

  # Python reading a project CSV (auto-mirror)
  $ gipity sandbox run --language python \\
      "import pandas as pd; print(pd.read_csv('data/sales.csv').describe())"

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
  .action((code: string, opts) => run('Sandbox', async () => {
    const { config } = await resolveProjectContext();
    const language = LANG_MAP[opts.language] || opts.language;

    if (!['javascript', 'python', 'bash'].includes(language)) {
      console.error(clrError(`Invalid language: ${opts.language}. Use: js, py, or bash`));
      process.exit(1);
    }

    const timeout = parseInt(opts.timeout, 10);
    const cwd = resolveRelativeCwd();

    const waitSeconds = parseInt(opts.wait, 10);
    const waitBudgetMs = (isNaN(waitSeconds) ? 60 : Math.max(0, waitSeconds)) * 1000;

    const res = await executeWithBackoff(
      `/projects/${config.projectGuid}/sandbox/execute`,
      {
        code,
        language,
        timeout: isNaN(timeout) ? 30 : timeout,
        input_files: opts.input,
        cwd,
      },
      waitBudgetMs,
      !!opts.json,
    );

    if (!res) {
      console.error(clrError(
        'All sandbox containers are busy. This is transient - re-run the same command shortly, '
        + 'or pass --wait <seconds> to wait longer for a free container.',
      ));
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      if (res.data.autoMirrorSkipped) {
        console.error(dim(`Note: ${res.data.autoMirrorSkipped.reason}`));
      }
      if (res.data.stdout) console.log(res.data.stdout);
      if (res.data.stderr) console.error(res.data.stderr);
      if (res.data.timedOut) console.error(`[Timed out after ${res.data.durationMs}ms]`);
      if (res.data.outputFiles && res.data.outputFiles.length > 0) {
        console.log(`\nOutput files saved to project:`);
        for (const f of res.data.outputFiles) console.log(`  ${f}`);
      }
      if (res.data.exitCode !== 0) process.exit(res.data.exitCode);
    }
  }));
