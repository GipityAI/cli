/**
 * Provider documentation strings for CLI help text.
 *
 * ⚠️  AUTO-GENERATED - do not edit directly.
 * Source: platform/server/src/config/constants/provider-docs.ts
 * Run `just sync-docs` to refresh from platform.
 */

export const GEMINI_LLM_MODELS_DOC = `gemini-3.6-flash (Gemini 3.6 Flash, $1.5/$7.5 per 1M tok, 1049K ctx), gemini-3.5-flash (Gemini 3.5 Flash, $1.5/$9 per 1M tok, 1049K ctx), gemini-3.1-pro-preview (Gemini 3.1 Pro, $2/$12 per 1M tok, 1049K ctx), gemini-3.1-flash-lite (Gemini 3.1 Flash-Lite, $0.25/$1.5 per 1M tok, 1049K ctx), gemini-3-flash-preview (Gemini 3 Flash, $0.5/$3 per 1M tok, 1049K ctx), gemini-2.5-flash (Gemini 2.5 Flash, $0.3/$2.5 per 1M tok, 1049K ctx)`;

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

export const IMAGE_MODELS_DOC = `openai: gpt-image-2. bfl: flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b. gemini: gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image`;

export const IMAGE_MODELS_TABLE = `  openai  gpt-image-2
  bfl     flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b
  gemini  gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image`;

export const IMAGE_PROVIDERS_BULLET = `- **OpenAI**: \`gpt-image-2\`
- **BFL/Flux**: \`flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b\`
- **Gemini/Nano Banana**: \`gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image\``;

export const IMAGE_PROVIDERS_LIST = `openai, bfl, gemini`;

export const IMAGE_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'openai': `OpenAI (gpt-image-2)`,
  'bfl': `BFL/Flux (flux-2-pro, flux-2-flex, flux-2-max, flux-2-klein-9b, flux-2-klein-4b)`,
  'gemini': `Gemini/Nano Banana (gemini-3.1-flash-lite-image, gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image)`,
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

export const IMAGE_TIER_ALIASES_DOC = `fast (gemini/gemini-3.1-flash-lite-image), standard (openai/gpt-image-2), high (bfl/flux-2-pro), ultra (bfl/flux-2-max)`;

export const IMAGE_TIER_ALIAS_IDS = [
  'fast',
  'standard',
  'high',
  'ultra',
] as const;

export const LLM_DEFAULT_MODELS_DOC = `OpenAI: gpt-5.4-nano (cheapest), gpt-5.4-mini (cheap reasoning). Anthropic: claude-haiku-4-5 (cheapest). Gemini: gemini-3.1-flash-lite (cheapest, 1M context)`;

export const LLM_PROVIDERS_LIST = `anthropic, openai, gemini, openrouter`;

export const OPENAI_TTS_VOICES_DOC = `alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse`;

export const TRANSCRIBE_PROVIDERS_DOC = `elevenlabs (default, Scribe v2), openai (GPT-4o Transcribe), gemini (Gemini 2.5 Flash - cheapest, multilingual)`;

export const TTS_PROVIDERS_LIST = `elevenlabs, openai, gemini`;

export const TTS_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'elevenlabs': `ElevenLabs (many premium voices)`,
  'openai': `OpenAI (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse)`,
  'gemini': `Gemini (30 voices: Kore, Puck, Zephyr, Charon, Fenrir, Leda, Orus, Aoede, and 22 more). Multi-speaker (up to 2) and 60+ languages`,
};

export const TTS_PROVIDER_IDS = [
  'elevenlabs',
  'openai',
  'gemini',
] as const;

export const VIDEO_ASPECT_RATIOS = `16:9 (landscape), 9:16 (portrait), 1:1 (square)`;

export const VIDEO_ASPECT_RATIO_IDS = [
  '16:9',
  '9:16',
  '1:1',
] as const;

export const VIDEO_MODELS_DOC = `veo-3.1-generate-preview (best quality, up to 4K, ~$0.40/sec), veo-3.1-fast-generate-preview (faster, ~$0.10/sec), veo-3.1-lite-generate-preview (budget, ~$0.05/sec)`;

export const VIDEO_MODELS_LIST = `veo-3.1-generate-preview, veo-3.1-fast-generate-preview, veo-3.1-lite-generate-preview`;

export const VIDEO_MODELS_TABLE = `  veo-3.1-generate-preview       best quality, up to 4K, ~$0.40/sec
  veo-3.1-fast-generate-preview  faster, ~$0.10/sec
  veo-3.1-lite-generate-preview  budget, ~$0.05/sec`;

export const VIDEO_MODEL_IDS = [
  'veo-3.1-generate-preview',
  'veo-3.1-fast-generate-preview',
  'veo-3.1-lite-generate-preview',
] as const;

export const VIDEO_RESOLUTIONS = `720p, 1080p, 4k`;

export const VIDEO_RESOLUTION_IDS = [
  '720p',
  '1080p',
  '4k',
] as const;

