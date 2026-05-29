import { Command } from 'commander';
import { pageInspectCommand } from './page-inspect.js';
import { pageScreenshotCommand } from './page-screenshot.js';
import { pageEvalCommand } from './page-eval.js';

// Parent namespace grouping the page/browser diagnostics under one command:
//   gipity page inspect | eval | screenshot
// Each subcommand is canonical for its capability; the namespace keeps the
// top-level surface lean and makes the siblings discoverable via `page --help`.
export const pageCommand = new Command('page')
  .description('Inspect, evaluate, and screenshot web pages (page inspect | eval | screenshot)')
  .addCommand(pageInspectCommand)
  .addCommand(pageEvalCommand)
  .addCommand(pageScreenshotCommand);

// No subcommand → show help instead of commander's terse error.
pageCommand.action(() => {
  pageCommand.help();
});
