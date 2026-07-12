// Host a local file as a public asset so a `gipity page eval` can fetch it
// in-page, then delete it afterwards. The eval body runs inside the browser and
// can only receive bulk/binary data over HTTP (the eval source itself is capped
// and goes through the OS argv limit), so to verify a render/parse path against
// a real fixture we upload it to the app's public file store (served from
// media.gipity.ai with permissive CORS) and hand the eval a URL to fetch.
//
// Uses the same presigned init -> PUT -> complete flow the app file-upload
// service exposes, with `public: true`. Cleanup goes through the matching
// DELETE /api/:appGuid/uploads/:guid, which removes the public object too.

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { basename, resolve, relative, join } from 'node:path';
import { post, del } from './api.js';
import { getProjectRoot } from './config.js';
import { guessMime } from './upload.js';

/** Dirs a hand-made asset is never in, and that are expensive to walk. */
const FIND_SKIP = new Set(['node_modules', '.git', '.gipity', 'dist', 'build', '.next', 'coverage']);

/** Find files named `name` anywhere under `root` (breadth-first, bounded). */
function findByBasename(root: string, name: string, limit = 3): string[] {
  const hits: string[] = [];
  const queue = [root];
  let visited = 0;
  while (queue.length && hits.length < limit && visited < 500) {
    const dir = queue.shift()!;
    visited++;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!FIND_SKIP.has(e.name)) queue.push(join(dir, e.name));
      } else if (e.name === name && hits.length < limit) {
        hits.push(join(dir, e.name));
      }
    }
  }
  return hits;
}

/** Every `page` flag that takes a local file resolves it against the CURRENT
 *  DIRECTORY, and a bare ENOENT from deep inside the upload path ("stat
 *  './tmp/fist.jpg'") tells the caller nothing about where we looked or where
 *  the file actually is. That costs an ls/find round-trip every time a file was
 *  written somewhere other than where the caller assumed - which is exactly what
 *  happens after a `cd` that failed, or a `gipity generate` run from a different
 *  directory. So: name the absolute path we tried, the directory it was resolved
 *  against, and - when a file with that basename exists elsewhere in the project
 *  - the path that would have worked. Recovery becomes copy-paste, not a search. */
export function assertLocalAsset(flag: string, localPath: string): void {
  const abs = resolve(localPath);
  if (existsSync(abs)) return;

  const root = getProjectRoot() ?? process.cwd();
  const elsewhere = findByBasename(root, basename(localPath)).filter(p => p !== abs);
  const found = elsewhere.length
    ? `\nThat file DOES exist here — pass this path instead:\n${elsewhere.map(p => `  ${flag} ${relative(process.cwd(), p) || p}`).join('\n')}`
    : `\nNothing named "${basename(localPath)}" under ${root} either. Generate a frame with \`gipity generate image "<description>" -o ${localPath}\`, or check the path.`;

  throw new Error(
    `${flag} ${localPath}: no such file — looked for ${abs} (relative paths resolve against the current directory, ${process.cwd()}).${found}`,
  );
}

export interface HostedFixture {
  /** Upload guid - the handle for deletion. */
  guid: string;
  /** Public media.gipity.ai URL the page can fetch. */
  url: string;
  /** Original file basename - the key under the `fixtures` map in the eval. */
  name: string;
  /** Local path uploaded (for messages). */
  localPath: string;
}

/** Upload a local file to the app's public file store and return its URL. */
export async function uploadPublicFixture(projectGuid: string, localPath: string, flag = '--fixture'): Promise<HostedFixture> {
  assertLocalAsset(flag, localPath);
  const name = basename(localPath);
  const size = statSync(localPath).size;
  const contentType = guessMime(localPath);

  const init = await post<{ data: { upload_guid: string; method: string; url?: string } }>(
    `/api/${projectGuid}/uploads/init`,
    { filename: name, content_type: contentType, size, public: true },
  );
  // Fixtures use the single-part path; a multipart fixture would be unusually
  // large for a verification asset, so steer the caller to a smaller file.
  if (init.data.method !== 'PUT' || !init.data.url) {
    throw new Error(`fixture "${name}" is too large to host as a verification asset (${size} bytes)`);
  }

  const res = await fetch(init.data.url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: readFileSync(localPath),
  });
  if (!res.ok) {
    throw new Error(`upload of fixture "${name}" failed: ${res.status} ${res.statusText}`);
  }

  const done = await post<{ data: { guid: string; url: string } }>(
    `/api/${projectGuid}/uploads/complete`,
    { upload_guid: init.data.upload_guid },
  );
  return { guid: done.data.guid, url: done.data.url, name, localPath };
}

/** Delete a hosted fixture (public object + VFS node). */
export async function deleteFixture(projectGuid: string, guid: string): Promise<void> {
  await del(`/api/${projectGuid}/uploads/${guid}`);
}

// ── camera feed ─────────────────────────────────────────────────────────────
// A headless browser has no webcam, so a vision app (MediaPipe, YOLOX, any
// getUserMedia consumer) can't be exercised at all: getUserMedia rejects, the
// app shows its no-camera state, and the code path the user actually cares
// about never runs. `--fake-media` alone only fixes the rejection — Chrome's
// built-in synthetic device is a rolling test pattern, so a gesture/pose/object
// model still sees nothing recognizable and every agent ends up stubbing the
// model's own output to test around it.
//
// --camera closes that: host a real image/video and let the browser play it as
// the webcam's frames, so the app's REAL pipeline (frames → model → app logic)
// runs headlessly on input you control. Hosting reuses the fixture path above;
// the browser side (fetch the file, feed it to Chrome's fake capture device)
// is the server's job — the CLI just names the file and hands over its URL.

/** Container formats Chrome's fake video-capture device can be fed from, plus
 *  the still-image types the server transcodes into a looping single-frame
 *  feed. Anything else is rejected here (fast, local) rather than after an
 *  upload + a browser launch. */
const CAMERA_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.y4m', '.mjpeg'];

/** Validate a --camera path before uploading it. Throws with the accepted list
 *  and the in-platform way to produce a frame, so a wrong file type costs one
 *  local error instead of an upload plus an opaque browser failure. */
export function assertCameraFile(localPath: string): void {
  assertLocalAsset('--camera', localPath);
  const ext = localPath.slice(localPath.lastIndexOf('.')).toLowerCase();
  if (CAMERA_EXTS.includes(ext)) return;
  throw new Error(
    `--camera ${basename(localPath)}: unsupported file type "${ext || '(none)'}" — the camera feed must be an image or video (${CAMERA_EXTS.join(', ')}).\n` +
    `A still image is played as a looping single-frame feed, which is what a gesture/pose/object model needs.\n` +
    `No frame to hand? Generate one: gipity generate image "a hand making a closed fist, palm to camera, plain background"`,
  );
}

/** Host a local image/video as the browser's webcam feed. Same public-upload
 *  path as a fixture (so it is fetchable from the browser container and is
 *  deleted the same way), validated first. */
export async function uploadCameraFeed(projectGuid: string, localPath: string): Promise<HostedFixture> {
  assertCameraFile(localPath);
  return uploadPublicFixture(projectGuid, localPath, '--camera');
}
