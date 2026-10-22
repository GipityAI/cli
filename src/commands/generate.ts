import { Command, Option } from 'commander';
import { post, LONG_REQUEST_TIMEOUT_MS } from '../api.js';
import { resolveProjectContext, getConfigPath } from '../config.js';
import { pushFile } from '../sync.js';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve as resolvePath, dirname, relative, isAbsolute, basename } from 'path';
import { error as clrError, success, muted } from '../colors.js';
import { printCommandError } from '../helpers/command.js';
import { withSpinner } from '../progress.js';
import { guessMime } from '../upload.js';
import {
  addGenerationSubcommands, isQueuedModel, submitGenerations, waitForGenerations, statusText, type Generation,
} from './generate-async.js';
import {
  IMAGE_MODELS_TABLE, IMAGE_PROVIDER_IDS, IMAGE_QUALITY_IDS, IMAGE_TIER_ALIASES_DOC, IMAGE_TIER_ALIAS_IDS,
  IMAGE_GEMINI_ASPECT_RATIO_IDS, IMAGE_GEMINI_SIZE_IDS,
  VIDEO_MODEL_IDS, VIDEO_MODELS_TABLE, VIDEO_ASPECT_RATIOS, VIDEO_ASPECT_RATIO_IDS, VIDEO_RESOLUTION_IDS,
  TTS_PROVIDER_IDS, TTS_PROVIDER_DESCRIPTIONS, GEMINI_TTS_VOICES_DOC,
} from '../provider-docs.js';

interface GenerateResult {
  url: string;
  content_type: string;
  model: string;
  provider: string;
  size_bytes: number;
  seed?: number;
  /** Real pixel size of a generated image (image only). */
  width?: number;
  height?: number;
  /** Set when the image couldn't match the requested size (Gemini tiers). */
  note?: string;
  /** Media length in seconds - present for video/sound/music, absent for image/speech. */
  duration_seconds?: number;
  /** Present only when the operation actually cost credits; when present,
   *  remaining_balance is the real post-deduction balance. */
  credits_deducted?: number;
  remaining_balance?: number;
}

// ── Metrics output ─────────────────────────────────────────────────────
// Every subcommand reports what happened the same way: a headline naming the
// model, then one metric per line (labels right-aligned into a scannable
// column), then the saved path. Agents get the same fields via --json.

interface Metric { label: string; value: string }

function printMetrics(metrics: Array<Metric | null>): void {
  const rows = metrics.filter((m): m is Metric => m !== null);
  const width = Math.max(...rows.map((m) => m.label.length));
  for (const m of rows) {
    console.log(`  ${muted(`${m.label.padStart(width)}:`)} ${m.value}`);
  }
}

