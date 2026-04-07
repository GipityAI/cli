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
| `gipity db list` / `gipity db create <name>` | Manage databases |
| `gipity memory read/write/list` | Read/write agent or project memory |
| `gipity sandbox run "<code>" --lang [js\|py\|bash]` | Execute code in Gipity sandbox |
| `gipity status` | Check project, auth, sync status |
| `gipity push <file>` | Push single file (usually automatic via hook) |

All commands support `--json` for structured output.

## Run / Test Workflow

1. Edit files locally (auto-pushed to Gipity via hook)
2. `gipity deploy dev` → returns live URL
3. `curl <url>` or WebFetch to verify output
4. `gipity deploy prod` when ready for production

URL pattern: `https://dev.gipity.ai/{accountSlug}/{projectSlug}/`

## Delegate via `gipity chat` (full 90+ tool Gipity agent)

For operations beyond the core commands, delegate to the Gipity agent:

- **Workflows**: `gipity chat "create a cron workflow that runs every hour"`
- **Image generation**: `gipity chat "generate a hero image for the landing page"`
- **TTS/Audio**: `gipity chat "generate speech audio for this text"`
- **Web search**: `gipity chat "search the web for current pricing of X"`
- **App scaffolding**: `gipity chat "scaffold a todo app with index.html and app.js"`
- **API procedures**: `gipity chat "define an API procedure for user registration"`
- **Complex multi-step tasks**: anything requiring agent reasoning or multi-tool orchestration

Files created by the agent are automatically synced to your local directory.

## Sync Behavior

- **Auto-push**: Files are pushed to Gipity after every Write/Edit (hook)
- **Auto-pull**: Remote changes are pulled before each prompt (hook)
- **Manual refresh**: `gipity sync check` during long tasks to see if anything changed
- **After chat**: `gipity chat` auto-pulls files when the agent modifies them

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
