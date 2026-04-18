# Gipity Integration — Claude Code Skills

This directory mirrors a Gipity-hosted project. There is no local runtime.
Do NOT run `npm install`, `npm start`, `node`, `python`, or any local execution commands.
All code execution happens on Gipity's hosted platform.

## Core Commands (direct CLI, no LLM overhead)

| Command | Purpose |
|---------|---------|
| `gipity sync [up\|down\|check]` | Sync files between local and Gipity |
| `gipity deploy [dev\|prod]` | Deploy and get live URL |
| `gipity db query "SQL"` | Execute SQL on project database |
| `gipity db list [--all]` | List databases (--all for account-wide view) |
| `gipity db create <name>` / `gipity db drop <name> [--project <slug>]` | Create or drop databases |
| `gipity memory read/write/list` | Read/write agent or project memory |
| `gipity sandbox run "<code>" --lang [js\|py\|bash]` | Execute code in Gipity sandbox. Output files are automatically saved to the project. |
| `gipity status` | Check project, auth, sync status |
| `gipity push <file>` | Push single file (usually automatic via hook) |
| `gipity file [ls\|cat\|tree]` | Browse remote files |
| `gipity project [list\|create\|switch\|delete]` | Manage projects |
| `gipity agent [list\|create\|switch\|set]` | Manage agents |
| `gipity workflow [list\|run\|enable\|disable]` | Manage workflows |
| `gipity scaffold [title] --type <type>` | Create app structure (web, 2d-game, 3d-world, app-itsm, api) |
| `gipity fn [list\|call <name> [body]\|logs <name>]` | Manage and call serverless functions |
| `gipity test [path]` | Run project tests in sandboxed containers |
| `gipity page-inspect <url>` | One-shot page inspect: console errors, timing, failed resources. For interactive debugging (screenshots, clicks, eval), use the `browser` agent tool. |
| `gipity records [query\|schema]` | Query and manage Records API tables |
| `gipity domain [list\|add\|remove]` | Manage custom domains |
| `gipity credits` | Check balance and usage |
| `gipity skills [list\|search\|install]` | Manage agent skills |
| `gipity rbac [list\|grant\|revoke]` | Manage RBAC policies |
| `gipity audit [query]` | Query audit logs |
| `gipity logs fn <name>` | View function execution logs |

All commands support `--json` for structured output.
When running commands that produce structured results, always pass `--json` for clean output. This avoids ANSI colors and progress indicators that waste tokens. Human-readable format is only needed when the user explicitly asks to see formatted output.

## Run / Test Workflow

1. Edit files locally (auto-pushed to Gipity via hook)
2. `gipity deploy dev` → returns live URL
3. `curl <url>` or WebFetch to verify output
4. `gipity deploy prod` when ready for production

URL pattern: `https://dev.gipity.ai/{accountSlug}/{projectSlug}/`

## API Development (Functions, Database & Tests)

### Function File Format

Functions are JavaScript files in `functions/`. Each exports a default async handler:

```js
// functions/get-items.js
export default async function getItems({ category }, { db }) {
    const { rows } = await db.query(
        'SELECT * FROM items WHERE category = $1', [category]
    );
    return rows;
}
```

**Arguments:**
- First: request body (parsed JSON from the caller)
- Second: services object `{ db, fetch, secrets, env, console }`

**Return value** becomes `{ data: <your return> }` in the HTTP response.

### Database Helpers (via `db`)

```js
const { rows } = await db.query('SELECT * FROM orders WHERE user_id = $1', [userId]);
const user     = await db.findOne('users', { id: userId });
const items    = await db.findMany('orders', { where: { status: 'pending' }, limit: 10 });
const inserted = await db.insert('orders', { user_id: 1, total: 99.99 });
const updated  = await db.update('orders', { id: orderId }, { status: 'shipped' });
await db.delete('orders', { id: orderId });
```

Only declared `tables` are accessible. DDL is blocked inside functions.

### gipity.yaml Manifest

Functions auto-deploy as public endpoints. Declare in `function_definitions` only when you need non-default permissions:

```yaml
- name: functions
  type: functions
  source: functions
  function_definitions:
    - name: get-items
      auth: public
      tables: [items]
    - name: get-weather
      auth: public
      fetch_domains: [api.example.com]
    - name: my-todos
      auth: user
      tables: [todos]
```

