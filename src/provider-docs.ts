/**
 * Provider documentation strings for CLI help text.
 *
 * ⚠️  AUTO-GENERATED - do not edit directly.
 * Source: platform/server/src/config/constants/provider-docs.ts
 * Run `just sync-docs` to refresh from platform.
 */

export const GEMINI_LLM_MODELS_DOC = `gemini-3.8-flash (Gemini 3.8 Flash, $0.75/$3.75 per 1M tok, 1049K ctx), gemini-3.6-flash (Gemini 3.6 Flash, $0.75/$3.75 per 1M tok, 1049K ctx), gemini-3.5-flash (Gemini 3.5 Flash, $0.75/$3.75 per 1M tok, 1049K ctx), gemini-3.1-pro-preview (Gemini 3.1 Pro, $2/$12 per 1M tok, 1049K ctx), gemini-3.5-flash-lite (Gemini 3.5 Flash-Lite, $0.3/$2.5 per 1M tok, 1049K ctx), gemini-3.1-flash-lite (Gemini 3.1 Flash-Lite, $0.25/$1.5 per 1M tok, 1049K ctx), gemini-3-flash-preview (Gemini 3 Flash, $0.5/$3 per 1M tok, 1049K ctx), gemini-2.5-flash (Gemini 2.5 Flash, $0.3/$2.5 per 1M tok, 1049K ctx)`;

export const GEMINI_TTS_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

export const GEMINI_TTS_VOICES_DOC = `Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat`;

export const GEMINI_TTS_VOICES_SHORT = `Kore, Puck, Zephyr, Charon, Fenrir, Leda, Orus, Aoede, and 22 more`;

export const IMAGE_GEMINI_ASPECT_RATIOS = `1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9`;

export const IMAGE_GEMINI_ASPECT_RATIO_IDS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '21:9',
] as const;

export const IMAGE_GEMINI_SIZES = `512, 1K, 2K, 4K`;

export const IMAGE_GEMINI_SIZE_IDS = [
  '512',
  '1K',
  '2K',
  '4K',
] as const;

export const IMAGE_MODELS_DOC = `openai: gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst. bfl: flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b, flux-3-image. gemini: gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image`;

export const IMAGE_MODELS_TABLE = `  openai  gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst
  bfl     flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b, flux-3-image
  gemini  gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image`;

export const IMAGE_PROVIDERS_BULLET = `- **OpenAI**: \`gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst\`
- **BFL/Flux**: \`flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b, flux-3-image\`
- **Gemini/Nano Banana**: \`gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image\``;

export const IMAGE_PROVIDERS_LIST = `openai, bfl, gemini`;

export const IMAGE_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'openai': `OpenAI (gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst)`,
  'bfl': `BFL/Flux (flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b, flux-3-image)`,
  'gemini': `Gemini/Nano Banana (gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image)`,
};

export const IMAGE_PROVIDER_IDS = [
  'openai',
  'bfl',
  'gemini',
] as const;

export const IMAGE_QUALITY_IDS = [
  'low',
  'medium',
  'high',
  'auto',
] as const;

export const IMAGE_TIER_ALIASES_DOC = `fast (gemini/gemini-3.1-flash-lite-image), standard (openai/gpt-image-2.5-flare), high (bfl/flux-2-pro), ultra (bfl/flux-2-max)`;

export const IMAGE_TIER_ALIAS_IDS = [
  'fast',
  'standard',
  'high',
  'ultra',
] as const;

export const LLM_DEFAULT_MODELS_DOC = `OpenAI: gpt-6-luna (cheapest, 1M context), gpt-6.1-sol (balanced). Anthropic: claude-haiku-5-5 (cheapest, 1M context). Gemini: gemini-3.1-flash-lite (cheapest), gemini-3.5-flash-lite (1M context)`;

export const LLM_PROVIDERS_LIST = `anthropic, openai, gemini, openrouter`;

export const OPENAI_TTS_VOICES_DOC = `alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse`;

export const TRANSCRIBE_PROVIDERS_DOC = `elevenlabs (default, Scribe v2, word timestamps), openai (GPT Transcribe; diarization via GPT-4o Transcribe Diarize)`;

export const TTS_MODELS_DOC = `elevenlabs: eleven_flash_v2_5 (default), eleven_v4_turbo, eleven_v4. openai: gpt-4o-mini-tts (default). gemini: gemini-3.8-flash-lite-tts (default), gemini-3.8-flash-tts`;

export const TTS_PROVIDERS_LIST = `elevenlabs, openai, gemini`;

export const TTS_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'elevenlabs': `ElevenLabs (many premium voices)`,
  'openai': `OpenAI (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse)`,
  'gemini': `Gemini (30 voices: Kore, Puck, Zephyr, Charon, Fenrir, Leda, Orus, Aoede, and 22 more)`,
};

export const TTS_PROVIDER_IDS = [
  'elevenlabs',
  'openai',
  'gemini',
] as const;

export const VIDEO_ASPECT_RATIOS = `16:9 (landscape), 9:16 (portrait)`;

export const VIDEO_ASPECT_RATIO_IDS = [
  '16:9',
  '9:16',
] as const;

export const VIDEO_MODELS_DOC = `gemini-omni-1.1-flash (3-10s clips with sound, 360p to 4K, ~$0.10/sec at 720p)`;

export const VIDEO_MODELS_LIST = `gemini-omni-1.1-flash`;

export const VIDEO_MODELS_TABLE = `  gemini-omni-1.1-flash  3-10s clips with sound, 360p to 4K, ~$0.10/sec at 720p`;

export const VIDEO_MODEL_IDS = [
  'gemini-omni-1.1-flash',
] as const;

export const VIDEO_RESOLUTIONS = `360p, 720p, 1080p, 4k`;

export const VIDEO_RESOLUTION_IDS = [
  '360p',
  '720p',
  '1080p',
  '4k',
] as const;

