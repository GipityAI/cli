/**
 * Provider documentation strings for CLI help text.
 *
 * ⚠️  AUTO-GENERATED — do not edit directly.
 * Source: platform/server/src/config/constants/provider-docs.ts
 * Run `just sync-docs` to refresh from platform.
 */

export const GEMINI_LLM_MODELS_DOC = `gemini-2.5-flash (Gemini 2.5 Flash, $0.15/$0.6 per 1M tok, 1049K ctx), gemini-2.5-pro (Gemini 2.5 Pro, $1.25/$10 per 1M tok, 1049K ctx), gemini-3-pro-preview (Gemini 3 Pro, $2/$12 per 1M tok, 200K ctx)`;

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

export const IMAGE_GEMINI_SIZES = `512, 1K, 2K, 4K`;

export const IMAGE_MODELS_DOC = `openai: gpt-image-1, dall-e-3. bfl: flux-2-pro, flux-2-flex, flux-2-max, flux-dev. gemini: gemini-2.5-flash-image, gemini-3.1-flash-image-preview, gemini-3-pro-image-preview`;

export const IMAGE_PROVIDERS_BULLET = `- **OpenAI**: \`gpt-image-1, dall-e-3\`
- **BFL/Flux**: \`flux-2-pro, flux-2-flex, flux-2-max, flux-dev\`
- **Gemini/Nano Banana**: \`gemini-2.5-flash-image, gemini-3.1-flash-image-preview, gemini-3-pro-image-preview\``;

export const IMAGE_PROVIDERS_LIST = `openai, bfl, gemini`;

export const IMAGE_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'openai': `OpenAI (gpt-image-1, dall-e-3)`,
  'bfl': `BFL/Flux (flux-2-pro, flux-2-flex, flux-2-max, flux-dev)`,
  'gemini': `Gemini/Nano Banana (gemini-2.5-flash-image, gemini-3.1-flash-image-preview, gemini-3-pro-image-preview)`,
};

export const LLM_DEFAULT_MODELS_DOC = `OpenAI: gpt-5-mini (cheapest). Anthropic: claude-haiku-4-5 (cheapest). Gemini: gemini-2.5-flash (cheapest, 1M context)`;

export const LLM_PROVIDERS_LIST = `anthropic, openai, gemini`;

export const OPENAI_TTS_VOICES_DOC = `alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse`;

export const TRANSCRIBE_PROVIDERS_DOC = `elevenlabs (default, Scribe v2), openai (GPT-4o Transcribe), gemini (Gemini 2.5 Flash — cheapest, multilingual)`;

export const TTS_PROVIDERS_LIST = `elevenlabs, openai, gemini`;

export const TTS_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'elevenlabs': `ElevenLabs (many voices — use voice_set list to discover)`,
  'openai': `OpenAI (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse)`,
  'gemini': `Gemini (30 voices: Kore, Puck, Zephyr, Charon, Fenrir, Leda, Orus, Aoede, and 22 more). Multi-speaker (up to 2) and 60+ languages`,
};

export const VIDEO_ASPECT_RATIOS = `16:9 (landscape), 9:16 (portrait), 1:1 (square)`;

export const VIDEO_MODELS_DOC = `veo-3.1-generate-preview (best quality, ~$0.40/sec), veo-3.1-fast-generate-preview (faster, ~$0.15/sec), veo-3.1-lite-generate-preview (budget, ~$0.07/sec)`;

export const VIDEO_MODELS_LIST = `veo-3.1-generate-preview, veo-3.1-fast-generate-preview, veo-3.1-lite-generate-preview`;

export const VIDEO_RESOLUTIONS = `720p, 1080p, 4k`;