### Writing Tests

```js
// tests/api/get-items.test.js
test('get-items returns items', async (ctx) => {
    const result = await ctx.fn.call('get-items', { category: 'fruit' });
    assert.ok(Array.isArray(result.data), 'should return an array');
});
```

- `ctx.fn.call(name, params)` — call a deployed function
- `test()` and `assert` are provided as globals by the harness — do NOT `import` them
- Write tests for every new function by default; use judgment for trivial glue code or throwaway experiments
- Tests run in sandboxed containers — no raw DB access

### API Dev Workflow

1. Write function in `functions/{name}.js`
2. Add to `gipity.yaml` under `function_definitions` (if non-default permissions needed)
3. Write tests in `tests/api/{name}.test.js`
4. `gipity deploy dev --json`
5. `gipity test --json`

### When Scaffold Fails

If `gipity scaffold` fails because the project already has files:

- **User wants to start over in the *same* project** (most common — they're iterating):
  1. `gipity file rm src` — removes the old scaffold directory (recursive, no extra flag needed)
  2. `gipity scaffold --type <type>` — re-runs cleanly
- **User wants a *different* project** — keep the current one, create a fresh one:
  `gipity project create "<name>"` materializes it under `~/GipityProjects/<slug>` and links this machine. Then tell the user to exit Claude (Ctrl+D) and run `gipity claude` — the new project will be at the top of the picker. Once in that session, run `gipity scaffold --type <type>`.
- **User told you to keep their existing files** — skip scaffold and build manually using the workflow above

`gipity file rm <path>` recursively deletes files or directories. Non-scaffold content (media, data, notes) lives outside `src/` and is not touched by the delete-and-rescaffold flow.

## App Services (HTTP API for deployed apps)

Every project automatically exposes a set of platform services that the **deployed app** (frontend or function) can call over HTTP. No setup, no keys to manage — billing defaults to `owner_pays` (your Gipity credits). These are different from agent tools: they are endpoints your shipped app calls at runtime.

All services live under `https://a.gipity.ai/api/<PROJECT_GUID>/services/<name>`. The project GUID is the slug of the deployed project (`gipity status --json` → `project.guid`).

### Universal auth pattern (`X-App-Token`)

Every service call needs an app token. Mint one with a POST to the API server:

```js
// MUST be the absolute URL — '/api/token' would hit the app host, not the API
const r = await fetch('https://a.gipity.ai/api/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: '<PROJECT_GUID>' })
});
const { data: { token } } = await r.json();   // NOTE: token is at .data.token
// Cache for the session — tokens last ~1 hour
```

Common mistakes:
- Using a relative URL (`/api/token`) — hits the app host, 404s
- Reading `json.token` instead of `json.data.token`
- Using GET — must be POST with `{ app: '<PROJECT_GUID>' }` body
- Treating the project GUID as the token — the GUID identifies the app; you still need to mint a bearer token

For `user_pays` services or `auth_level: "user"` functions, also pass `credentials: 'include'` so the user's `.gipity.ai` session cookie is sent. See **Auth (user sign-in)** below.

### Rate limits & shared rules

- All `/services/*` endpoints share a per-IP rate limit window. `RateLimit-*` headers are returned on every response.
- Media outputs (images, audio, video) return a permanent CDN URL on `media.gipity.ai` — no auth required to fetch.
- `credits_used` is included in every response.
- `provider`/`model` fields are optional — every service has sensible defaults.

### LLM — `POST /services/llm`

OpenAI-compatible chat completions across Anthropic + OpenAI models. Use `prompt` for one-shot, `messages` for full conversations. Set `stream: true` for SSE.

```js
const r = await fetch(`https://a.gipity.ai/api/${APP}/services/llm`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: 'Answer concisely.' },
      { role: 'user', content: 'Capital of France?' }
    ],
    model: 'gpt-5-mini'        // optional; default is gpt-5-mini
  })
});
const data = await r.json();
const answer = data.choices[0].message.content;
// data.usage = { prompt_tokens, completion_tokens, total_tokens }
```

- Models: list via `GET /services/llm/models`
- Image input: `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }` — only `data:` URIs; external URLs return 400
- No `response_format: json` — parse the string yourself and strip ` ``` ` fences if present
- Streaming chunks: `data: {"choices":[{"delta":{"content":"..."}}]}` then `data: [DONE]`

