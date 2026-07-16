/**
 * Resolve a JSON request/input body from the CLI.
 *
 * A body can be given three ways, so large payloads (images, audio, docs -
 * the common case for jobs) don't have to fit in a shell argument:
 *   - inline JSON:   '{"foo":1}'
 *   - a file:        @path/to/body.json   (reads and parses the file)
 *   - stdin:         @-  or  -            (reads and parses stdin)
 *
 * The `@file` / stdin forms exist because a base64 image easily blows past
 * ARG_MAX ("Argument list too long") when passed inline. `readFileSync` on the
 * path sidesteps the shell argument entirely.
 */
import { readFileSync } from 'node:fs';

/** Read all of stdin synchronously (fd 0). Returns '' if stdin is a TTY. */
function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Read a `--file field=@path` (or `field=path`) spec, base64-encode the file's
 * bytes, and return `[field, base64]`. This is the ergonomic path for calling
 * an image / audio / document function end-to-end: instead of a manual
 * `base64 | grep | python json.dumps` dance to stuff a photo into a JSON body,
 * the CLI reads the file itself and encodes it. The leading `@` is optional
 * (accepted for symmetry with `--data @file`).
 */
export function readFileField(spec: string): [string, string] {
  const eq = spec.indexOf('=');
  if (eq === -1) {
    throw new Error(`Invalid --file '${spec}': expected field=@path (e.g. --file data=@receipt.png).`);
  }
  const field = spec.slice(0, eq).trim();
  let path = spec.slice(eq + 1);
  if (path.startsWith('@')) path = path.slice(1);
  if (!field) throw new Error(`Invalid --file '${spec}': missing field name before '='.`);
  if (!path) throw new Error(`Invalid --file '${spec}': missing file path after '='.`);
  try {
    return [field, readFileSync(path).toString('base64')];
  } catch (e) {
    throw new Error(`Cannot read --file '${path}': ${(e as Error).message}`);
  }
}

/**
 * Resolve a JSON body and merge in any `--file field=@path` attachments, each
 * base64-encoded under its field. `fileSpecs` is the repeatable `--file` list.
 * File attachments require an object body (they can't merge into an array or
 * scalar), which is the normal case for a function/job request.
 */
export function resolveBody(raw: string | undefined, fileSpecs?: string[]): unknown {
  const body = resolveJsonBody(raw);
  if (!fileSpecs || fileSpecs.length === 0) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('--file needs an object body to attach into (got a non-object JSON body).');
  }
  const obj = body as Record<string, unknown>;
  for (const spec of fileSpecs) {
    const [field, b64] = readFileField(spec);
    obj[field] = b64;
  }
  return obj;
}

/**
 * Turn a raw body argument into a parsed JSON value.
 * `raw` is the positional body or the `--data` value; undefined => `{}`.
 */
export function resolveJsonBody(raw: string | undefined): unknown {
  if (raw == null || raw === '') return {};

  let source: string;
  let origin: string;
  if (raw === '-' || raw === '@-') {
    source = readStdin();
    origin = 'stdin';
    if (source.trim() === '') {
      throw new Error('No JSON on stdin (pipe a body in, e.g. `cat body.json | gipity fn call foo -d -`).');
    }
  } else if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      source = readFileSync(path, 'utf-8');
    } catch (e) {
      throw new Error(`Cannot read body file '${path}': ${(e as Error).message}`);
    }
    origin = `file '${path}'`;
  } else {
    source = raw;
    origin = 'inline JSON';
  }

  try {
    return JSON.parse(source);
  } catch (e) {
    throw new Error(`Invalid JSON in ${origin}: ${(e as Error).message}`);
  }
}
