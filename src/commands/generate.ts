import { Command } from 'commander';
import { post } from '../api.js';
import { resolveProjectContext, getConfigPath } from '../config.js';
import { pushFile } from '../sync.js';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve as resolvePath, dirname, relative, isAbsolute } from 'path';
import { error as clrError, success, muted } from '../colors.js';
import { printCommandError } from '../helpers/command.js';
import { withSpinner } from '../progress.js';
import { IMAGE_MODELS_DOC, IMAGE_GEMINI_ASPECT_RATIOS, IMAGE_GEMINI_SIZES, VIDEO_MODELS_DOC, TTS_PROVIDER_DESCRIPTIONS, GEMINI_TTS_VOICES_DOC } from '../provider-docs.js';

interface GenerateResult {
  url: string;
  content_type: string;
  model: string;
  provider: string;
  size_bytes: number;
  seed?: number;
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
async function downloadFile(url: string, filename: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const outPath = correctExtension(filename, buffer);
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
  if (!actual) return filename; // unrecognized bytes — nothing better to say
  const dot = filename.lastIndexOf('.');
  const asked = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (canonicalExt(asked) === actual) return filename;

  const corrected = `${dot > 0 ? filename.slice(0, dot) : filename}.${actual}`;
  console.error(muted(
    `Note: the model returned ${formatName(actual)}, not ${asked ? formatName(asked) : 'the requested format'} — `
    + `saving as ${corrected} so the extension matches the actual bytes.`,
  ));
  return corrected;
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

// ── IMAGE ──────────────────────────────────────────────────────────────

const imageCommand = new Command('image')
  .description(`Generate an image from a text prompt using AI.

Models: ${IMAGE_MODELS_DOC}

Gemini-specific options:
  --aspect-ratio   Control output shape: ${IMAGE_GEMINI_ASPECT_RATIOS}
  --image-size     Control resolution: ${IMAGE_GEMINI_SIZES} (default: 1K)

Examples:
  gipity generate image "a cat wearing a top hat"
  gipity generate image "landscape sunset" --provider gemini --aspect-ratio 16:9 --image-size 2K
  gipity generate image "product photo" --provider openai --model gpt-image-2 --size 1536x1024 --quality high
  gipity generate image "abstract art" --provider bfl --model flux-2-pro -o art.png`)
  .argument('<prompt>', 'Text description of the image to generate')
  .option('--provider <provider>', 'Image provider: openai, bfl, or gemini (default: bfl)')
  .option('--model <model>', 'Model ID (see provider list above)')
  .option('--size <size>', 'Dimensions as WxH, e.g. "1024x1024" (OpenAI/BFL)')
  .option('--quality <quality>', 'Quality: low|medium|high|auto (gpt-image-2)')
  .option('--aspect-ratio <ratio>', 'Aspect ratio (Gemini only): 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9')
  .option('--image-size <size>', 'Output resolution (Gemini only): 512, 1K, 2K, 4K')
  .option('--seed <n>', 'Deterministic seed (BFL only): reuse one seed to keep a set of images visually coherent', (v) => parseInt(v, 10))
  .option('-o, --output <file>', 'Output path (default ./generated.png). For an image your app ships, write it into the source tree so it deploys, e.g. -o src/assets/images/hero.png; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);
      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/image`, {
        prompt,
        provider: opts.provider,
        model: opts.model,
        size: opts.size,
        quality: opts.quality,
        aspect_ratio: opts.aspectRatio,
        image_size: opts.imageSize,
        seed: Number.isFinite(opts.seed) ? opts.seed : undefined,
      });
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating image…', doGenerate, { done: null });

      const ext = result.content_type.includes('png') ? 'png' : 'jpg';
      const filename = opts.output || `generated.${ext}`;

      const savedPath = await downloadFile(result.url, filename);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, saved: savedPath }));
      } else {
        const sizeKb = Math.round(result.size_bytes / 1024);
        console.log(`${muted(`Generated with ${result.provider}/${result.model} (${sizeKb}KB)`)}`);
        if (result.seed !== undefined) {
          console.log(muted(`Seed ${result.seed} — pass --seed ${result.seed} to keep the next image coherent`));
        }
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

// ── VIDEO ──────────────────────────────────────────────────────────────

const videoCommand = new Command('video')
  .description(`Generate a short video (up to 8 seconds) from a text prompt using Google Veo.

Models: ${VIDEO_MODELS_DOC}

Options:
  --aspect   16:9 (landscape, default), 9:16 (portrait/vertical), 1:1 (square)
  --resolution   720p (default), 1080p, 4k

Tips:
  - Describe the scene, camera movement, lighting, and any dialogue
  - Generation takes 30-120 seconds depending on model
  - Videos include AI-generated audio

Examples:
  gipity generate video "a bird flying over a mountain lake at sunset"
  gipity generate video "close-up of coffee being poured" --model veo-3.1-fast-generate-preview
  gipity generate video "vertical dance video" --aspect 9:16 --resolution 1080p -o dance.mp4`)
  .argument('<prompt>', 'Description of the video scene, action, camera movement, and dialogue')
  .option('--model <model>', 'Veo model: veo-3.1-generate-preview (quality), veo-3.1-fast-generate-preview (speed), veo-3.1-lite-generate-preview (budget)')
  .option('--aspect <ratio>', 'Aspect ratio: 16:9 (landscape), 9:16 (portrait), 1:1 (square)')
  .option('--resolution <res>', 'Video resolution: 720p, 1080p, 4k')
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
      });
      // Veo runs 30-120s; the bouncing bar + timer keeps the wait honest.
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating video…', doGenerate, { done: null });

      const filename = opts.output || 'generated.mp4';
      const savedPath = await downloadFile(result.url, filename);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, saved: savedPath }));
      } else {
        const sizeKb = Math.round(result.size_bytes / 1024);
        console.log(`${muted(`Generated with ${result.provider}/${result.model} (${sizeKb}KB)`)}`);
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Video generation', err);
      process.exit(1);
    }
  });

// ── SPEECH ─────────────────────────────────────────────────────────────

const speechCommand = new Command('speech')
  .description(`Generate speech audio from text using text-to-speech.

Providers: ${Object.entries(TTS_PROVIDER_DESCRIPTIONS).map(([k, v]) => `${k} - ${v}`).join('\n  ')}

Gemini-specific options:
  --language     BCP-47 language code (e.g. ja-JP, es-ES, fr-FR). 60+ languages supported.
  --speakers     Multi-speaker mode (up to 2). JSON array: [{"name":"Joe","voice":"Kore"},{"name":"Jane","voice":"Puck"}]
                 When using multi-speaker, format your text as "Name: dialogue" on each line.

Examples:
  gipity generate speech "Hello, welcome to Gipity!"
  gipity generate speech "こんにちは世界" --provider gemini --voice Kore --language ja-JP
  gipity generate speech "Bonjour le monde" --provider gemini --language fr-FR
  gipity generate speech 'Joe: Hey!\\nJane: Hi there!' --provider gemini --speakers '[{"name":"Joe","voice":"Charon"},{"name":"Jane","voice":"Leda"}]'`)
  .argument('<text>', 'Text to convert to speech (max 5000 characters)')
  .option('--provider <provider>', 'TTS provider: elevenlabs (default), openai, or gemini')
  .option('--voice <voice>', 'Voice ID or name (provider-specific)')
  .option('--language <code>', 'BCP-47 language code, e.g. ja-JP, es-ES (Gemini only, 60+ languages)')
  .option('--speakers <json>', 'Multi-speaker config as JSON array (Gemini only, up to 2 speakers)')
  .option('-o, --output <file>', 'Output path (default ./speech.mp3). For audio your app ships, write it into the source tree so it deploys, e.g. -o src/assets/sounds/intro.mp3; the cwd default is fine for one-off generation.')
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
      });
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating speech…', doGenerate, { done: null });

      const filename = opts.output || 'speech.mp3';
      const savedPath = await downloadFile(result.url, filename);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, saved: savedPath }));
      } else {
        const sizeKb = Math.round(result.size_bytes / 1024);
        console.log(`${muted(`Generated with ${result.provider} (${sizeKb}KB)`)}`);
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Speech generation', err);
      process.exit(1);
    }
  });

// ── MUSIC ──────────────────────────────────────────────────────────────

const musicCommand = new Command('music')
  .description(`Generate music from a text prompt using AI.

The model is chosen from the platform's music catalog. Omit --model to use the
default; pass --model <id> only if you want a specific one (see the catalog with
\`gipity service call music/models --get\`).

Tips:
  - Describe genre, mood, instruments, and tempo (e.g. "upbeat lo-fi hip hop with mellow piano")
  - Music is instrumental by default; pass --vocals to allow singing
  - Longer clips cost more; the max length depends on the model

Examples:
  gipity generate music "chill lo-fi beat for studying"
  gipity generate music "epic orchestral battle theme" --duration 60 -o src/assets/audio/theme.mp3
  gipity generate music "indie pop chorus" --vocals --duration 20`)
  .argument('<prompt>', 'Text description of the music to generate')
  .option('--duration <seconds>', 'Clip length in seconds (default 30; max depends on the model)', (v) => parseInt(v, 10))
  .option('--model <model>', 'Music model id (default: platform default)')
  .option('--vocals', 'Allow vocals (default: instrumental only)')
  .option('-o, --output <file>', 'Output path (default ./music.mp3). For audio your app ships, write it into the source tree so it deploys, e.g. -o src/assets/audio/theme.mp3; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      if (opts.output) ensureOutputDir(opts.output);
      const doGenerate = () => post<GenerateResult>(`/projects/${config.projectGuid}/generate/music`, {
        prompt,
        duration_seconds: opts.duration,
        model: opts.model,
        instrumental: !opts.vocals,
      });
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating music…', doGenerate, { done: null });

      const filename = opts.output || 'music.mp3';
      const savedPath = await downloadFile(result.url, filename);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, saved: savedPath }));
      } else {
        const sizeKb = Math.round(result.size_bytes / 1024);
        console.log(`${muted(`Generated with ${result.model} (${sizeKb}KB)`)}`);
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Music generation', err);
      process.exit(1);
    }
  });

// ── SOUND ──────────────────────────────────────────────────────────────

const soundCommand = new Command('sound')
  .description(`Generate a sound effect from a text description using AI.

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
  gipity generate sound "sci-fi laser blast" -o src/assets/sounds/laser.mp3`)
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
      });
      const result = opts.json
        ? await doGenerate()
        : await withSpinner('Generating sound effect…', doGenerate, { done: null });

      const filename = opts.output || 'sound.mp3';
      const savedPath = await downloadFile(result.url, filename);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, saved: savedPath }));
      } else {
        const sizeKb = Math.round(result.size_bytes / 1024);
        console.log(`${muted(`Generated sound effect (${sizeKb}KB)`)}`);
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      printCommandError('Sound generation', err);
      process.exit(1);
    }
  });

// ── PARENT COMMAND ─────────────────────────────────────────────────────

export const generateCommand = new Command('generate')
  .description('Generate images, video, speech, sound effects, or music')
  .addCommand(imageCommand)
  .addCommand(videoCommand)
  .addCommand(speechCommand)
  .addCommand(soundCommand)
  .addCommand(musicCommand);