function fmtSeconds(s: number): string {
  if (s >= 60) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)}s`;
}

/** The standard metric rows, in a fixed order so every subcommand reads the
 *  same: duration, size, time, speed, credits. Rows whose data is missing
 *  (image has no duration; free ops have no credits) are skipped. */
function generationMetrics(result: GenerateResult, elapsedSeconds: number): Array<Metric | null> {
  // ffmpeg-style realtime multiple: media seconds produced per wall-clock
  // second. Generation is slower than playback, so expect values below 1x.
  const speed = result.duration_seconds !== undefined && elapsedSeconds > 0
    ? result.duration_seconds / elapsedSeconds : undefined;
  return [
    result.duration_seconds !== undefined
      ? { label: 'duration', value: `${fmtSeconds(result.duration_seconds)} clip` } : null,
    { label: 'size', value: `${Math.round(result.size_bytes / 1024)}KB` },
    { label: 'time', value: fmtSeconds(elapsedSeconds) },
    speed !== undefined
      ? { label: 'speed', value: `${speed >= 1 ? Math.round(speed * 10) / 10 : Math.round(speed * 100) / 100}x realtime` } : null,
    result.credits_deducted !== undefined
      ? { label: 'credits', value: `${result.credits_deducted.toLocaleString('en-US')} (${result.remaining_balance!.toLocaleString('en-US')} remaining)` } : null,
  ];
}

/** JSON-mode result: the server fields plus how long generation took and
 *  where the file landed. */
function jsonResult(result: GenerateResult, elapsedSeconds: number, savedPath: string): string {
  return JSON.stringify({ ...result, generation_seconds: Math.round(elapsedSeconds * 10) / 10, saved: savedPath });
}

/** Download a URL and save to a local file, then push it up to the project so
 *  the cloud (and anything that mirrors it) immediately matches local disk.
 *  Returns the absolute path written, so callers can report where it landed.
 *
 *  The push matters because generated media is written straight to disk with
 *  writeFileSync, which does NOT trip the editor's file-sync hook the way an
 *  agent's own file write does. Without it the file is local-only until the
 *  next `gipity sync`, so `gipity sandbox run` - which mirrors the *server* -
 *  can't see a just-generated image to convert/optimize it. Pushing here closes
 *  that gap so the "sandbox auto-mirrors the project" contract holds right after
 *  generation. Best-effort: the local save already succeeded, so a push failure
 *  only warns and points at `gipity sync`. */
async function downloadFile(url: string, filename: string, explicit: boolean): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // An explicit `-o` path is a name the caller has committed to and will chain
  // the NEXT command against (`--input src.png`, `page eval --camera src.png`),
  // so the saved path MUST equal what was asked - a predictable path is worth
  // more than a tidy extension. The model's output format is non-deterministic
  // (BFL's "png" request comes back as JPEG), so renaming to match the bytes
  // moves the file out from under the caller's already-written second command:
  // that is the "saved as .jpg, retry with the right path" wasted turn. Honour
  // the request; every downstream consumer (browsers, image/video tools, the
  // edit + camera services) sniffs the bytes, not the extension, so a jpg-in-a-
  // .png plays and edits fine. For the auto-generated default there is no
  // committed path, so there we DO name the file after its real bytes.
  const outPath = explicit ? filename : correctExtension(filename, buffer);
  if (explicit) noteFormatMismatch(filename, buffer);
  ensureOutputDir(outPath);
  writeFileSync(outPath, buffer);
  const savedPath = resolvePath(outPath);
  await pushGenerated(savedPath);
  return savedPath;
}

/** What these bytes ACTUALLY are, by magic number — the only trustworthy source.
 *  A provider hands back whatever its model produced (BFL's "png" request comes
 *  back as JPEG), so neither the caller's -o extension nor the response's
 *  content_type describes the file on disk. */
function sniffExt(buf: Buffer): string | undefined {
  // subarray past the end yields a short string, so every compare below is
  // length-safe on its own — no blanket minimum (which would skip the check
  // entirely on a small file and hand back the misnamed path).
  const ascii = (start: number, end: number) => buf.subarray(start, end).toString('latin1');
  if (buf.length < 4) return undefined;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  return undefined;
}

/** Extensions that name the same format, so a .jpeg holding JPEG bytes is right. */
const EXT_ALIASES: Record<string, string> = { jpeg: 'jpg', htm: 'html', yml: 'yaml' };
const canonicalExt = (ext: string) => EXT_ALIASES[ext] ?? ext;

/** The format's name, for the note — "JPEG", not the "JPG" of its extension. */
const formatName = (ext: string) => (canonicalExt(ext) === 'jpg' ? 'JPEG' : ext.toUpperCase());

/** Save under an extension that matches the bytes. A file whose extension lies
 *  about its format is not a cosmetic problem: `page eval --camera` validates and
 *  dispatches on the extension, image tools and browsers sniff it, and an agent
 *  that Reads a "*.png" full of JPEG bytes has to stop and work out which one is
 *  lying. The caller's -o path is a request, not a fact — honour its directory and
 *  stem, and let the bytes name the format. */
function correctExtension(filename: string, buf: Buffer): string {
  const actual = sniffExt(buf);
  if (!actual) return filename; // unrecognized bytes: nothing better to say
  const dot = filename.lastIndexOf('.');
  const asked = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (canonicalExt(asked) === actual) return filename;

  const corrected = `${dot > 0 ? filename.slice(0, dot) : filename}.${actual}`;
  console.error(muted(
    `Note: the model returned ${formatName(actual)}, not ${asked ? formatName(asked) : 'the requested format'}: `
    + `saving as ${corrected} so the extension matches the actual bytes.`,
  ));
  return corrected;
}

/** When the caller committed to an explicit `-o` path we save to it verbatim
 *  (see downloadFile), but the model's format may not match the extension. Say
 *  so, and say plainly that the file is at the requested path — so an agent that
 *  reads this note does NOT go change the path its already-queued next command
 *  points at (that "retry with .jpg" turn is the whole bug we're closing). */
function noteFormatMismatch(filename: string, buf: Buffer): void {
  const actual = sniffExt(buf);
  if (!actual) return;
  const dot = filename.lastIndexOf('.');
  const asked = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (!asked || canonicalExt(asked) === actual) return;
  console.error(muted(
    `Note: ${basename(filename)} holds ${formatName(actual)} bytes though its name ends .${asked}: `
    + `that's fine (browsers and image/video/edit tools sniff the bytes, not the name). `
    + `Saved at the exact path you requested; reference it as-is.`,
  ));
}

