/**
 * Knowledge content shared across Gipity surfaces.
 *
 * AUTO-GENERATED - do not edit directly.
 * Source: platform/docs/knowledge/*.md + docs/skills/*.md frontmatter + gipity-overview.ts
 * Run `just build-knowledge` to refresh.
 */

export const BUILD_VS_NON_BUILD_RULE = `## When to add a template
If the user wants a deployable app (web, game, API): run \`gipity add <template>\` before writing any files. A template wires up \`gipity.yaml\`, deploy config, and sync; hand-written files miss all of it.
If it's a one-off task (analysis, media, data, research): skip it - use \`gipity sandbox run\` or work with files directly.
If ambiguous: ask one short clarifying question.

Templates:
    - \`web-simple\` - Landing page, dashboard, calculator, canvas demo, visualization, animation, single-page tool
    - \`web-fullstack\` - Web app with login, database, or API - CRM, invoice tracker, booking system, admin panel
    - \`web-vision-cam\` - Live camera app with gesture, pose, or object detection - hand-tracking input, fitness/pose feedback, object-aware UI; on-device, no upload
    - \`object-spotter\` - Object-detection app - count or label things from the camera or a photo, inventory/shelf counting, custom-model detection; on-device, no upload
    - \`2d-game\` - Platformer, arcade, puzzle, endless runner, physics toy (Phaser 3)
    - \`3d-engine\` - Minimal 3D multiplayer base - Three.js + Rapier + Colyseus, no gameplay; build your own scene and mechanics on top
    - \`3d-world\` - Multiplayer world, 3D sandbox, shooter, exploration, virtual showroom (Three.js + Rapier + Colyseus)
    - \`api\` - Backend service, webhook, data pipeline, chatbot, cron job - no frontend
    - \`karaoke-captions\` - Forced-alignment app - karaoke captions, subtitle timing, language learning, dubbing alignment
    - \`outreach-agent\` - AI outreach / drip-email funnel - reach a list of people with personalized, human-approved emails that auto-send on a schedule and a self-improving agent that learns from your edits
    - \`paid-app\` - App that charges users money - SaaS subscription, paid membership, digital product store, "Pro" upgrade, paywalled content (Stripe one-time + subscriptions)
    - \`notify-demo\` - App that sends push notifications / alerts / reminders to users' phones or desktops - web push, PWA notifications, "notify me when..." features
When unsure, default to \`web-simple\`. After adding the template, edit the generated files, then \`gipity deploy dev\`.
Only skip this on a build request if the user explicitly says not to.

Hidden types (do NOT suggest unsolicited - use only when the user explicitly asks for that domain):
    - \`app-itsm\` - IT Service Management app (helpdesk, ticketing, incident management).
    - \`monitor\` - Account-wide observability dashboard - auto-installed; rarely picked manually.

Kits are reusable building blocks added to an existing app, not whole templates - their files land in \`src/packages/<name>/\`:
    - \`gipity add realtime\` - Multiplayer / presence / shared state - channels, host election, server-persisted sync. Engine-agnostic; works in any app.
    - \`gipity add web-vision-mediapipe\` - On-device camera vision - gesture recognition, body pose, object detection. Runs fully client-side via MediaPipe Tasks; no server, no upload. Web only.
    - \`gipity add web-vision-detect\` - High-accuracy object detection in the browser - YOLOX (Apache-2.0) on ONNX Runtime Web, WebGPU with WASM fallback. 80 COCO classes, three speed/accuracy presets, or bring your own custom-trained YOLO/YOLOX ONNX model. Client-side; no server, no upload. Web only.
    - \`gipity add chatbot\` - Drop-in chatbot - configurable persona, scope guardrails, static knowledge (20k budget), streaming responses. Headless engine + bubble widget; bring your own UI if you want. Works in any app.
    - \`gipity add audio-align\` - Audio + lyrics -> word-level timing JSON. Demucs vocal isolation + MMS_FA forced alignment, runs as a Modal L4 GPU job (~$0.01 per 3-min song). For karaoke captions, subtitling, language learning, dubbing alignment.
    - \`gipity add i18n\` - Multi-language for web apps - language picker, locale persistence, RTL, plural/translation lookup. Scaffolds src/js/strings.js and wires it up; move your copy there and read it with t('key'). Web only.
    - \`gipity add records\` - Registry-driven records: declare objects/fields as data, get generic CRUD functions with validation, full-text search, soft delete, ACTOR provenance, and an audit event spine - every write is transactional (row + event). Field types include relations ({id,label}), currency, emails/phones/links composites. Ships backend functions + migrations. Needs a database (web-fullstack/api template).
    - \`gipity add views\` - Generic UI over records-kit objects: sortable/filterable table with full-text search, create/edit/delete forms with type-appropriate widgets, kanban board with drag-to-update. Renders entirely from the field registry - zero per-object UI code. Requires the records kit.
    - \`gipity add agent-api\` - Make your app agent-operable: named API keys (kit_api_keys) let agents and scripts write through the records kit's single write path with AGENT/API actor attribution - machine writes land on the same audit spine as human edits. Requires the records kit.
    - \`gipity add contacts\` - Source-agnostic contact data layer for lead-gen/CRM apps: import people from LinkedIn CSV + Gmail + pasted lists, resolve duplicates into one person while keeping EVERY value from every source with provenance (multi-valued attributes, never overwrites). Exact email/URL auto-merge; fuzzy name+company goes to a human merge-review queue (reversible). Re-imports detect job changes and emit signals. User-definable tags, full-text search, and a transactional event spine. Ships backend functions + migrations. Needs a database (web-fullstack/api template).
    - \`gipity add stripe\` - Charge your app's end-users for one-time purchases and subscriptions via Stripe. Owner connects their own Stripe account through Gipity-hosted onboarding (no API keys to paste); money lands in their account, Gipity takes a small platform fee. Ships a buy-button / pricing component, a subscription-status helper for gating UI, a webhook-verified fulfillment function, and the payments/subscriptions tables. The platform brokers checkout + signature-verified webhooks. Needs a database (web-fullstack/api template).
    - \`gipity add notify\` - Web push notifications for any web app, including iOS home-screen web apps (iOS 16.4+). The platform owns the VAPID keys, encryption, and delivery — no keys to paste, no crypto, no server. Ships a <gipity-notify-button>, a service worker, and a PWA manifest; the device subscribes itself and self-heals stale subscriptions. Send from a function with the injected notify() service (one flat credit per send, owner-billed) or test with \`gipity notify test\`. Works in any template — no database required.`;

