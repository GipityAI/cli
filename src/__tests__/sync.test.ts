import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffManifest, formatDiff, type SyncChange } from '../sync.js';

const remoteFiles = [
  { path: 'src/index.html', size: 500, modified: '2024-01-01', type: 'file', guid: 'f1' },
  { path: 'src/app.js', size: 1200, modified: '2024-01-01', type: 'file', guid: 'f2' },
  { path: 'src/styles.css', size: 300, modified: '2024-01-01', type: 'file', guid: 'f3' },
  { path: 'src/', size: 0, modified: '2024-01-01', type: 'directory', guid: 'd1' },
];

describe('diffManifest — down', () => {
  it('detects added files (remote has, local lacks)', () => {
    const local = new Map<string, { size: number; modified: string }>();
    const changes = diffManifest(remoteFiles, local, 'down');
    const added = changes.filter(c => c.type === 'added');
    assert.equal(added.length, 3);
  });

  it('detects modified files (size mismatch)', () => {
    const local = new Map([
      ['src/index.html', { size: 999, modified: '2024-01-01' }],
      ['src/app.js', { size: 1200, modified: '2024-01-01' }],
      ['src/styles.css', { size: 300, modified: '2024-01-01' }],
    ]);
    const changes = diffManifest(remoteFiles, local, 'down');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'modified');
    assert.equal(changes[0].path, 'src/index.html');
  });

  it('detects deleted files (local has, remote lacks)', () => {
    const local = new Map([
      ['src/index.html', { size: 500, modified: '2024-01-01' }],
      ['src/app.js', { size: 1200, modified: '2024-01-01' }],
      ['src/styles.css', { size: 300, modified: '2024-01-01' }],
      ['src/old.js', { size: 100, modified: '2024-01-01' }],
    ]);
    const changes = diffManifest(remoteFiles, local, 'down');
    const deleted = changes.filter(c => c.type === 'deleted');
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].path, 'src/old.js');
  });

  it('returns empty when in sync', () => {
    const local = new Map([
      ['src/index.html', { size: 500, modified: '2024-01-01' }],
      ['src/app.js', { size: 1200, modified: '2024-01-01' }],
      ['src/styles.css', { size: 300, modified: '2024-01-01' }],
    ]);
    const changes = diffManifest(remoteFiles, local, 'down');
    assert.equal(changes.length, 0);
  });
});

describe('diffManifest — up', () => {
  it('detects locally added files', () => {
    const local = new Map([
      ['src/index.html', { size: 500, modified: '2024-01-01' }],
      ['src/app.js', { size: 1200, modified: '2024-01-01' }],
      ['src/styles.css', { size: 300, modified: '2024-01-01' }],
      ['src/new.js', { size: 200, modified: '2024-01-01' }],
    ]);
    const changes = diffManifest(remoteFiles, local, 'up');
    const added = changes.filter(c => c.type === 'added');
    assert.equal(added.length, 1);
    assert.equal(added[0].path, 'src/new.js');
  });

  it('detects locally deleted files', () => {
    const local = new Map([
      ['src/index.html', { size: 500, modified: '2024-01-01' }],
    ]);
    const changes = diffManifest(remoteFiles, local, 'up');
    const deleted = changes.filter(c => c.type === 'deleted');
    assert.equal(deleted.length, 2); // app.js and styles.css
  });
});

describe('formatDiff', () => {
  it('returns no changes message when empty', () => {
    assert.equal(formatDiff([], 'down'), 'No changes detected.');
  });

  it('formats changes with counts', () => {
    const changes: SyncChange[] = [
      { type: 'added', path: 'src/new.js', remoteSize: 100 },
      { type: 'modified', path: 'src/app.js', localSize: 1000, remoteSize: 1200 },
      { type: 'deleted', path: 'src/old.js', localSize: 50 },
    ];
    const output = formatDiff(changes, 'down');
    assert.ok(output.includes('3 changes'));
    assert.ok(output.includes('+ src/new.js'));
    assert.ok(output.includes('~ src/app.js'));
    assert.ok(output.includes('- src/old.js'));
  });
});
