import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwtExp, isBinaryFile, formatSize, formatAge } from '../utils.js';

describe('decodeJwtExp', () => {
  it('extracts exp from a valid JWT', () => {
    // Header: {"alg":"HS256"}, Payload: {"exp":1700000000}, Signature: fake
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const payload = Buffer.from('{"exp":1700000000}').toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    assert.equal(decodeJwtExp(token), 1700000000);
  });

  it('returns null for malformed token', () => {
    assert.equal(decodeJwtExp('not.a.jwt'), null);
    assert.equal(decodeJwtExp(''), null);
    assert.equal(decodeJwtExp('onlyone'), null);
  });

  it('returns null when exp is missing', () => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const payload = Buffer.from('{"sub":"user"}').toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    assert.equal(decodeJwtExp(token), null);
  });
});

describe('isBinaryFile', () => {
  it('detects binary files (null bytes)', () => {
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]);
    assert.equal(isBinaryFile(buf), true);
  });

  it('detects text files', () => {
    const buf = Buffer.from('Hello, world!', 'utf-8');
    assert.equal(isBinaryFile(buf), false);
  });

  it('handles empty buffer', () => {
    assert.equal(isBinaryFile(Buffer.alloc(0)), false);
  });
});

describe('formatSize', () => {
  it('formats bytes', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(1023), '1023 B');
  });

  it('formats kilobytes', () => {
    assert.equal(formatSize(1024), '1.0 KB');
    assert.equal(formatSize(1536), '1.5 KB');
  });

  it('formats megabytes', () => {
    assert.equal(formatSize(1048576), '1.0 MB');
    assert.equal(formatSize(2621440), '2.5 MB');
  });
});

describe('formatAge', () => {
  it('returns "just now" for recent timestamps', () => {
    assert.equal(formatAge(new Date().toISOString()), 'just now');
  });

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.equal(formatAge(fiveMinAgo), '5m ago');
  });

  it('returns hours ago', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    assert.equal(formatAge(threeHoursAgo), '3h ago');
  });

  it('returns days ago', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(formatAge(twoDaysAgo), '2d ago');
  });
});
