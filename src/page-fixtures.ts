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
