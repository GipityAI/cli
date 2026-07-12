/**
 * ImageBlockRewriter: base64 image blocks in tool_results become image_ref
 * blocks via an injected uploader (no network). Covers path mapping from
 * the paired tool_use, size gates, failure degradation (inline-keep vs
 * stub), and pass-through of everything that isn't a base64 image.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ImageBlockRewriter, type MediaUploader } from '../relay/media-upload.js';

// > MIN_UPLOAD_BYTES (4 KB) once base64-decoded.
const bigData = Buffer.alloc(8 * 1024, 3).toString('base64');
// < MIN_UPLOAD_BYTES — stays inline by design.
const tinyData = Buffer.from('tiny').toString('base64');

const imageBlock = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});

const toolUse = (id: string, filePath?: string) => ({
  kind: 'tool_use',
  tool_use_id: id,
  tool_name: 'Read',
  tool_input: filePath ? { file_path: filePath } : {},
});

const toolResult = (id: string, content: unknown[]) => ({
  kind: 'tool_result',
  tool_use_id: id,
  tool_name: 'Read',
  content,
});

function fakeUploader() {
  const calls: Array<{ convGuid: string; bytes: number; filename: string; mediaType: string; suggestedPath?: string }> = [];
  const upload: MediaUploader = async (convGuid, buf, opts) => {
    calls.push({ convGuid, bytes: buf.length, filename: opts.filename, mediaType: opts.mediaType, suggestedPath: opts.suggestedPath });
    return {
      guid: 'file-test1234',
      url: '/files/vfs/file-test1234',
      thumb_url: '/files/thumbnail/file-test1234',
      path: opts.suggestedPath ?? `.gipity/media/abcd_${opts.filename}`,
      width: 1280,
      height: 720,
      bytes: buf.length,
    };
  };
  return { calls, upload };
}

describe('ImageBlockRewriter', () => {
  it('rewrites a base64 image block to an image_ref', async () => {
    const { calls, upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    const out = await rw.rewrite([
      toolUse('t1', '/proj/screenshots/shot.png'),
      toolResult('t1', [{ type: 'text', text: 'read ok' }, imageBlock(bigData)]),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].filename, 'shot.png');
    assert.equal(calls[0].mediaType, 'image/png');

    const result = out[1] as any;
    assert.equal(result.content[0].type, 'text');           // non-image blocks pass through
    assert.deepEqual(result.content[1], {
      type: 'image_ref',
      url: '/files/vfs/file-test1234',
      thumb_url: '/files/thumbnail/file-test1234',
      media_type: 'image/png',
      path: '.gipity/media/abcd_shot.png',
      width: 1280,
      height: 720,
      bytes: 8 * 1024,
    });
  });

  it('maps an absolute Read path inside cwd to a project-relative suggested_path', async () => {
    const { calls, upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    rw.setCwd('/home/me/GipityProjects/app');
    await rw.rewrite([
      toolUse('t1', '/home/me/GipityProjects/app/screenshots/ss-a.png'),
      toolResult('t1', [imageBlock(bigData)]),
    ]);
    assert.equal(calls[0].suggestedPath, 'screenshots/ss-a.png');
  });

  it('omits suggested_path for reads outside the project root', async () => {
    const { calls, upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    rw.setCwd('/home/me/GipityProjects/app');
    await rw.rewrite([
      toolUse('t1', '/tmp/elsewhere.png'),
      toolResult('t1', [imageBlock(bigData)]),
    ]);
    assert.equal(calls[0].suggestedPath, undefined);
  });

  it('leaves tiny images inline (upload round-trip not worth it)', async () => {
    const { calls, upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    const out = await rw.rewrite([toolResult('t1', [imageBlock(tinyData)])]);
    assert.equal(calls.length, 0);
    assert.equal((out[0] as any).content[0].type, 'image');
  });

  it('keeps a small image inline when the upload fails', async () => {
    const failing: MediaUploader = async () => { throw new Error('server down'); };
    const warns: string[] = [];
    const rw = new ImageBlockRewriter('conv-x', (m) => warns.push(m), failing);
    const out = await rw.rewrite([toolResult('t1', [imageBlock(bigData)])]);
    assert.equal((out[0] as any).content[0].type, 'image'); // unchanged
    assert.equal(warns.length, 1);
  });

  it('stubs an oversize image when the upload fails (batch must not 400)', async () => {
    const failing: MediaUploader = async () => { throw new Error('server down'); };
    const rw = new ImageBlockRewriter('conv-x', undefined, failing);
    // >120K base64 chars would blow the server's 200 KB tool_result cap inline.
    const huge = Buffer.alloc(200 * 1024, 5).toString('base64');
    const out = await rw.rewrite([
      toolUse('t1', '/p/big-shot.png'),
      toolResult('t1', [imageBlock(huge)]),
    ]);
    const block = (out[1] as any).content[0];
    assert.equal(block.type, 'text');
    assert.match(block.text, /big-shot\.png .*omitted: upload failed/);
  });

  it('stubs an image above the server storage cap without attempting upload', async () => {
    const { calls, upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    const giant = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
    const out = await rw.rewrite([toolResult('t1', [imageBlock(giant)])]);
    assert.equal(calls.length, 0);
    assert.match((out[0] as any).content[0].text, /omitted: too large/);
  });

  it('passes through non-tool entries and string-content tool_results untouched', async () => {
    const { upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    const entries = [
      { kind: 'system', content: 'marker' },
      { kind: 'tool_result', tool_use_id: 't1', content: 'plain string output' },
      { kind: 'assistant', text: 'hi', blocks: [] },
    ];
    const out = await rw.rewrite(entries as any);
    assert.deepEqual(out, entries);
  });

  it('is idempotent: a rewritten batch has nothing left to upload on retry', async () => {
    const { calls, upload } = fakeUploader();
    const rw = new ImageBlockRewriter('conv-x', undefined, upload);
    const first = await rw.rewrite([toolResult('t1', [imageBlock(bigData)])]);
    const second = await rw.rewrite(first);
    assert.equal(calls.length, 1); // no second upload
    assert.deepEqual(second, first);
  });
});
