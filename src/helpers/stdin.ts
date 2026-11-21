/**
 * Read a whole input stream (stdin by default) to EOF.
 *
 * Every CLI input that accepts `-` / `@-` reads through this one helper. The
 * earlier `readFileSync(0)` broke on piped input bigger than the pipe buffer
 * (64 KB on Linux): fd 0 is non-blocking when it's a pipe, so once the first
 * buffer was drained and the writer had not refilled it yet, the read threw
 * EAGAIN and the body came back empty ("No JSON on stdin"). Consuming the
 * stream asynchronously, chunk by chunk, waits for the writer and gets
 * everything up to EOF regardless of size.
 *
 * Returns '' for an interactive terminal (nothing is piped in).
 */
import type { Readable } from 'node:stream';

export async function readStreamToEnd(stream: Readable & { isTTY?: boolean } = process.stdin): Promise<string> {
  if (stream.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
