import { Command } from 'commander';
import { post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { writeFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { error as clrError, success, muted, info } from '../colors.js';
import { IMAGE_MODELS_DOC, IMAGE_GEMINI_ASPECT_RATIOS, IMAGE_GEMINI_SIZES, VIDEO_MODELS_DOC, TTS_PROVIDER_DESCRIPTIONS, GEMINI_TTS_VOICES_DOC } from '../provider-docs.js';

interface GenerateResult {
  url: string;
  content_type: string;
  model: string;
  provider: string;
  size_bytes: number;
}

/** Download a URL and save to a local file. Returns the absolute path written,
 *  so callers can report exactly where the file landed. */
async function downloadFile(url: string, filename: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(filename, buffer);
  return resolvePath(filename);
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
  .option('-o, --output <file>', 'Output path (default ./generated.png). For an image your app ships, write it into the source tree so it deploys, e.g. -o src/assets/images/hero.png; the cwd default is fine for one-off generation.')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, opts) => {
    try {
      const { config } = await resolveProjectContext();
      const result = await post<GenerateResult>(`/projects/${config.projectGuid}/generate/image`, {
        prompt,
        provider: opts.provider,
        model: opts.model,
        size: opts.size,
        quality: opts.quality,
        aspect_ratio: opts.aspectRatio,
        image_size: opts.imageSize,
      });

      const ext = result.content_type.includes('png') ? 'png' : 'jpg';
      const filename = opts.output || `generated.${ext}`;

      const savedPath = await downloadFile(result.url, filename);

      if (opts.json) {
        console.log(JSON.stringify({ ...result, saved: savedPath }));
      } else {
        const sizeKb = Math.round(result.size_bytes / 1024);
        console.log(`${muted(`Generated with ${result.provider}/${result.model} (${sizeKb}KB)`)}`);
        console.log(success(`Saved to ${savedPath}`));
      }
    } catch (err: any) {
      console.error(clrError(`Image generation failed: ${err.message}`));
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
      if (!opts.json) console.log(info('Generating video (this may take 30-120 seconds)...')); // keep --json stdout pure JSON

      const result = await post<GenerateResult>(`/projects/${config.projectGuid}/generate/video`, {
        prompt,
        model: opts.model,
        aspect_ratio: opts.aspect,
        resolution: opts.resolution,
      });

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
      console.error(clrError(`Video generation failed: ${err.message}`));
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

      let speakers;
      if (opts.speakers) {
        try { speakers = JSON.parse(opts.speakers); }
        catch { console.error(clrError('Invalid --speakers JSON')); process.exit(1); }
      }

      const result = await post<GenerateResult>(`/projects/${config.projectGuid}/generate/speech`, {
        text,
        provider: opts.provider,
        voice: opts.voice,
        language: opts.language,
        speakers,
      });

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
      console.error(clrError(`Speech generation failed: ${err.message}`));
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
      if (!opts.json) console.log(info('Generating music...')); // keep --json stdout pure JSON

      const result = await post<GenerateResult>(`/projects/${config.projectGuid}/generate/music`, {
        prompt,
        duration_seconds: opts.duration,
        model: opts.model,
        instrumental: !opts.vocals,
      });

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
      console.error(clrError(`Music generation failed: ${err.message}`));
      process.exit(1);
    }
  });

// ── PARENT COMMAND ─────────────────────────────────────────────────────

export const generateCommand = new Command('generate')
  .description('Generate images, video, speech, or music')
  .addCommand(imageCommand)
  .addCommand(videoCommand)
  .addCommand(speechCommand)
  .addCommand(musicCommand);