/** Create the parent directory of an -o path, so `-o src/audio/ding.mp3` works
 *  in a tree that has no `src/audio/` yet instead of dying on a raw ENOENT.
 *
 *  Every action also calls this *before* its generate request: generation is
 *  billed per call, so an unwritable output path has to fail before we spend
 *  one, not after the bytes are already paid for and in hand. */
function ensureOutputDir(output: string): void {
  const dir = dirname(resolvePath(output));
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    throw new Error(`can't create the output directory ${dir} (${err.code || err.message}). Pick a different -o path.`);
  }
}

/** Sync a freshly generated file up to the linked project (no-op when there's
 *  no local project, or the file was written outside the project tree). */
async function pushGenerated(savedPath: string): Promise<void> {
  const configPath = getConfigPath();
  if (!configPath) return; // not linked to a project - nothing to sync into
  const rel = relative(dirname(configPath), savedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) return; // outside the project tree
  try {
    await pushFile(savedPath);
  } catch (err: any) {
    console.error(muted(`Note: couldn't sync to the cloud automatically (${err.message}). Run \`gipity sync\` before referencing this file in \`gipity sandbox run\`.`));
  }
}

/** Read the `--input` image files an edit request is applied to, as base64 +
 *  mime type. The CLI reads the bytes itself so a photo never has to travel
 *  through the shell argv (base64 images blow past ARG_MAX — "Argument list too
 *  long" — the moment you try to inline them), which is exactly the trap an
 *  agent falls into hand-rolling an edit call with a python one-liner. */
function readInputImages(paths: string[]): { data: string; mime_type: string }[] {
  return paths.map((p) => {
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch (e: any) {
      throw new Error(`can't read --input image ${p} (${e.code || e.message}).`);
    }
    const mime = guessMime(p);
    if (!mime.startsWith('image/')) {
      throw new Error(`--input ${p} is not an image (${mime}). Edit inputs must be image files.`);
    }
    return { data: buf.toString('base64'), mime_type: mime };
  });
}

// ── IMAGE ──────────────────────────────────────────────────────────────

