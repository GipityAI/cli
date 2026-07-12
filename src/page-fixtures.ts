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

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { post, del } from './api.js';
import { guessMime } from './upload.js';

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
export async function uploadPublicFixture(projectGuid: string, localPath: string): Promise<HostedFixture> {
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
  return uploadPublicFixture(projectGuid, localPath);
}
