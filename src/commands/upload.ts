import { Command } from 'commander';
import { statSync } from 'fs';
import { basename } from 'path';
import { post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { transferToS3, guessMime, type ReadyInit } from '../upload.js';
import { formatSize } from '../utils.js';
import { success, muted, brand } from '../colors.js';
import { withSpinner } from '../progress.js';
import { run } from '../helpers/index.js';

interface InitResponse { data: ReadyInit }
interface CompleteResponse {
  data: {
    guid: string;
    name: string;
    size: number;
    content_type: string;
    url: string;
    is_public: boolean;
  };
}

// The app-uploads store (`/api/<guid>/uploads/*`) mints a DURABLE, worker-reachable
// URL the instant the file lands - no `gipity deploy` needed. That is the whole
// point of this command: it removes the deploy-a-fixture-then-delete-it dance an
// agent otherwise has to do to hand a job/function a real input file to fetch.
// (Uploading into the project tree with `gipity push` does NOT give a public URL
// until you deploy; this does.)
export const uploadCommand = new Command('upload')
  .description(`Upload a local file and print a durable, worker-reachable URL for it.

The URL works immediately - no \`gipity deploy\` - and any job or function can
fetch it. Use it to hand a GPU/CPU job a real input file when testing end-to-end:

  gipity upload song.mp3
  gipity job submit split-stems --data '{"audio_url":"<printed url>"}'

By default the file is PUBLIC: a plain \`media.gipity.ai\` CDN url that resolves
from anywhere, so a cloud worker can always fetch it. Pass --private for a
token-signed serve url instead (reachable only by holders of the url).`)
  .argument('<file>', 'Local file to upload')
  .option('--private', 'Store as a private token-signed serve URL instead of a public CDN url')
  .option('--content-type <mime>', 'Override the content type (default: detected from the file extension)')
  .option('--json', 'Output as JSON')
  .action((file: string, opts) => run('Upload', async () => {
    const { config } = await resolveProjectContext();

    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a regular file');
      size = st.size;
    } catch (err) {
      throw new Error(`can't read ${file}: ${(err as Error).message}`);
    }
    if (size === 0) throw new Error(`${file} is empty - nothing to upload.`);

    const filename = basename(file);
    const contentType = opts.contentType || guessMime(file);

    const doUpload = async (): Promise<CompleteResponse['data']> => {
      const init = await post<InitResponse>(`/api/${config.projectGuid}/uploads/init`, {
        filename,
        content_type: contentType,
        size,
        public: !opts.private,
      });
      const fields = await transferToS3(file, size, contentType, init.data);
      const completeBody: { upload_guid: string; parts?: Array<{ part_number: number; etag: string }> } = {
        upload_guid: init.data.upload_guid,
      };
      // Multipart completion needs the part etags; a single presigned PUT does not.
      if ('parts' in fields) completeBody.parts = fields.parts;
      const comp = await post<CompleteResponse>(`/api/${config.projectGuid}/uploads/complete`, completeBody);
      return comp.data;
    };

    const data = opts.json
      ? await doUpload()
      : await withSpinner(`Uploading ${filename} (${formatSize(size)})…`, doUpload, { done: null });

    if (opts.json) {
      console.log(JSON.stringify(data));
      return;
    }

    console.log(success(`Uploaded ${data.name} (${formatSize(data.size)})`));
    console.log(`  ${brand(data.url)}`);
    console.log(muted(`  Durable, worker-reachable URL - pass it straight to a job/function as an input URL.`));
    console.log(muted(`  ${data.is_public ? 'public (CDN)' : 'private (token-signed)'} · guid: ${data.guid}`));
  }));