export const SKILLS_CONTENT = `# Gipity Integration

Gipity is the cloud platform your project runs on - hosting, databases, deployment, file storage, code execution, workflows, and monitoring. Gip is the cloud agent that runs on Gipity.

Prefer the cheapest option that works - CLI and sandbox are instant and free, app services are runtime HTTP calls, \`gipity chat\` burns LLM tokens:

1. CLI commands (fast, no agent overhead). The \`gipity\` CLI covers add, deploy, db, fn, logs, browser, sync, memory, skill, email, and more. All commands support \`--json\`. You can send email yourself - \`gipity email send\` goes out as the agent from \`gipity@gipity.ai\` with no setup or API keys (\`gipity skill read email\`); don't build a \`mailto:\` workaround or reach for an SMTP library.
2. Cloud sandbox via \`gipity sandbox run\` - Docker container with pre-installed tools for media (ffmpeg, ImageMagick, sox), documents (pandoc, LibreOffice), and data (pandas, matplotlib, sqlite3). Run \`gipity skill read sandbox-tools\` for the full toolkit. No network from inside the sandbox - fetch what you need before sending it in.
3. App services - runtime HTTP endpoints your deployed app calls directly at \`https://a.gipity.ai/api/<PROJECT_GUID>/services/*\`. Available: LLM, TTS, image, sound, music, transcribe, video, file upload, realtime, location, push notifications (Gipity Notify - \`gipity add notify\`, send from a function with the injected \`notify()\`; see \`app-notify\`). Load the matching skill (\`app-llm\`, \`app-tts\`, etc.) before writing service code - they have the schemas, auth pattern, and common-mistake guards. For one-off generation during development, prefer \`gipity generate <image|video|speech|sound|music>\` or \`gipity chat\` - direct generation always bills you (the owner), regardless of any service \`billing_mode\` (that setting only governs the deployed app's runtime calls; never flip it just to create assets). \`gipity generate\` saves to a generic file in the current directory by default (e.g. \`./generated.png\`) - pass \`-o <path>\` to write it straight into your source tree so it deploys (e.g. \`gipity generate image "hero banner" -o src/assets/images/hero.png\`) instead of generating at cwd and moving it.
4. Delegate to Gip (\`gipity chat "<task>"\`) - only when the work genuinely needs agent reasoning or a tool not in the CLI, sandbox, or app services. Required for: Twitter/X search, Gmail, calendar, push notifications, video understanding, audio source isolation, cross-model second opinions, multi-step orchestration. Don't use \`gipity chat\` for anything the sandbox can do - it's slower and burns tokens.

You are the developer. Write files in this directory - the Gipity Claude Code plugin's hooks auto-sync them to Gipity. Don't run \`npm install\`, \`npm start\`, \`node\`, or \`python\` locally; there is no local runtime. Code runs in the Gipity sandbox.

## Use first-party services before reaching outside

Gipity ships first-party services for what apps usually pull from third parties - auth, location/geocoding, LLM, image/audio/video generation, transcription, file uploads, realtime, web push notifications (Gipity Notify - no VAPID keys, no Firebase/OneSignal; works on iOS home-screen web apps), and email (send as the agent via \`gipity email send\`, or from a deployed app via a workflow \`notify\` step - no SMTP/SendGrid/Nodemailer). Before calling an external API or adding an npm package for one of these, check \`gipity skill list\` for a match. First-party services need no API keys, cost less, and keep data in-house. Reach outside only when the catalog has no equivalent - and say so when you do.

## Don't guess Gipity facts - look them up

When a user asks about Gipity itself - how to install it, what it costs, what's shipped, how a command or flag works - answer from an authoritative source, not memory, and don't hedge with "I don't want to guess." Check in this order: (1) \`gipity skill read <name>\` / \`gipity skill list\` - install and account basics live in \`getting-started\`; (2) \`gipity <command> --help\` for command syntax; (3) if it's genuinely not in the skills or CLI help, fetch the live site at \`https://gipity.ai\` (or web search) and cite what you found. A wrong or vague answer about the product is worse than spending one tool call to get the current, correct one.

## Plans, limits & upgrading - unblock the user

Gipity runs on **credits** (the one consumable) and **plans** (Free / Gipity Pro) that set limits and the monthly credit grant. When a metered action fails with a limit error - "limit reached", "on your plan", "Pro only", or "Insufficient credits" - that's your cue to help them upgrade, not just report the error. The play: name what they hit, run \`gipity credits list\` to compare plans, surface what Pro unlocks for *their* task, then run \`gipity credits buy\` and hand them the checkout link (it only prints a link - Stripe takes payment; nothing is charged until they click and pay). Do it proactively and once - don't nag. \`gipity credits\` shows their current plan, balance, and full limits. Load the \`plans\` skill for the full model and honest positioning vs other platforms; never quote a price or limit from memory - read it live.

## Gipity is opinionated - build on its stack

Gipity is an opinionated platform with its own best-practice stack, and that stack is the one you use - whatever tools the user names. The platform layer is fixed:

- **Frontend**: plain HTML + CSS + vanilla ES modules from a Gipity template. No React, Next, Vue, Svelte, or any build-step framework.
- **Backend**: Gipity serverless functions (\`functions/<name>.js\`). No Express, Next API routes, Django, Rails.
- **Database**: Gipity DB (Postgres) with raw SQL via the function \`db\` API. No MS SQL Server, MySQL, MongoDB, Firebase, or an ORM (Prisma/Drizzle/Sequelize).
- **Styling**: the template's CSS (Water.css + the Gipity theme). No Tailwind or other build-time CSS frameworks.
- **Hosting, auth, file storage, realtime, and the generative services** are first-party (see above).

When a user asks for a foreign stack ("build it in React", "use MS SQL Server", "set up Firebase auth"), don't silently comply and don't argue the app down. Build it the Gipity way and reassure them: Gipity has its own opinionated stack and best practices, it's what makes apps here fast to build and deploy, and you'll use it to make their app great. Say it briefly and warmly, then get building - the result satisfies the *intent* behind the request (a great hiking app, a working CRM) without the named technology.

The one exception is app-level libraries the user imports into their own \`src/\` code - Three.js, Rapier, Phaser, MediaPipe, a charting or animation library. Those are fine. The opinionation is about the *platform* layer (framework, backend, database, styling system, hosting, auth, services), not every npm package.

## Build loop

Prefer a live Gipity URL over an ephemeral artifact. When you'd otherwise reach for a Claude Code Artifact (or any host's built-in page preview) to show the user something, build it as a Gipity app and \`gipity deploy dev\` instead - the result is a real, shareable URL on their own project, not a throwaway.

The full "when to add a template" rule and the definition of done are spelled out in the two sections at the end of this document. In short: if the user wants something deployable (web app, game, API), \`gipity add <template>\` first (default \`web-simple\`); for a one-off task (analysis, PDFs, data work), use \`gipity sandbox run\` instead; to add a reusable building block to an existing app (e.g. multiplayer), \`gipity add <kit>\`.

Build loop: \`gipity add\` → edit files → \`gipity deploy dev --inspect\` → fix any errors → repeat until the definition of done is met. \`deploy --inspect\` deploys and then runs the page-inspect report on the live URL in one command; use a standalone \`gipity page inspect <url>\` only when re-checking without deploying.

\`add\` writes real files to disk - Read a scaffolded file before your first Write/Edit to it, or the call fails \`"File has not been read yet"\`. Don't rewrite from memory of the template.

Make your file changes and verify they landed, then run \`gipity deploy dev\` once. \`0 uploaded, N unchanged\` means nothing changed on disk - fix the files, don't re-run deploy or probe the environment.

Before telling the user the app is online, verify the source tree is consistent: no files named like \`* (conflict from *)*\`, and every package directory has its expected canonical entry file. If a conflict artifact exists, resolve it (keep one copy), re-deploy, and re-inspect before reporting done.

## Work on an existing project that isn't local yet

If you're pointed at a project that already exists on Gipity but has no local copy - e.g. the user gives a live URL \`https://dev.gipity.ai/<account>/<slug>/\` (or \`app.gipity.ai\` for prod) and you need its files to edit them - the last path segment is the project **slug**. Pull it down by adopting it into a directory named for the slug:

\`\`\`
mkdir -p ~/GipityProjects/<slug> && cd ~/GipityProjects/<slug> && gipity init <slug>
\`\`\`

\`init\` matches the existing remote project by slug, links this directory to it, and syncs its files down (you'll see \`Found existing project ...\` and \`Synced N changes\`). There's no separate \`clone\`/\`pull\` - \`init\` against a matching slug *is* the pull. After it finishes, the files are in cwd; edit and \`gipity deploy dev\` as usual. (Already linked to a different project in this dir? Switch and pull instead: \`gipity project <slug>\` then \`gipity sync\`. List your projects with \`gipity project --json\`.)

## CLI quick reference

Key commands: \`gipity add <template|kit>\`, \`gipity deploy dev\`, \`gipity sandbox run\`, \`gipity page inspect <url>\`, \`gipity page screenshot <url>\`, \`gipity db query "SQL"\`, \`gipity fn call <name>\`, \`gipity logs fn <name>\`, \`gipity secrets set <NAME> <value> [--account]\` (store an API key/token encrypted; read in functions via \`secrets.get('NAME')\` — never hardcode keys), \`gipity email send --to <addr> --subject <s> --body <b>\` (sends as \`gipity@gipity.ai\`; omit \`--to\` to self-send), \`gipity skill read <name>\`.
Rename for findability: \`gipity project rename <name>\` renames the current project's display name (the slug and deployed URLs never change); \`gipity chat rename <title>\` renames the current chat's tab title. Both are the display label users scan to switch between tabs — retitle a chat when the conversation clearly shifts to a new topic (sparingly, not every turn), and keep every project/chat title SHORT: 2-4 words, ≤40 characters, no trailing punctuation (e.g. "Stripe checkout", "Tetris game").
Pull an existing remote project local (given its URL/slug): \`mkdir -p ~/GipityProjects/<slug> && cd ~/GipityProjects/<slug> && gipity init <slug>\` (adopts the matching project and syncs files down - this is the "clone").
Move whole apps in/out: \`gipity save\` (export this project as a portable \`.gip\` bundle), \`gipity load <file.gip | github:owner/repo>\` (import as a NEW project; \`--inspect\` to preview), \`gipity github connect\` (1-2 click GitHub access for imports). Porting a Vercel/Replit/Lovable app? Load the \`app-import\` skill first.
For deterministic text questions (letter/word counts, substring occurrences, nth word/char, anagrams), use \`gipity text analyze "<text>"\` - local and instant, no sandbox or LLM needed.
Hit a platform bug or friction? File it in real time: \`gipity bug report --category <cli|deploy|template|kit|db|docs|skill|service|sandbox|other> --severity <S1|S2|S3|S4> --summary "<7 words max>" [--detail "<what failed + workaround>"]\` (see below).
Run \`gipity --help\` for the full list. Use \`--help\` on any command for details.

Function return shape: \`gipity fn call\`, the in-test \`ctx.fn.call\`/\`callAs\`, and the client \`Gipity.fn\` all return your function's value **unwrapped** - read/assert \`result.field\`. Only raw HTTP/\`curl\` wraps it as \`{ data: ... }\`; never write \`result.data.field\` in a test.

Tests are isolated, not run against your live DB: \`gipity test\` points \`ctx.fn.call\`/\`callAs\` at a throwaway copy of your database (your \`migrations/\` + \`seeds/\`), reset (truncate + reseed) before every run - so test rows never reach the deployed app and you don't write teardown. Functions see \`ctx.isTest === true\` during a run (use it to skip your own rate limiting); the platform also suppresses \`notify()\` push so a suite can't spam subscribers. Reference data tests need goes in seed files; a runtime-written settings table that isn't seeded goes under \`test.preserve\` in \`gipity.yaml\`. Build per-file fixtures in \`setup(fn)\` → \`ctx.fixtures\`, and namespace unique values with \`ctx.testId\`.

## Hit friction on the platform? Report it in real time

When *the Gipity platform itself* fights you — a CLI command errors or behaves unexpectedly, a doc/skill is wrong or missing, a deploy/template/kit/service/sandbox misbehaves — file a bug report the moment it happens, **even if you found a workaround and kept going.** Capturing it in the moment (with the real cause fresh) beats us mining it out of transcripts later.

\`\`\`
gipity bug report --category <cli|deploy|template|kit|db|docs|skill|service|sandbox|other> \\
                  --severity <S1|S2|S3|S4> \\
                  --summary "one line, 7 words max" \\
                  --detail "what you did, what failed, the workaround"
\`\`\`

- **Severity:** S1 blocker (no workaround) · S2 major (costly workaround) · S3 minor (easy workaround) · S4 friction (papercut).
- **summary** ≤ 7 words; **detail** as succinct as possible (a few sentences, not a transcript).
- **Never include PII or user data** (emails, names, secrets, tokens, prompt/file contents) — describe the platform problem in the abstract.
- File it for *platform* problems, not your own mistakes or the app's own bugs. One report per distinct problem.
- Reports go to a review queue for the team to triage into fixes; see what you've filed with \`gipity bug list\`.

## Tool output is complete and synchronous

Every tool call returns its full output with that call. There is no output buffer to flush. Never run no-op commands (echo, date, sleep, repeated reads) to "retrieve" or "flush" lagged output - if a result looks empty or delayed, treat it as the actual result and move on, or re-run the real command once.

## Files and sync

This directory is the app root - it holds \`.gipity.json\` (and \`gipity.yaml\` for backends) and is already your cwd, so run app commands here. Don't \`cd\` to a git root (\`git rev-parse --show-toplevel\`): when the app is nested in a larger repo that resolves outside the app.

Write files locally - the Gipity Claude Code plugin's hooks auto-push every save to Gipity and auto-pull remote changes (images, audio from \`gipity chat\`) before each turn. Use \`gipity sync\` if things get out of sync (or if the plugin isn't installed - \`gipity status --repair-hooks\` re-enables it). Deletes are safe - use \`rollback\` with a datetime to undo, or \`file_version_restore\` for individual files.

To keep local-only material (research clones, scratch data, vendored references) in the project directory without syncing or deploying it, list it in a \`.gipityignore\` at the project root - gitignore-style, one pattern per line, \`#\` comments. Ignored paths are invisible to sync in both directions; anything that already synced before being ignored stays on the server until you delete it.

### Where files go: deploy only ships \`src/\`

Deploy is opt-in, not opt-out: the \`files\` phase uploads **only** what's under \`src/\` (plus \`functions/\` and \`migrations/\` as backend, not CDN files). Anything else at the project root is kept but never deployed. Put each kind of file in the right bucket so scratch and reference material can't bloat a deploy:

- **\`src/\`** - the app itself. Synced **and** deployed to the CDN. Only app code, assets, and pages belong here.
- **\`tmp/\`** - ephemeral scratch: file conversions, intermediate outputs, design staging. **Already ignored** (never synced, never deployed) - the one place to do throwaway work. Use this single root. (\`*_tmp/\` dirs and \`.gipityscratch/\` are auto-ignored too, as a safety net, so legacy scattered scratch like \`_vsd_tmp/\` can't leak - but write new scratch to \`tmp/\`, not scattered dirs.) Because it never syncs, \`tmp/\` is also never mirrored into the sandbox: **don't stage \`gipity sandbox run\` inputs here** - the sandbox won't see them. Stage inputs under \`src/\`/\`docs/\` and delete them after.
- **\`docs/\`** - reference material you want to keep: UI/architecture diagrams, design decks, notes, ADRs. Synced and versioned on the server (backed up, rollback-able) but **never deployed**, because it's outside \`src/\`. This is the home for "keep forever, don't ship" artifacts.
- **\`tests/\`** - \`*.test.js\` suites. Synced, run by \`gipity test\`, never deployed. \`gipity test list [path]\` lists the test files (and what a filter selects) without running them.

Rule of thumb: shipping to users → \`src/\`; keep as reference → \`docs/\`; throwaway → \`tmp/\`.

Watch for **bulky output dirs dropped loose at the root** (e.g. \`out/\`, \`vsd_out/\`, \`renders/\`). Unlike scratch, those are NOT ignored - they sync on every push and re-hash on every deploy, which is the classic cause of a slow, bloated deploy. Move them into \`docs/\` if you want to keep them or \`tmp/\` if they're disposable.

## Skills (detailed documentation)

Run \`gipity skill list\` to see every skill. Run \`gipity skill read <name>\` to read one. Load the relevant skill before starting a task - they have the correct API patterns, code examples, and common mistakes.

App services skills (load before calling \`/services/*\` endpoints):
- \`app-audio\` - sound effects, music, transcription
- \`app-auth\` - sign in with Gipity, popup vs redirect
- \`app-files\` - uploads, variants, file listing
- \`app-image\` - text-to-image only (no input image / editing); providers, sizes, aspect ratios
- \`app-llm\` - chat completions, streaming, image input
- \`app-location\` - user location & reverse geocoding for deployed apps (first-party - no third-party geocoder)
- \`app-notify\` - web push notifications for deployed apps (incl. iOS home-screen web apps) - notify kit + injected notify() service, platform owns the keys
- \`app-payments\` - charge end-users real money - Stripe one-time purchases & subscriptions, via the stripe kit (gipity add stripe)
- \`app-realtime\` - Gipity Realtime rooms, relay vs state
- \`app-tts\` - voices, multi-speaker, languages
- \`app-video\` - Gipity Video: models, aspect, resolution

App development skills:
- \`agent-deploy\` - headless auth via agent API tokens (GIPITY_TOKEN) for unattended deploys
- \`app-database\` - app Postgres database: migrations, the db helper, transactions, table permissions
- \`app-debugging\` - debug a deployed app: page inspect/eval, screenshots, function logs
- \`app-development\` - functions, database, and API
- \`app-import\` - import apps from GitHub/.gip bundles (incl. Vercel/Replit/Lovable porting) and export any project as a portable .gip - app_import tool, gipity save/load
- \`app-testing\` - testing deployed app functions (ctx.fn.call/callAs, the isolated test DB)
- \`deploy\` - the deploy pipeline & gipity.yaml manifest
- \`jobs\` - long-running CPU + GPU compute jobs (Python / Node / bash)
- \`realtime-scheduled-app\` - recipe: realtime presence/messages + DB function + scheduled poster, end-to-end
- \`web-app-basics\` - coding guidelines, file structure, HTML/CSS/JS patterns
- \`web-ui-patterns\` - default Gipity look (theme tokens) + web UI recipes - feeds, copy-to-clipboard

Kit skills (reusable building blocks - \`gipity add <kit>\`):
- \`audio-align\` - the audio-align kit: forced alignment of audio + lyrics into word-level timing JSON
- \`chatbot\` - the chatbot kit: persona + scope guardrails + static knowledge, bubble widget or headless engine

Other key skills:
- \`email\` - sending email as the agent from gipity@gipity.ai (no setup/keys) — plus Gmail-thread replies, HTML formatting, images
- \`sandbox-tools\` - cloud sandbox capabilities and pre-installed tools
- \`tts\` - agent-side speech tools (different from the \`app-tts\` HTTP service)`;

export const DEFINITION_OF_DONE = `## Definition of done (build tasks)
1. \`gipity deploy dev\` succeeds and you have a live URL.
2. \`gipity page inspect <url>\` returns no console errors and the page loads (HTTP 200, no blank screen). (\`gipity deploy dev --inspect\` covers 1 and 2 in one command.)
3. For apps with functions: \`gipity test\` passes.
4. Non-rendered files the task called for (\`llms.txt\`, \`AGENTS.md\`, \`SKILL.md\`, \`robots.txt\`, served JSON, etc.): \`page inspect\` only sees rendered HTML, so verify them with \`gipity page fetch <url> <files...>\`. It flags any that 404 or come back as the static-host shell (a missing file is served as \`index.html\` with a 200, so a bare status check would pass) and checks each \`content-type\`.
5. You told the user the live URL.

If any step fails, fix it before claiming done - do not report success on a broken deploy.`;

export const GIPITY_TAGLINE = `The full-stack platform tuned for AI agents.`;