### TTS — `POST /services/tts`

Text-to-speech. ElevenLabs (default), OpenAI, or Gemini. Returns an MP3 URL — `new Audio(url).play()` and you're done. **Client-callable. Do NOT write a server-side `speak` function or a browser-fallback.**

```js
const r = await fetch(`https://a.gipity.ai/api/${APP}/services/tts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({
    text: 'Welcome to the future of AI!',
    voice_id: 'JBFqnCBsd6RMkjVDRZzb',   // optional; default = George
    provider: 'elevenlabs'                // 'elevenlabs' | 'openai' | 'gemini'
  })
});
const { url } = await r.json();
new Audio(url).play();
```

- Voices: `GET /services/tts/voices?provider=elevenlabs`
- Gemini extras: `language` (BCP-47, e.g. `ja-JP`) and `speakers: [{name,voice},...]` for up to 2-speaker dialogue (text uses `Name: line\n` format)
- Max ~5,000 chars per call

### Image generation — `POST /services/image`

OpenAI (`gpt-image-1`, `dall-e-3`), BFL/Flux (default), Gemini.

```js
const r = await fetch(`https://a.gipity.ai/api/${APP}/services/image`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({
    prompt: 'A cat wearing a top hat, studio lighting',
    provider: 'openai',           // optional; default 'bfl'
    size: '1024x1024',            // OpenAI: 1024x1024, 1024x1536, 1536x1024
    quality: 'auto'               // gpt-image-1: low/medium/high/auto
  })
});
const { url } = await r.json();   // permanent CDN PNG/JPEG
```

- Gemini uses `aspect_ratio` (e.g. `16:9`) and `image_size` tier (e.g. `1K`, `2K`) instead of `size`
- List models: `GET /services/image/models`

### Audio: sound effects, music, transcription

Three separate endpoints, all under the same shared rate limit.

**Sound effects** — `POST /services/sound`
```js
fetch(`https://a.gipity.ai/api/${APP}/services/sound`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({
    text: 'thunder rumbling in the distance',
    duration_seconds: 5,           // 0.5 – ~22
    prompt_influence: 0.5          // 0–1
  })
}); // → { url, duration_seconds, credits_used }
```

**Music** — `POST /services/music`
```js
fetch(`https://a.gipity.ai/api/${APP}/services/music`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({
    prompt: 'upbeat lo-fi hip hop with piano',
    duration_seconds: 30,          // 3 – ~300
    instrumental: true
  })
}); // → { url, duration_seconds, credits_used }
```

**Transcription (STT)** — `POST /services/transcribe` (multipart)
```js
const fd = new FormData();
fd.append('audio', fileInput.files[0]);   // mp3/wav/m4a/etc, up to 100MB
fd.append('provider', 'elevenlabs');      // or 'openai'
fd.append('diarize', 'true');             // optional speaker labels
fd.append('language', 'en');              // optional, auto-detected
const r = await fetch(`https://a.gipity.ai/api/${APP}/services/transcribe`, {
  method: 'POST',
  headers: { 'X-App-Token': token },      // do NOT set Content-Type for FormData
  body: fd
});
const { text, words, language, duration_seconds } = await r.json();
```

### Video — `POST /services/video`

Google Veo 3.1, generates up to 8s with audio. Returns 30–120s after the request.

```js
const r = await fetch(`https://a.gipity.ai/api/${APP}/services/video`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({
    prompt: 'Close-up of coffee being poured into a cup, slow motion',
    model: 'veo-3.1-fast-generate-preview',  // or veo-3.1-generate-preview
    aspect_ratio: '16:9',                     // 16:9 | 9:16 | 1:1
    resolution: '1080p'                       // 720p | 1080p | 4k
  })
});
const { url } = await r.json();   // permanent CDN MP4 with AI audio
```

CLI shortcut: `gipity generate video "a cat playing piano" --aspect 9:16 -o cat.mp4`.

### File uploads — `/uploads/init` + `/uploads/complete`

Presigned S3 URLs — client PUTs directly to S3 (no proxy). Up to 30 GB. Easiest path is the helper script:

```html
<script src="https://media.gipity.ai/scripts/gipity-upload.js"></script>
<script>
  const result = await Gipity.upload(fileInput.files[0], {
    appGuid: '<PROJECT_GUID>',
    appToken: token,
    onProgress: pct => bar.style.width = pct + '%',
    public: false,
    table: 'attachments',         // optional: associate with a record
    recordId: 'rec_123'
  });
  console.log(result.guid, result.url);