const imageCommand = new Command('image')
  .description('Generate an image from a text prompt, or edit existing images with --input')
  .addHelpText('after', `
Models (one line per provider; pass an id with --model, the provider with --provider):
${IMAGE_MODELS_TABLE}

Tier aliases (pass to --model instead of an id; each names a provider+model):
  ${IMAGE_TIER_ALIASES_DOC}

Gipity GPU models (--model gipity-...; list them with \`gipity generate models\`):
half the usual price for the same model, but queued: paid plans go first, and a
job may wait a while. The CLI waits and shows the queue position, then saves the
image. --no-wait queues it and prints the id instead (check it with
\`gipity generate status <id>\`). GPU-only options: --aspect, --n, --ref, --avoid,
--nsfw, --format. NSFW models need "Allow NSFW services" on your account.

Editing (--input): pass one or more source images and the prompt becomes an edit
instruction applied to them - "make it night time", "add a hat", "remove the car
in the background", or compose several inputs together. Editing routes to Gemini
automatically; the CLI reads the file bytes itself, so there is no base64/argv fiddling.

Examples:
  gipity generate image "a cat wearing a top hat"
  gipity generate image "make it night time" --input photo.jpg -o edited.png
  gipity generate image "put the person in the first photo into the second scene" --input person.png --input scene.png
  gipity generate image "landscape sunset" --provider gemini --aspect-ratio 16:9 --image-size 2K
  gipity generate image "product photo" --provider openai --model gpt-image-2 --size 1536x1024 --quality high
  gipity generate image "abstract art" --provider bfl --model flux-2-pro -o art.png
  gipity generate image "a red canoe at sunrise" --model gipity-krea2-realistic --aspect landscape
  gipity generate image "same canoe, now at night" --model gipity-qwen21-consistent --ref gen_abc12345
  gipity generate image "a lighthouse" --model gipity-krea2-realistic --n 4 --no-wait
`)
  .argument('<prompt>', 'Text description of the image, or (with --input) the edit instruction to apply')
  .option('--input <file>', 'Source image to edit/compose (repeatable). With --input the prompt is an edit instruction; routes to Gemini.', (v: string, acc: string[]) => (acc || []).concat(v))
  .addOption(new Option('--provider <provider>', 'Image provider (default: bfl)').choices(IMAGE_PROVIDER_IDS))
  .option('--model <model>', `Model id for the chosen provider, or a tier alias (${IMAGE_TIER_ALIAS_IDS.join(', ')}); see Models below`)
  .option('--size <size>', 'Dimensions as WxH, e.g. "1024x1024" (Gemini snaps to its nearest tier and aspect ratio)')
  .addOption(new Option('--quality <quality>', 'Quality (OpenAI gpt-image models only)').choices(IMAGE_QUALITY_IDS))
  .addOption(new Option('--aspect-ratio <ratio>', 'Aspect ratio (Gemini only)').choices(IMAGE_GEMINI_ASPECT_RATIO_IDS))
  .addOption(new Option('--image-size <size>', 'Output resolution tier (Gemini only; each model supports only some, see the app-image skill)').choices(IMAGE_GEMINI_SIZE_IDS))
  .option('--seed <n>', 'Deterministic seed (BFL and Gipity GPU models): reuse one seed to keep a set of images visually coherent', (v) => parseInt(v, 10))
  .option('-o, --output <file>', 'Output path (default ./generated.png). For an image your app ships, write it into the source tree so it deploys, e.g. -o src/assets/images/hero.png; the cwd default is fine for one-off generation. With --n > 1 the files are numbered (hero-1.png, hero-2.png).')
  .addOption(new Option('--aspect <aspect>', 'Shape (Gipity GPU models)').choices(['portrait', 'square', 'landscape']))
  .option('--n <count>', 'Number of images, 1-4, with consecutive seeds (Gipity GPU models)', (v) => parseInt(v, 10))
  .option('--ref <gen_id>', 'An earlier generation to keep consistent with (repeatable; models that take references)', (v: string, acc: string[]) => (acc || []).concat(v))
  .option('--avoid <text>', 'What to keep out of the image (Gipity GPU models that support it)')
  .option('--nsfw', 'Allow adult content (NSFW models; needs "Allow NSFW services" on your account)')
  .addOption(new Option('--format <format>', 'Full-size file format (Gipity GPU models; default jpeg)').choices(['jpeg', 'png']))
  .option('--no-wait', 'Queue it and print the generation id(s) instead of waiting')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);
      if (isQueuedModel(opts.model) || opts.wait === false) {
        await generateQueued(config.projectGuid, prompt, opts);
        return;
      }
      const inputImages = opts.input ? readInputImages(opts.input) : undefined;
      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/image`, {
        prompt,
        provider: opts.provider,
        model: opts.model,
        size: opts.size,
        quality: opts.quality,
        aspect_ratio: opts.aspectRatio,
        image_size: opts.imageSize,
        seed: Number.isFinite(opts.seed) ? opts.seed : undefined,
        input_images: inputImages,
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      const verb = inputImages ? 'Editing image...' : 'Generating image...';
      const started = Date.now();
      const result = opts.json
        ? await doGenerate()
        : await withSpinner(verb, doGenerate, { done: null });
      const elapsed = (Date.now() - started) / 1000;

      const ext = result.content_type.includes('png') ? 'png' : 'jpg';
      const filename = opts.output || `generated.${ext}`;

      const savedPath = await downloadFile(result.url, filename, !!opts.output);

      if (opts.json) {
        console.log(jsonResult(result, elapsed, savedPath));
      } else {
        console.log(muted(`Generated with ${result.provider}/${result.model}`));
        printMetrics([
          ...generationMetrics(result, elapsed),
          result.width && result.height ? { label: 'pixels', value: `${result.width}x${result.height}` } : null,
          result.seed !== undefined
            ? { label: 'seed', value: `${result.seed} ${muted(`(pass --seed ${result.seed} to keep the next image coherent)`)}` } : null,
        ]);
        if (result.note) console.log(muted(result.note));
        // Saved-path last: a caller reading a truncated tail of this output (an
        // agent batching several generates in one shell call) must still see
        // WHERE the bytes landed - that is the one line the next command needs.
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Image generation', err);
      process.exit(1);
    }
  });

/** File name for image i of n: the -o path (or ./generated.<ext>), numbered when n > 1. */
function numberedPath(base: string, i: number, n: number): string {
  if (n <= 1) return base;
  const dot = base.lastIndexOf('.');
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  return dot > slash ? `${base.slice(0, dot)}-${i + 1}${base.slice(dot)}` : `${base}-${i + 1}`;
}

/** Queued (async) path: submit, wait with live status, download each image. */
async function generateQueued(projectGuid: string, prompt: string, opts: any): Promise<void> {
  if (opts.input) throw new Error('--input editing is not available on queued generations; drop --input or pick a cloud model.');
  if (!opts.model || !String(opts.model).startsWith('gipity-')) {
    throw new Error('--no-wait is for Gipity GPU models (--model gipity-...; see `gipity generate models`). Cloud models render right away: drop --no-wait.');
  }
  const started = Date.now();
  const submitted = await submitGenerations(projectGuid, {
    model: opts.model,
    prompt,
    avoid: opts.avoid,
    aspect: opts.aspect,
    size: opts.size,
    seed: Number.isFinite(opts.seed) ? opts.seed : undefined,
    n: Number.isFinite(opts.n) ? opts.n : undefined,
    nsfw: opts.nsfw ? true : undefined,
    format: opts.format,
    references: opts.ref,
  });

  if (opts.wait === false) {
    if (opts.json) { console.log(JSON.stringify(submitted)); return; }
    for (const g of submitted) console.log(`${g.id}  ${muted(statusText(g))}`);
    console.log(muted(`Check with: gipity generate status ${submitted.map((g) => g.id).join(' ')}`));
    return;
  }

  if (!opts.json) console.log(muted(`Queued ${submitted.length === 1 ? submitted[0].id : submitted.map((g) => g.id).join(', ')} on ${opts.model}`));
  const done = await waitForGenerations(projectGuid, submitted, { json: !!opts.json });
  const elapsed = (Date.now() - started) / 1000;

  const saved: Array<{ gen: Generation; path: string | null }> = [];
  for (let i = 0; i < done.length; i++) {
    const g = done[i];
    const url = g.status === 'succeeded' ? g.outputs?.full?.url : undefined;
    if (!url) { saved.push({ gen: g, path: null }); continue; }
    const ext = (g.outputs?.full?.mime ?? '').includes('png') ? 'png' : 'jpg';
    const target = numberedPath(opts.output || `generated.${ext}`, i, done.length);
    saved.push({ gen: g, path: await downloadFile(url, target, !!opts.output) });
  }

  const failed = saved.filter((s) => !s.path);
  if (opts.json) {
    console.log(JSON.stringify(saved.map((s) => ({ ...s.gen, saved: s.path })).map((r) => ({ ...r, generation_seconds: Math.round(elapsed * 10) / 10 }))));
  } else {
    const credits = done.reduce((sum, g) => sum + (g.credits_charged ?? 0), 0);
    console.log(muted(`Generated with gipity/${opts.model}`));
    const first = saved.find((s) => s.path)?.gen;
    printMetrics([
      { label: 'time', value: fmtSeconds(elapsed) },
      first?.width && first?.height ? { label: 'pixels', value: `${first.width}x${first.height}` } : null,
      first?.seed != null ? { label: 'seed', value: `${first.seed} ${muted(`(pass --seed ${first.seed} to keep the next image coherent)`)}` } : null,
      credits > 0 ? { label: 'credits', value: credits.toLocaleString('en-US') } : null,
    ]);
    for (const s of failed) console.error(clrError(`${s.gen.id} ${statusText(s.gen)}`));
    for (const s of saved) if (s.path) console.log(success(`Saved ${s.gen.id} to ${s.path}`));
  }
  if (failed.length === done.length) process.exit(1);
}

// ── VIDEO ──────────────────────────────────────────────────────────────

const videoCommand = new Command('video')
  .description('Generate a short video (3-10 seconds) from a text prompt')
  .addHelpText('after', `
