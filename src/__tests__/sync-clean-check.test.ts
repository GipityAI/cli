import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync, appendFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// isLocalTreeClean() gates the pre-action sync skip (deploy on a clean tree
// no longer pays a sync round trip). Its contract: return true ONLY when the
// local tree provably matches the baseline; any doubt must return false so
// the caller falls back to a real sync(). These tests pin every edge that
// could otherwise silently skip a needed upload.

const originalCwd = process.cwd();
let tempProject: string;

/** Build a baseline whose entries mirror the CURRENT stat of each file on
 *  disk, exactly the state a completed sync leaves behind. */
async function writeMatchingBaseline(files: string[], opts: { lastFullSync?: string | null } = {}): Promise<void> {
  const { writeBaseline } = await import('../sync.js');
  const entries: Record<string, { size: number; mtime: string; sha256: string; serverVersion: number }> = {};
  for (const rel of files) {
    const st = statSync(join(tempProject, rel));
    entries[rel] = { size: st.size, mtime: st.mtime.toISOString(), sha256: `sha-${rel}`, serverVersion: 1 };
  }
  writeBaseline({
    projectGuid: 'p_cleanchk',
    files: entries,
    lastFullSync: opts.lastFullSync === undefined ? new Date().toISOString() : opts.lastFullSync,
  });
}

async function cleanCheck(): Promise<boolean> {
  const { clearConfigCache } = await import('../config.js');
  clearConfigCache();
  const { isLocalTreeClean } = await import('../sync.js');
  return isLocalTreeClean();
}

before(() => {
  tempProject = mkdtempSync(join(tmpdir(), 'gipity-cleanchk-'));
  process.chdir(tempProject);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tempProject, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(tempProject, '.gipity'), { recursive: true, force: true });
  rmSync(join(tempProject, 'src'), { recursive: true, force: true });
  rmSync(join(tempProject, '.gipityignore'), { force: true });
  writeFileSync(join(tempProject, '.gipity.json'), JSON.stringify({ projectGuid: 'p_cleanchk' }));
  mkdirSync(join(tempProject, 'src'), { recursive: true });
  writeFileSync(join(tempProject, 'src', 'index.html'), '<h1>hello</h1>');
  writeFileSync(join(tempProject, 'src', 'app.js'), 'console.log(1)');
});

describe('isLocalTreeClean', () => {
  it('returns false when the project has never synced (no baseline)', async () => {
    assert.equal(await cleanCheck(), false);
  });

  it('returns false when the baseline exists but lastFullSync is null', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js'], { lastFullSync: null });
    assert.equal(await cleanCheck(), false);
  });

  it('returns true when every file matches the baseline by size+mtime', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    assert.equal(await cleanCheck(), true);
  });

  it('returns false when a new file is dropped into the tree (no hook involved)', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    writeFileSync(join(tempProject, 'src', 'dropped-in.css'), 'body{}');
    assert.equal(await cleanCheck(), false);
  });

  it('returns false when a file is edited (size change)', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    appendFileSync(join(tempProject, 'src', 'app.js'), '\nconsole.log(2)');
    assert.equal(await cleanCheck(), false);
  });

  it('returns false on a bare mtime touch even when content is identical (conservative)', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    const future = new Date(Date.now() + 5000);
    utimesSync(join(tempProject, 'src', 'app.js'), future, future);
    assert.equal(await cleanCheck(), false);
  });

  it('returns false when a baseline file was deleted locally (pending deletion must sync)', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    unlinkSync(join(tempProject, 'src', 'app.js'));
    assert.equal(await cleanCheck(), false);
  });

  it('returns false when a .gipityignore newly hides a baseline file (ignore semantics changed)', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    writeFileSync(join(tempProject, '.gipityignore'), 'src/app.js\n');
    assert.equal(await cleanCheck(), false);
  });

  it('returns false when the baseline file is corrupt JSON', async () => {
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    writeFileSync(join(tempProject, '.gipity', 'sync-state.json'), '{not json');
    assert.equal(await cleanCheck(), false);
  });

  it('matches the full sync engine on the same-size-same-mtime blind spot (no NEW hole)', async () => {
    // Diabolic case: content replaced with the SAME byte count and the mtime
    // deliberately restored (cp -p / tar --preserve). isLocalTreeClean reads
    // this as clean — but so does a full sync(): walkLocal reuses the cached
    // baseline hash whenever size+mtime match, so the planner would classify
    // the file unchanged and skip the upload too. The skip therefore adds no
    // failure mode the sync engine didn't already have; this test pins that
    // equivalence so a future walkLocal change (e.g. always rehash) makes it
    // fail loudly and forces isLocalTreeClean to be revisited in kind.
    await writeMatchingBaseline(['src/index.html', 'src/app.js']);
    const target = join(tempProject, 'src', 'app.js');
    const st = statSync(target);
    writeFileSync(target, 'console.log(9)'); // same length as 'console.log(1)'
    utimesSync(target, st.atime, st.mtime);  // restore mtime

    assert.equal(await cleanCheck(), true, 'skip path reads it as clean');

    const { walkLocal, readBaseline } = await import('../sync.js');
    const baseline = readBaseline('p_cleanchk');
    const local = walkLocal(tempProject, [], baseline.files);
    assert.equal(
      local.get('src/app.js')?.sha256,
      baseline.files['src/app.js'].sha256,
      'full sync would ALSO reuse the stale cached hash and skip this file',
    );
  });
});
