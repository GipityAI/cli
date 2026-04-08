import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError } from '../colors.js';

const LANG_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  bash: 'bash',
  sh: 'bash',
};

export const sandboxCommand = new Command('sandbox')
  .description('Execute code in Gipity sandbox');

sandboxCommand
  .command('run <code>')
  .description('Run code in sandbox')
  .option('--lang <language>', 'Language: js, py, or bash', 'js')
  .option('--timeout <seconds>', 'Execution timeout in seconds', '30')
  .option('--json', 'Output as JSON')
  .action(async (code: string, opts) => {
    try {
      const config = requireConfig();
      const language = LANG_MAP[opts.lang] || opts.lang;

      if (!['javascript', 'python', 'bash'].includes(language)) {
        console.error(clrError(`Invalid language: ${opts.lang}. Use: js, py, or bash`));
        process.exit(1);
      }

      const timeout = parseInt(opts.timeout, 10);

      const res = await post<{
        data: {
          exitCode: number;
          stdout: string;
          stderr: string;
          durationMs: number;
          timedOut: boolean;
        };
      }>(`/projects/${config.projectGuid}/sandbox/execute`, {
        code,
        language,
        timeout: isNaN(timeout) ? 30 : timeout,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.stdout) console.log(res.data.stdout);
        if (res.data.stderr) console.error(res.data.stderr);
        if (res.data.timedOut) console.error(`[Timed out after ${res.data.durationMs}ms]`);
        if (res.data.exitCode !== 0) process.exit(res.data.exitCode);
      }
    } catch (err: any) {
      console.error(clrError(`Sandbox failed: ${err.message}`));
      process.exit(1);
    }
  });