</script>
```

Manual three-step flow if you can't use the helper:

```js
// 1. init
const init = await fetch(`https://a.gipity.ai/api/${APP}/uploads/init`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size })
}).then(r => r.json());

// 2. PUT to S3 (no auth header — URL is pre-signed)
await fetch(init.data.url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });

// 3. complete
const done = await fetch(`https://a.gipity.ai/api/${APP}/uploads/complete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
  body: JSON.stringify({ upload_guid: init.data.upload_guid })
}).then(r => r.json());
// done.data.url → permanent file URL; thumbnails auto-generated for images <10MB
```

List/read files:
- `GET /api/<APP>/files?table=incidents&record_id=42` — list
- `GET /api/<APP>/files/:guid` — metadata + variants
- `GET /api/<APP>/files/:guid/content` — download (302 to S3)
- `GET /api/<APP>/files/:guid/variants/:type` — variant (e.g. `thumbnail`, `text`)

### Auth (user sign-in / `user_pays` / `auth_level: "user"`)

When a function declares `auth: user` in `gipity.yaml`, or an LLM service uses `user_pays`, the app needs to sign the user in via Gipity. Always send `credentials: 'include'` so the cross-origin `.gipity.ai` session cookie travels.

```js
const r = await fetch(`https://a.gipity.ai/api/${APP}/auth/status`, {
  credentials: 'include',
  headers: { 'X-App-Token': token }
});
const auth = await r.json();
// { authenticated, consented, user, loginUrl?, consentUrl? }

if (!auth.authenticated) {
  // Popup flow (recommended): app stays visible
  window.open(auth.loginUrl + '&mode=popup', 'gipity_auth', 'width=450,height=600');
  // Or redirect: location.href = auth.loginUrl + '&return=' + encodeURIComponent(location.href)
} else if (!auth.consented) {
  window.open(auth.consentUrl + '&mode=popup', 'gipity_auth', 'width=450,height=600');
} else {
  // auth.user.guid is stable — use it for per-user storage in your functions (ctx.auth.userId)
}
```

Function call error codes when auth is missing:
- `LOGIN_REQUIRED` (401) → redirect to `error.loginUrl`
- `CONSENT_REQUIRED` (403) → redirect to `error.consentUrl`

Append `&return=<app_url>` so users come back to your app after auth (must be on `app.gipity.ai`, `dev.gipity.ai`, or `gipity.ai`).

Lightweight identity check (no app context): `GET /api/auth/me` with `credentials: 'include'` → `{ user: {guid,displayName,avatarUrl,accountSlug} | null }`.

### Realtime multiplayer — `wss://rt.gipity.ai`

Colyseus rooms over WebSocket. Two room types:
- **relay** — pure message broker, no server state. Good for chat, signaling, simple multiplayer.
- **state** — server-authoritative shared state with auto-tracked players + key-value `data` map. Good for games, collaborative editors, dashboards.

Create a room first (one time, from the CLI/agent):
```bash
gipity chat "create a state realtime room named game-lobby, max 50 clients, public auth"
# or via the realtime_room agent tool: action=create room_type=state
```

Connect from the app:
```html
<script src="https://unpkg.com/colyseus.js@^0.16/dist/colyseus.js"></script>
```
```js
const { data: { token } } = await (await fetch('https://a.gipity.ai/api/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: '<PROJECT_GUID>' })
})).json();

const client = new Colyseus.Client('wss://rt.gipity.ai');
const room = await client.joinOrCreate('state', {
  app: '<PROJECT_GUID>', room: 'game-lobby', token
});

// IMPORTANT: state.players / state.data are undefined on a fresh room.
// Always attach listeners inside onStateChange with a guard:
let initialized = false;
room.onStateChange((state) => {
  if (!initialized && state.players && state.data) {
    initialized = true;
    state.players.onAdd((p, sid) => {/* join */});
    state.players.onRemove((p, sid) => {/* leave */});
    state.data.onChange((value, key) => {
      const parsed = JSON.parse(value);   // values are JSON strings
    });
  }
});

room.send('set_data', { key: 'board', value: JSON.stringify(Array(9).fill(null)) });
```

