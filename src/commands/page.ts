import { Command } from 'commander';
import { pageInspectCommand } from './page-inspect.js';
import { pageScreenshotCommand } from './page-screenshot.js';
import { pageEvalCommand } from './page-eval.js';
import { pageTestCommand } from './page-test.js';
import { pageFetchCommand } from './page-fetch.js';

// Parent namespace grouping the page/browser diagnostics under one command:
//   gipity page inspect | eval | screenshot | test | fetch
// Each subcommand is canonical for its capability; the namespace keeps the
// top-level surface lean and makes the siblings discoverable via `page --help`.
// `inspect` is the rendered DOM (browser); `fetch` is the raw asset (plain HTTP).
export const pageCommand = new Command('page')
  .description('Inspect, evaluate, screenshot, multi-client test, and verify raw files of web pages (page inspect | eval | screenshot | test | fetch)')
  .addCommand(pageInspectCommand)
  .addCommand(pageEvalCommand)
  .addCommand(pageScreenshotCommand)
  .addCommand(pageTestCommand)
  .addCommand(pageFetchCommand);

// No subcommand → show help instead of commander's terse error.
pageCommand.action(() => {
  pageCommand.help();
});
