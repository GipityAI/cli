import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeJwtExp, isBinaryFile, formatSize, formatAge, findWindowsTwinProject, wslPathToWindows } from '../utils.js';

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

describe('findWindowsTwinProject', () => {
  const { mkdtempSync, mkdirSync, rmSync } = fs;
  const { tmpdir } = os;
  const { join } = path;

  it('finds a same-named project under a Windows-style users base', () => {
    const base = mkdtempSync(join(tmpdir(), 'wsl-users-'));
    try {
      mkdirSync(join(base, 'steve', 'GipityProjects', 'myapp'), { recursive: true });
      mkdirSync(join(base, 'Public'), { recursive: true }); // pseudo-user, must be skipped
      const root = mkdtempSync(join(tmpdir(), 'linked-'));
      const twin = findWindowsTwinProject(join(root), base);
      assert.equal(twin, null); // root basename is random, no twin

      const linked = join(root, 'myapp');
      mkdirSync(linked);
      assert.equal(findWindowsTwinProject(linked, base), join(base, 'steve', 'GipityProjects', 'myapp'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('ignores the candidate when it IS the linked project (same realpath)', () => {
    const base = mkdtempSync(join(tmpdir(), 'wsl-users-'));
    try {
      const linked = join(base, 'steve', 'GipityProjects', 'onmount');
      mkdirSync(linked, { recursive: true });
      assert.equal(findWindowsTwinProject(linked, base), null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns null when the users base does not exist', () => {
    assert.equal(findWindowsTwinProject('/some/project', '/nonexistent/mnt/c/Users'), null);
  });
});

describe('wslPathToWindows', () => {
  it('converts /mnt/c paths to drive-letter form', () => {
    assert.equal(wslPathToWindows('/mnt/c/Users/steve/GipityProjects/app'), 'C:\\Users\\steve\\GipityProjects\\app');
  });
  it('leaves non-mount paths alone', () => {
    assert.equal(wslPathToWindows('/home/steve/app'), '/home/steve/app');
  });
});