Models (default: gemini-omni-1.1-flash):
${VIDEO_MODELS_TABLE}

Aspect ratios: ${VIDEO_ASPECT_RATIOS}

Tips:
  - Describe the scene, camera movement, lighting, and any dialogue
  - Generation takes 20-120 seconds
  - Videos include AI-generated audio

Examples:
  gipity generate video "a bird flying over a mountain lake at sunset"
  gipity generate video "close-up of coffee being poured" --duration 5
  gipity generate video "vertical dance video" --aspect 9:16 --resolution 1080p -o dance.mp4
  gipity generate video "a wave crashing" --duration 3 --resolution 360p
`)
  .argument('<prompt>', 'Description of the video scene, action, camera movement, and dialogue')
  .addOption(new Option('--model <model>', 'Video model; see Models below for quality/price').choices(VIDEO_MODEL_IDS))
  .addOption(new Option('--aspect <ratio>', 'Aspect ratio (landscape or portrait)').choices(VIDEO_ASPECT_RATIO_IDS))
  .addOption(new Option('--resolution <res>', 'Video resolution').choices(VIDEO_RESOLUTION_IDS))
  .option('--duration <seconds>', 'Clip length in whole seconds, 3-10. Default 8. Billing is per second, so shorter is cheaper.')
  .option('-o, --output <file>', 'Output path (default ./generated.mp4). For a clip your app ships, write it into the source tree so it deploys, e.g. -o src/assets/video/clip.mp4; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);
      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/video`, {
        prompt,
        model: opts.model,
        aspect_ratio: opts.aspect,
        resolution: opts.resolution,
        duration_seconds: opts.duration ? Number(opts.duration) : undefined,
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      // A render runs 20-120s; the bouncing bar + timer keeps the wait honest.
      const started = Date.now();
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating video...', doGenerate, { done: null });
      const elapsed = (Date.now() - started) / 1000;

      const filename = opts.output || 'generated.mp4';
      const savedPath = await downloadFile(result.url, filename, !!opts.output);

      if (opts.json) {
        console.log(jsonResult(result, elapsed, savedPath));
      } else {
        console.log(muted(`Generated with ${result.provider}/${result.model}`));
        printMetrics(generationMetrics(result, elapsed));
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Video generation', err);
      process.exit(1);
    }
  });

