import { Command } from 'commander';
import { dirname, relative } from 'path';
import { post, ApiError } from '../api.js';
import { resolveProjectContext, getConfigPath } from '../config.js';
import { error as clrError, dim } from '../colors.js';
import { run } from '../helpers/index.js';

/** Real wall-clock ceiling enforced by the API gateway. Requests that run
 *  longer are killed gateway-side with a 504, regardless of the requested
 *  --timeout. Cap/validate against this so we never advertise a number the
 *  platform won't honor. */
const MAX_TIMEOUT_SECONDS = 10;

const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  bash: 'bash',
  sh: 'bash',
};

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
  .option('--timeout <seconds>', `Execution timeout in seconds (max ${MAX_TIMEOUT_SECONDS}, the gateway wall-clock cap)`, String(MAX_TIMEOUT_SECONDS))
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
    if (!isNaN(timeout) && timeout > MAX_TIMEOUT_SECONDS) {
      console.error(clrError(
        `sandbox runs are capped at ${MAX_TIMEOUT_SECONDS}s of wall-clock; ` +
        `--timeout ${timeout} cannot be honored — chunk the work`,
      ));
      process.exit(1);
    }
    const cwd = resolveRelativeCwd();

    type ExecResponse = {
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

    let res: ExecResponse;
    try {
      res = await post<ExecResponse>(`/projects/${config.projectGuid}/sandbox/execute`, {
        code,
        language,
        timeout: isNaN(timeout) ? MAX_TIMEOUT_SECONDS : timeout,
        input_files: opts.input,
        cwd,
      });
    } catch (err) {
      // The gateway kills over-long runs with a 504; surface the real limit
      // instead of the generic "Gateway Time-out".
      if (err instanceof ApiError && err.statusCode === 504) {
        throw new Error(`exceeded sandbox wall-clock limit of ${MAX_TIMEOUT_SECONDS}s`);
      }
      throw err;
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