Room discovery (the client lib has **no** `getAvailableRooms()` — use REST):
```js
const { rooms } = await (await fetch(
  `https://rt.gipity.ai/rooms?room=game-lobby&token=${encodeURIComponent(token)}`
)).json();
// rooms = [{ roomId, clients, maxClients, metadata }, ...]
const open = rooms.find(r => r.clients < r.maxClients);
const room = open
  ? await client.joinById(open.roomId, { app: '<PROJECT_GUID>', room: 'game-lobby', token })
  : await client.joinOrCreate('state', { app: '<PROJECT_GUID>', room: 'game-lobby', token });
```

Tips:
- Split state into many small `data` keys, not one big JSON blob — every key change re-syncs the entire value.
- For relay rooms, any unrecognized message type is broadcast to all other clients (`room.send('explosion', {...})` → `room.onMessage('explosion', cb)`).
- For `auth_level: "user"` rooms, pass `credentials: 'include'` to the token fetch and the user's session cookie is used for membership.

### When to choose what

| Need | Use |
|------|-----|
| Talk to an AI from the frontend | `/services/llm` (skip writing a function) |
| Speak text aloud in the browser | `/services/tts` → `new Audio(url).play()` (no browser-TTS fallback needed) |
| Speech-to-text from a recording | `/services/transcribe` (multipart, client-side) |
| Generate an image/video | `/services/image` or `/services/video` |
| User-uploaded files | `gipity-upload.js` helper or `/uploads/init`+`/uploads/complete` |
| Per-user data, paid by the user | `auth: user` function + `user_pays` LLM + popup login |
| Live shared state across users | `wss://rt.gipity.ai` state room |

Full canonical references live in the `app-llm`, `app-tts`, `app-image`, `app-audio`, `app-video`, `app-files`, `app-auth`, and `app-realtime` skills (loaded by the cloud agent on demand). The blocks above should be enough to write working code without round-tripping to `gipity chat`.

## Delegate to Gip (for capabilities not in the CLI)

The Gipity platform has 90+ tools. The CLI exposes the common ~30 directly; the rest are only reachable by asking Gip, the cloud agent that runs on Gipity. Use `gipity chat "<task>"` to hand off:

- **Video**: generation and understanding
- **Audio**: music, sound effects, TTS/speech, transcription, source isolation
- **Images**: generation (OpenAI, Flux), understanding
- **Web search**: Brave API, Twitter/X search
- **Gmail**: search, read, send, reply (auth flow required)
- **Calendar**: list, create, update, delete events
- **Realtime multiplayer**: create/manage Colyseus rooms
- **Push notifications**: send to user's connected devices
- **Workflows**: create cron/webhook multi-step pipelines
- **Cross-model queries**: ask GPT-5, Claude Opus, etc. for a second opinion
- **Complex multi-step tasks**: anything requiring agent reasoning or orchestration

Files created by Gip auto-sync to your local directory.

## Sync Behavior

- **Auto-push**: Files are pushed to Gipity after every Write/Edit (hook)
- **Auto-pull**: Remote changes are pulled before each prompt (hook)
- **Manual refresh**: `gipity sync check` during long tasks to see if anything changed
- **After chat**: `gipity chat` auto-pulls files when the agent modifies them
- **Tool-generated files**: Images, audio, video, and other files created by remote agent tools are project files — they sync like any other file

## Database Access

```bash
gipity db create my_app_db         # Create a database
gipity db query "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT, email TEXT)"
gipity db query "INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')"
gipity db query "SELECT * FROM users"
```

## Memory (Persistent Knowledge)

```bash
gipity memory list                                    # List all topics
gipity memory read user_preferences                   # Read a topic
gipity memory write api_notes "Rate limit is 100/min" # Write a topic
gipity memory list --project                          # Project-scoped memory
```

## Important Notes

- This is a **hosted project** — there is no local server, no build step
- Files are served as-is from S3/CloudFront when deployed
- The Gipity agent has access to: sandboxed code execution (Node.js, Python, Bash), Docker containers with pre-installed tools (ImageMagick, FFmpeg, pandas, etc.), databases, memory, image generation, TTS, web search, and more
- Use `gipity status` to check auth and sync state
