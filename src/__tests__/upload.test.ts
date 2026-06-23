import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, type Server } from 'http';
import { hashFile, guessMime, transferToS3 } from '../upload.js';

describe('guessMime', () => {
  it('detects common types from extension', () => {
    assert.equal(guessMime('foo.html'), 'text/html');
    assert.equal(guessMime('a/b/c.css'), 'text/css');
    assert.equal(guessMime('img.png'), 'image/png');
    assert.equal(guessMime('vid.mp4'), 'video/mp4');
    assert.equal(guessMime('doc.pdf'), 'application/pdf');
  });

  it('falls back to application/octet-stream for unknown', () => {
    assert.equal(guessMime('mystery'), 'application/octet-stream');
    assert.equal(guessMime('x.weirdext'), 'application/octet-stream');
  });

  it('is case-insensitive on extension', () => {
    assert.equal(guessMime('IMG.PNG'), 'image/png');
    assert.equal(guessMime('Doc.PDF'), 'application/pdf');
  });
});

describe('hashFile', () => {
  let tmp: string;

  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), 'gipity-upload-test-'));
  }

  it('returns SHA-256 + size for a small text file', async () => {
    tmp = makeTmp();
    try {
      const file = join(tmp, 'hello.txt');
      writeFileSync(file, 'hello world');
      const r = await hashFile(file);
      assert.equal(r.size, 11);
      // Known SHA-256 of "hello world"
      assert.equal(r.sha256, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns 0 size + empty-buf hash for an empty file', async () => {
    tmp = makeTmp();
    try {
      const file = join(tmp, 'empty');
      writeFileSync(file, '');
      const r = await hashFile(file);
      assert.equal(r.size, 0);
      // SHA-256 of empty input
      assert.equal(r.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles binary content with null bytes', async () => {
    tmp = makeTmp();
    try {
      const file = join(tmp, 'bin');
      const buf = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x42]);
      writeFileSync(file, buf);
      const r = await hashFile(file);
      assert.equal(r.size, 5);
      // Independent SHA-256 of those bytes
      const { createHash } = await import('crypto');
      const expected = createHash('sha256').update(buf).digest('hex');
      assert.equal(r.sha256, expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('streams correctly for a 1MB file', async () => {
    tmp = makeTmp();
    try {
      const file = join(tmp, 'big');
      const buf = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
      writeFileSync(file, buf);
      const r = await hashFile(file);
      assert.equal(r.size, 1024 * 1024);
      const { createHash } = await import('crypto');
      assert.equal(r.sha256, createHash('sha256').update(buf).digest('hex'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('transferToS3 single-part progress', () => {
  // A presigned-URL stand-in that drains the PUT body and returns an ETag.
  const startSink = (): Promise<{ server: Server; url: string }> =>
    new Promise(resolve => {
      const server = createServer((req, res) => {
        req.on('data', () => { /* drain so the upload stream keeps flowing */ });
        req.on('end', () => { res.setHeader('etag', '"abc123"'); res.end(); });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ server, url: `http://127.0.0.1:${addr.port}/put` });
      });
    });

  it('reports bytes incrementally during the PUT, summing to the file size', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gip-put-'));
    const { server, url } = await startSink();
    try {
      // Several read-stream chunks (highWaterMark is 64 KB) so progress is not
      // a single end-of-transfer jump.
      const size = 256 * 1024;
      const file = join(tmp, 'video.bin');
      writeFileSync(file, Buffer.alloc(size, 7));

      const deltas: number[] = [];
      const result = await transferToS3(
        file, size, 'application/octet-stream',
        { upload_guid: 'g', method: 'PUT', url, expires_in: 60 },
        { onBytes: d => deltas.push(d) },
      );

      assert.ok('etag' in result && result.etag === 'abc123');
      assert.ok(deltas.length > 1, `expected incremental progress, got ${deltas.length} call(s)`);
      assert.equal(deltas.reduce((a, b) => a + b, 0), size);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