// ── SPEECH ─────────────────────────────────────────────────────────────

const speechCommand = new Command('speech')
  .description('Generate speech audio from text using text-to-speech')
  .addHelpText('after', `
Providers:
${Object.entries(TTS_PROVIDER_DESCRIPTIONS).map(([k, v]) => `  ${k.padEnd(10)}  ${v}`).join('\n')}

Voices: openai voices are the list above; the full Gemini list is below. ElevenLabs
voice ids: gipity service call "tts/voices?provider=elevenlabs" --get

Gemini voices: ${GEMINI_TTS_VOICES_DOC}

Multi-speaker (--speakers, Gemini only): JSON array of exactly 2 speakers like
[{"name":"Joe","voice":"Kore"},{"name":"Jane","voice":"Puck"}]; format the
text as "Name: dialogue" on each line.

Examples:
  gipity generate speech "Hello, welcome to Gipity!"
  gipity generate speech "こんにちは世界" --provider gemini --voice Kore --language ja-JP
  gipity generate speech "Bonjour le monde" --provider gemini --language fr-FR
  gipity generate speech 'Joe: Hey!\\nJane: Hi there!' --provider gemini --speakers '[{"name":"Joe","voice":"Charon"},{"name":"Jane","voice":"Leda"}]'
`)
  .argument('<text>', 'Text to convert to speech (max 5000 characters)')
  .addOption(new Option('--provider <provider>', 'TTS provider (default: elevenlabs)').choices(TTS_PROVIDER_IDS))
  .option('--voice <voice>', 'Voice ID or name (provider-specific; see Voices below)')
  .option('--language <code>', 'BCP-47 language code, e.g. ja-JP, es-ES (Gemini only, 60+ languages)')
  .option('--speakers <json>', 'Multi-speaker config as JSON array (Gemini only, exactly 2 speakers)')
  .option('-o, --output <file>', 'Output path (default ./speech.mp3; --provider gemini returns WAV, so name it .wav). For audio your app ships, write it into the source tree so it deploys, e.g. -o src/assets/sounds/intro.mp3; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (text: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);

      let speakers: unknown;
      if (opts.speakers) {
        try { speakers = JSON.parse(opts.speakers); }
        catch { console.error(clrError('Invalid --speakers JSON')); process.exit(1); }
      }

      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/speech`, {
        text,
        provider: opts.provider,
        voice: opts.voice,
        language: opts.language,
        speakers,
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      const started = Date.now();
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating speech...', doGenerate, { done: null });
      const elapsed = (Date.now() - started) / 1000;

      const filename = opts.output || 'speech.mp3';
      const savedPath = await downloadFile(result.url, filename, !!opts.output);

      if (opts.json) {
        console.log(jsonResult(result, elapsed, savedPath));
      } else {
        console.log(muted(`Generated with ${result.provider}`));
        printMetrics(generationMetrics(result, elapsed));
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Speech generation', err);
      process.exit(1);
    }
  });

// ── MUSIC ──────────────────────────────────────────────────────────────

const musicCommand = new Command('music')
  .description('Generate music from a text prompt using AI')
  .addHelpText('after', `
The model is chosen from the platform's music catalog. Omit --model to use the
default; pass --model <id> only if you want a specific one (see the catalog with
\`gipity service call music/models --get\`).

Tips:
  - Describe genre, mood, instruments, and tempo (e.g. "upbeat lo-fi hip hop with mellow piano")
  - Music is instrumental by default; pass --vocals to allow singing, or --lyrics /
    --lyrics-file to have the vocalist sing YOUR exact words (section tags like
    [Verse] / [Chorus] are understood; keep the prompt to style only)
  - With lyrics, size --duration to the words (roughly 10s per short section)
  - Longer clips cost more; the max length depends on the model

Examples:
  gipity generate music "chill lo-fi beat for studying"
  gipity generate music "epic orchestral battle theme" --duration 60 -o src/assets/audio/theme.mp3
  gipity generate music "indie pop chorus" --vocals --duration 20
  gipity generate music "80s synth-pop, female vocals" --lyrics-file lyrics.txt --duration 120 -o song.mp3
`)
  .argument('<prompt>', 'Text description of the music to generate')
  .option('--duration <seconds>', 'Clip length in seconds (default 30; max depends on the model)', (v) => parseInt(v, 10))
  .option('--model <model>', 'Music model id (default: platform default; list ids: gipity service call music/models --get)')
  .option('--vocals', 'Allow vocals (default: instrumental only)')
  .option('--lyrics <text>', 'Exact lyrics to sing (implies vocals; only lyrics-capable models)')
  .option('--lyrics-file <file>', 'Read the exact lyrics to sing from a file (implies vocals)')
  .option('-o, --output <file>', 'Output path (default ./music.mp3). For audio your app ships, write it into the source tree so it deploys, e.g. -o src/assets/audio/theme.mp3; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);
      if (opts.lyrics && opts.lyricsFile) {
        console.error(clrError('Pass --lyrics or --lyrics-file, not both.'));
        process.exit(1);
      }
      const lyrics: string | undefined = opts.lyricsFile
        ? readFileSync(opts.lyricsFile, 'utf8').trim()
        : opts.lyrics;
      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/music`, {
        prompt,
        duration_seconds: opts.duration,
        model: opts.model,
        // Lyrics imply vocals; otherwise instrumental unless --vocals.
        instrumental: lyrics ? false : !opts.vocals,
        lyrics: lyrics || undefined,
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      const started = Date.now();
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating music...', doGenerate, { done: null });
      const elapsed = (Date.now() - started) / 1000;

      const filename = opts.output || 'music.mp3';
      const savedPath = await downloadFile(result.url, filename, !!opts.output);

      if (opts.json) {
        console.log(jsonResult(result, elapsed, savedPath));
      } else {
        console.log(muted(`Generated with ${result.model}`));
        printMetrics(generationMetrics(result, elapsed));
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Music generation', err);
      process.exit(1);
    }
  });

// ── SOUND ──────────────────────────────────────────────────────────────

const soundCommand = new Command('sound')
  .description('Generate a sound effect from a text description using AI')
  .addHelpText('after', `
Always billed to you (the caller) - the app's service billing_mode does not
apply to direct generation, so there is never a reason to flip a service to
owner_pays just to create assets.

Tips:
  - Describe the sound, not a scene (e.g. "cartoon boing with a springy wobble")
  - Omit --duration to let the model pick a natural length (billing is per second)
  - --influence closer to 1 follows the text more literally

Examples:
  gipity generate sound "cartoon character saying oof"
  gipity generate sound "thunder rolling in the distance" --duration 5
  gipity generate sound "sci-fi laser blast" -o src/assets/sounds/laser.mp3
`)
  .argument('<text>', 'Text description of the sound effect (max 1000 characters)')
  .option('--duration <seconds>', 'Clip length in seconds (0.5-30; default: automatic)', (v) => parseFloat(v))
  .option('--influence <n>', 'How closely to follow the prompt, 0.0-1.0 (higher = more literal)', (v) => parseFloat(v))
  .option('-o, --output <file>', 'Output path (default ./sound.mp3). For audio your app ships, write it into the source tree so it deploys, e.g. -o src/assets/sounds/boing.mp3; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (text: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);
      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/sound`, {
        text,
        duration_seconds: opts.duration,
        prompt_influence: opts.influence,
      }, { timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      const started = Date.now();
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating sound effect...', doGenerate, { done: null });
      const elapsed = (Date.now() - started) / 1000;

      const filename = opts.output || 'sound.mp3';
      const savedPath = await downloadFile(result.url, filename, !!opts.output);

      if (opts.json) {
        console.log(jsonResult(result, elapsed, savedPath));
      } else {
        console.log(muted('Generated sound effect'));
        printMetrics(generationMetrics(result, elapsed));
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Sound generation', err);
      process.exit(1);
    }
  });

// ── PARENT COMMAND ─────────────────────────────────────────────────────

export const generateCommand = addGenerationSubcommands(new Command('generate')
  .description('Generate images, video, speech, sound effects, or music')
  .addCommand(imageCommand)
  .addCommand(videoCommand)
  .addCommand(speechCommand)
  .addCommand(soundCommand)
  .addCommand(musicCommand));
