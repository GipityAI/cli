import { Command } from 'commander';
import { dirname, relative } from 'path';
import { post } from '../api.js';
import { resolveProjectContext, getConfigPath } from '../config.js';
import { sync } from '../sync.js';
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

    const res = await post<{
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
    }>(`/projects/${config.projectGuid}/sandbox/execute`, {
      code,
      language,
      timeout: isNaN(timeout) ? 30 : timeout,
      input_files: opts.input,
      cwd,
    });

    // Pull sandbox-written outputs down to the local cwd automatically. The
    // server has already mirrored them into the project (VFS) and handed back
    // the exact list, so honoring it here means files land locally without a
    // manual `gipity sync` - same auto-pull contract `gipity chat` uses on its
    // `filesChanged` flag. Skip in one-off mode (no local project to sync into).
    const pulledLocal = !!(res.data.outputFiles?.length && getConfigPath());
    if (pulledLocal) {
      await sync({ interactive: false });
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...res.data, filesSynced: pulledLocal }));
    } else {
      if (res.data.autoMirrorSkipped) {
        console.error(dim(`Note: ${res.data.autoMirrorSkipped.reason}`));
      }
      if (res.data.stdout) console.log(res.data.stdout);
      if (res.data.stderr) console.error(res.data.stderr);
      if (res.data.timedOut) console.error(`[Timed out after ${res.data.durationMs}ms]`);
      if (res.data.outputFiles && res.data.outputFiles.length > 0) {
        console.log(`\nOutput files ${pulledLocal ? 'synced to this directory' : 'saved to project'}:`);
        for (const f of res.data.outputFiles) console.log(`${f}`);
      }
      if (res.data.exitCode !== 0) process.exit(res.data.exitCode);
    }
  }));
