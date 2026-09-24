import { Command } from 'commander';
import { readFileSync, fstatSync } from 'fs';
import { post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { guessMime } from '../upload.js';
import { warning } from '../colors.js';
import { run } from '../helpers/index.js';
import { withSpinner } from '../progress.js';

interface AskResult {
  text: string;
  json?: unknown;
  model: string;
  input_tokens: number;
  output_tokens: number;
  truncated: boolean;
  credits_deducted?: number;
  remaining_balance?: number;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** True when stdin is piped or redirected (not a terminal, not /dev/null). */
function stdinIsPiped(): boolean {
  try {
    const st = fstatSync(0);
    return st.isFIFO() || st.isFile();
  } catch {
    return false;
  }
}

/** A --file's text. `-` is stdin, read only when asked for: many harnesses
 *  leave stdin as an open pipe that never closes, so reading it unasked would
 *  hang an agent's `gipity ask "..."` forever. */
function readTextFile(path: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e: any) {
    throw new Error(`can't read --file ${path} (${e.code || e.message}).`);
  }
}

function readImage(path: string): { data: string; mime_type: string; name: string } {
  const mime = guessMime(path);
  if (!IMAGE_TYPES.has(mime)) throw new Error(`--image ${path} is ${mime}; use a png, jpg, gif or webp.`);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e: any) {
    throw new Error(`can't read --image ${path} (${e.code || e.message}).`);
  }
  return { data: buf.toString('base64'), mime_type: mime, name: path.split('/').pop() || path };
}

/** The question, then each --file under its own header (stdin, `-`, with none). */
export function buildAskPrompt(words: string[], files: Array<{ path: string; content: string }>): string {
  const parts: string[] = [];
  if (words.length) parts.push(words.join(' '));
  for (const f of files) parts.push(f.path === '-' ? f.content.trimEnd() : `--- ${f.path} ---\n${f.content.trimEnd()}`);
  return parts.join('\n\n');
}

export const askCommand = new Command('ask')
  .description('Ask a model one question and print the answer: no chat history, no tools. Attach text with --file (- for stdin) or images with --image')
  .argument('[prompt...]', 'The question or instruction')
  .option('--file <path...>', 'Add a text file to the prompt (repeatable); - reads stdin')
  .option('--image <path...>', 'Attach an image: png, jpg, gif or webp (repeatable)')
  .option('--model <model>', 'Model id, alias (small, fast, medium, large, haiku, sonnet, opus, ...) or provider (openai, anthropic, gemini). Default: small')
  .option('--system <text>', 'Replace the default system prompt')
  .option('--schema <json>', 'Answer with a JSON value matching this JSON schema; prints the JSON')
  .option('--max-tokens <n>', 'Cap the answer length', (v) => parseInt(v, 10))
  .option('--json', 'Output the whole result (answer, model, tokens) as JSON')
  .addHelpText('after', `
Examples:
  gipity ask "what does HTTP 425 mean?"
  cat errors.log | gipity ask "group these by root cause" --file -
  gipity ask "summarize this" --file notes.md
  gipity ask "what's in this picture?" --image shot.png --model gemini
  gipity ask "extract the dates" --file mail.txt --schema '{"type":"array","items":{"type":"string"}}'
`)
  .action((words: string[], opts) => run('Ask', async () => {
    const paths = (opts.file as string[] | undefined) ?? [];
    // Nothing else to ask: take piped stdin as the whole prompt (`... | gipity ask`).
    if (!words.length && !paths.length && stdinIsPiped()) paths.push('-');
    const files = paths.map(path => ({ path, content: readTextFile(path) }));
    const prompt = buildAskPrompt(words, files);
    if (!prompt.trim()) throw new Error('Nothing to ask. Pass a question, add --file <path> (or --file - for stdin), or pipe the prompt in.');

    let schema: unknown;
    if (opts.schema !== undefined) {
      try {
        schema = JSON.parse(opts.schema);
      } catch {
        throw new Error('--schema must be JSON (a JSON schema, e.g. \'{"type":"object","properties":{"answer":{"type":"string"}}}\').');
      }
    }
    const images = ((opts.image as string[] | undefined) ?? []).map(readImage);

    const { config } = await resolveProjectContext();
    const body: Record<string, unknown> = { prompt };
    if (opts.model) body.model = opts.model;
    if (opts.system) body.system = opts.system;
    if (images.length) body.images = images;
    if (schema !== undefined) body.schema = schema;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    const call = () => post<AskResult>(`/projects/${config.projectGuid}/generate/text`, body);
    const result = opts.json || !process.stderr.isTTY ? await call() : await withSpinner('Thinking...', call, { done: null });

    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }
    if (result.truncated) console.error(warning(`The answer hit the length limit and is cut off. Raise --max-tokens or ask for less.`));
    console.log(schema !== undefined ? JSON.stringify(result.json, null, 2) : result.text.trim());
  }));
