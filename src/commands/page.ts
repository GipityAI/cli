import { Command } from 'commander';
import { error as clrError, muted } from '../colors.js';
import { pageInspectCommand } from './page-inspect.js';
import { pageScreenshotCommand } from './page-screenshot.js';
import { pageEvalCommand } from './page-eval.js';
import { pageTestCommand } from './page-test.js';

// `page inspect | screenshot | test` each take a URL but no JS expression —
// `page eval` is the separate verb for running JS in page context. An agent
// reaching for `--eval` (or pasting an expression as an extra positional) gets
// commander's default unknown-option / too-many-arguments error, which names
// neither the right verb nor that eval is a sibling. Append a pointer so the
// fix is one read away instead of a multi-call detour through --help.
function suggestEvalVerb(cmd: Command): Command {
  cmd.configureOutput({
    writeErr: (str) => {
      process.stderr.write(clrError(str));
      const triedEvalFlag = /unknown option '--eval/.test(str);
      // The page URL is a positional, so it never follows a flag — that lets us
      // skip URL-valued global options like `--api-base <url>` when picking it.
      const argv = process.argv;
      const url = argv.find((a, i) => /^https?:\/\//.test(a) && !(argv[i - 1] ?? '').startsWith('-'));
      const pastedExpression =
        /too many arguments/.test(str) &&
        process.argv.some((a) => a !== url && /=>|\(\)|document\.|window\.|return\s/.test(a));
      if (triedEvalFlag || pastedExpression) {
        process.stderr.write(
          muted(`Did you mean: gipity page eval ${url ?? '<url>'} "<expression>"?\n`),
        );
      }
    },
  });
  return cmd;
}

// Parent namespace grouping the page/browser diagnostics under one command:
//   gipity page inspect | eval | screenshot | test
// Each subcommand is canonical for its capability; the namespace keeps the
// top-level surface lean and makes the siblings discoverable via `page --help`.
export const pageCommand = new Command('page')
  .description('Inspect, evaluate, screenshot, and multi-client test web pages (page inspect | eval | screenshot | test)')
  .addCommand(suggestEvalVerb(pageInspectCommand))
  .addCommand(pageEvalCommand)
  .addCommand(suggestEvalVerb(pageScreenshotCommand))
  .addCommand(suggestEvalVerb(pageTestCommand));

// No subcommand → show help instead of commander's terse error.
pageCommand.action(() => {
  pageCommand.help();
});
