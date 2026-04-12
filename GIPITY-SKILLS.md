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
| `gipity browser <url>` | Inspect a URL: console errors, performance |
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

If `gipity scaffold` fails because the project already has files, either:
- Create a new project: `gipity project create "<name>" --switch`, then scaffold
- Or skip scaffold and build manually using the workflow above

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
