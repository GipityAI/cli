/**
 * Knowledge content shared across Gipity surfaces.
 *
 * AUTO-GENERATED - do not edit directly.
 * Source: platform/docs/knowledge/*.md + docs/skills/*.md frontmatter + gipity-overview.ts
 * Run `just sync-knowledge` to refresh.
 */

export const BUILD_VS_NON_BUILD_RULE = `## When to add a template
If the user wants a deployable app (web, game, API): run \`gipity add <template>\` before writing any files. A template wires up \`gipity.yaml\`, deploy config, and sync; hand-written files miss all of it.
If it's a one-off task (analysis, media, data, research): skip it - use \`gipity sandbox run\` or work with files directly.
If ambiguous: ask one short clarifying question.

Templates:
    - \`web-simple\` - Landing page, dashboard, calculator, canvas demo, visualization, animation, single-page tool
    - \`web-fullstack\` - Web app with login, database, or API - CRM, invoice tracker, booking system, admin panel
    - \`web-vision-cam\` - Live camera app with gesture, pose, or object detection - hand-tracking input, fitness/pose feedback, object-aware UI; on-device, no upload
    - \`2d-game\` - Platformer, arcade, puzzle, endless runner, physics toy (Phaser 3)
    - \`3d-engine\` - Minimal 3D multiplayer base - Three.js + Rapier + Colyseus, no gameplay; build your own scene and mechanics on top
    - \`3d-world\` - Multiplayer world, 3D sandbox, shooter, exploration, virtual showroom (Three.js + Rapier + Colyseus)
    - \`api\` - Backend service, webhook, data pipeline, chatbot, cron job - no frontend
    - \`karaoke-captions\` - Forced-alignment app - karaoke captions, subtitle timing, language learning, dubbing alignment
When unsure, default to \`web-simple\`. After adding the template, edit the generated files, then \`gipity deploy dev\`.
Only skip this on a build request if the user explicitly says not to.

Hidden types (do NOT suggest unsolicited - use only when the user explicitly asks for that domain):
    - \`app-itsm\` - IT Service Management app (helpdesk, ticketing, incident management).
    - \`monitor\` - Account-wide observability dashboard - auto-installed; rarely picked manually.

Kits are reusable building blocks added to an existing app, not whole templates - their files land in \`src/packages/<name>/\`:
    - \`gipity add realtime\` - Multiplayer / presence / shared state - channels, host election, server-persisted sync. Engine-agnostic; works in any app.
    - \`gipity add web-vision-mediapipe\` - On-device camera vision - gesture recognition, body pose, object detection. Runs fully client-side via MediaPipe Tasks; no server, no upload. Web only.
    - \`gipity add chatbot\` - Drop-in chatbot - configurable persona, scope guardrails, static knowledge (20k budget), streaming responses. Headless engine + bubble widget; bring your own UI if you want. Works in any app.
    - \`gipity add audio-align\` - Audio + lyrics -> word-level timing JSON. Demucs vocal isolation + MMS_FA forced alignment, runs as a Modal L4 GPU job (~$0.01 per 3-min song). For karaoke captions, subtitling, language learning, dubbing alignment.`;

export const SKILLS_CONTENT = `# Gipity Integration

Gipity is the cloud platform your project runs on - hosting, databases, deployment, file storage, code execution, workflows, and monitoring. Gip is the cloud agent that runs on Gipity.

This session is connected to a Gipity project. Prefer the cheapest option that works - CLI and sandbox are instant and free, app services are runtime HTTP calls, \`gipity chat\` burns LLM tokens:

1. CLI commands (fast, no agent overhead). The \`gipity\` CLI covers add, deploy, db, fn, logs, browser, sync, memory, skill, and more. All commands support \`--json\`.
2. Cloud sandbox via \`gipity sandbox run\` - Docker container with pre-installed tools for media (ffmpeg, ImageMagick, sox), documents (pandoc, LibreOffice), and data (pandas, matplotlib, sqlite3). Run \`gipity skill read sandbox-tools\` for the full toolkit. No network from inside the sandbox - fetch what you need before sending it in.
3. App services - runtime HTTP endpoints your deployed app calls directly at \`https://a.gipity.ai/api/<PROJECT_GUID>/services/*\`. Available: LLM, TTS, image, sound, music, transcribe, video, file upload, realtime, location. Load the matching skill (\`app-llm\`, \`app-tts\`, etc.) before writing service code - they have the schemas, auth pattern, and common-mistake guards. For one-off generation during development, prefer \`gipity generate <image|video|...>\` or \`gipity chat\`.
4. Delegate to Gip (\`gipity chat "<task>"\`) - only when the work genuinely needs agent reasoning or a tool not in the CLI, sandbox, or app services. Required for: Twitter/X search, Gmail, calendar, push notifications, video understanding, audio source isolation, cross-model second opinions, multi-step orchestration. Don't use \`gipity chat\` for anything the sandbox can do - it's slower and burns tokens.

You are the developer. Write files in this directory - they auto-sync to Gipity via hooks. Don't run \`npm install\`, \`npm start\`, \`node\`, or \`python\` locally; there is no local runtime. Code runs in the Gipity sandbox.

## Use first-party services before reaching outside

Gipity ships its own services for things apps usually pull from a third party - auth, location and geocoding, LLM, image/audio/video generation, transcription, file uploads, realtime. Before you call an external API or add an npm package for one of these, run \`gipity skill list\` and look for a matching skill. First-party services need no API keys, cost less, and keep user data off third parties. Reach outside only when the catalog genuinely has no equivalent - and say so when you do.

## When to add a template

The full rule and definition of done are injected at the top of every session context. In short: if the user asks you to build something deployable (web app, game, API), run \`gipity add <template>\` first (default \`web-simple\`); if it's a one-off task (analysis, PDFs, data work), use \`gipity sandbox run\` instead. To add a reusable building block to an existing app (e.g. multiplayer), \`gipity add <kit>\`.

Build loop: \`gipity add\` → edit files → \`gipity deploy dev\` → \`gipity page inspect <url>\` → fix any errors → repeat until the definition of done is met.

## CLI quick reference

Key commands: \`gipity add <template|kit>\`, \`gipity deploy dev\`, \`gipity sandbox run\`, \`gipity page inspect <url>\`, \`gipity db query "SQL"\`, \`gipity fn call <name>\`, \`gipity logs fn <name>\`, \`gipity skill read <name>\`.
Run \`gipity --help\` for the full list. Use \`--help\` on any command for details.

## Files and sync

Write files locally - hooks auto-push to Gipity on every save. Remote-generated files (images, audio from \`gipity chat\`) auto-pull. Use \`gipity sync\` if things get out of sync. Deletes are safe - use \`rollback\` with a datetime to undo, or \`file_version_restore\` for individual files.

## Skills (detailed documentation)

Run \`gipity skill list\` to see every skill. Run \`gipity skill read <name>\` to read one. Load the relevant skill before starting a task - they have the correct API patterns, code examples, and common mistakes.

App services skills (load before calling \`/services/*\` endpoints):
- \`app-audio\` - sound effects, music, transcription
- \`app-auth\` - sign in with Gipity, popup vs redirect
- \`app-files\` - uploads, variants, file listing
- \`app-image\` - providers, sizes, aspect ratios
- \`app-llm\` - chat completions, streaming, image input
- \`app-location\` - user location & reverse geocoding for deployed apps (first-party - no third-party geocoder)
- \`app-realtime\` - Colyseus rooms, relay vs state
- \`app-tts\` - voices, multi-speaker, languages
- \`app-video\` - Veo models, aspect, resolution

App development skills:
- \`app-debugging\` - debug a deployed app: page inspect/eval, screenshots, function logs
- \`app-development\` - functions, database, and API
- \`deploy\` - the deploy pipeline & gipity.yaml manifest
- \`jobs\` - long-running CPU + GPU compute jobs (Python / Node / bash)
- \`realtime-scheduled-app\` - recipe: realtime presence/messages + DB function + scheduled poster, end-to-end
- \`web-app-basics\` - coding guidelines, file structure, HTML/CSS/JS patterns

Kit skills (reusable building blocks - \`gipity add <kit>\`):
- \`audio-align\` - the audio-align kit: forced alignment of audio + lyrics into word-level timing JSON

Other key skills:
- \`sandbox-tools\` - cloud sandbox capabilities and pre-installed tools
- \`tts\` - agent-side speech tools (different from the \`app-tts\` HTTP service)`;

export const DEFINITION_OF_DONE = `## Definition of done (build tasks)
1. \`gipity deploy dev\` succeeds and you have a live URL.
2. \`gipity page inspect <url>\` returns no console errors and the page loads (HTTP 200, no blank screen).
3. For apps with functions: \`gipity test\` passes.
4. You told the user the live URL.

If any step fails, fix it before claiming done - do not report success on a broken deploy.`;

export const GIPITY_TAGLINE = `The full-stack platform tuned for AI agents.`;

