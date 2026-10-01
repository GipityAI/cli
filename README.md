# Gipity CLI

The cloud backend for your coding agent.

[Gipity](https://gipity.ai) is the backend your coding agent gets by installing one CLI and one skill: hosting, databases, serverless functions, file storage, a code sandbox, CPU/GPU jobs, AI models and media services, workflows, and a quick LLM call (`gipity ask`), plus templates and kits that give you a running start.

This CLI connects your coding agent ([Claude Code](https://claude.ai/claude-code), Codex, Grok, or opencode) to Gipity: deploy, query the database, call functions, test pages in a real browser, generate images and audio, and keep your local files in sync with your Gipity project.

## Getting Started

**Step 1 - install.** One line installs everything. It sets up Node 22+ (if you don't already have it) and the Gipity CLI, with no sudo required:

```bash
# macOS / Linux / WSL
curl -fsSL https://gipity.ai/install.sh | bash

# Windows (PowerShell)
irm https://gipity.ai/install.ps1 | iex
```

**Step 2 - pick your path.** There are two, and they mix freely:

| You want to... | Run |
|----------------|-----|
| Start building right now, from anywhere | `gipity build` |
| Use your own workflow in your own directory | `gipity init`, then `claude` / `codex` / `grok` / `opencode` |

### `gipity build` - start from anywhere

One command does everything: logs you in (6-digit email code), lets you pick or create a project, lets you pick your coding agent (Claude Code, Codex, or Grok - it installs the agent if needed), and launches it with the whole Gipity stack wired up.

```bash
gipity build
```

### `gipity init` - bring your own workflow

Prefer launching your agent yourself? From any project directory:

```bash
gipity init
claude        # or codex, grok, or opencode - whatever you use
```

`init` links the directory to a Gipity project, writes CLAUDE.md/AGENTS.md primers so your agent understands Gipity, and installs the Gipity skills + file-sync hooks into the agent CLIs found on your machine (Claude Code, Codex, Grok; Cursor and Gemini get primer files too).

### Prefer npm

If you already have **Node.js 22+** you can install directly:

```bash
npm install -g gipity
```

If that fails with `EACCES`, your npm global prefix is root-owned. Don't reach for `sudo`: point npm at a user-owned prefix instead (`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your `PATH`), or just use the one-line installer above, which does this for you. See https://docs.npmjs.com/resolving-eacces-permissions-errors.

## Updates

The CLI auto-updates in the background. After your one-time `npm install -g gipity`, every run silently checks npm for a new version and installs it into `~/.gipity/local/` - no sudo, no re-running install commands. The new version takes effect on your next invocation.

```bash
gipity doctor   # show install version, last update check, opt-out status
gipity update   # force an immediate update now
```

To opt out: `export DISABLE_AUTOUPDATER=1` (matches Claude Code), or set `{ "autoUpdates": false }` in `~/.gipity/settings.json`. CI environments are auto-detected and skipped.

## What `gipity build` looks like

```
  Welcome to Gipity
  ─────────────────

  Email: you@example.com
  Check your email for a 6-digit code.

  Code: 482910
  Authenticated as you@example.com

  Your projects:
    1. my-website (my-website)
    2. Create new project

  Choose (1-2): 2
  Project name [project-001]: cool-app
  Creating "cool-app"...
  Created.

  Which coding agent?
    1. Claude Code (Anthropic)
    2. Codex (OpenAI)
    3. Grok (xAI)

  Launching Claude Code, powered by Gipity.
```

If you're already logged in, it skips straight to the project picker. If you're already inside a Gipity project directory, it uses that project. Your last-used agent is the default next time.

Projects live in `~/GipityProjects/{project-slug}/` - created automatically on first use. Any extra flags (like `--model opus`) pass straight through to the agent. Useful flags:

```bash
gipity build --agent codex             # Skip the agent picker
gipity build --new-project --name app  # Create a fresh project without the picker
gipity build --project my-app          # Open a specific project
gipity build --here                    # Use the current directory, not ~/GipityProjects/
gipity build -p "add a contact form"   # Headless one-shot (no interactive session)
```

### The manual way

If you prefer to do things step by step:

```bash
gipity login --email you@example.com
gipity login --code 123456
cd my-project
gipity init
claude        # or codex, grok, or opencode
```

## Coding Agent Integration

This is the good part. When you run `gipity init` (or `gipity build`) in a project, it wires two hooks into your agent (Claude Code, Codex, and Grok all get them):

**Auto-push** - Every time your agent writes or edits a file, it gets pushed to Gipity in the background. No extra steps.

**Auto-pull** - Before each turn, your agent pulls any changes that happened remotely (files written by a sandbox run, a workflow, or another machine). It sees what changed and can pick up where things left off.

Session recording is off by default. To keep your Claude Code sessions in your Gipity project (the Chats tab in your dashboard), run `gipity init --capture`; turn it off again with `gipity init --no-capture`.

### What gets set up

```
.gipity.json          # Project config (which project)
.gipity/              # Local sync state (gitignored)
.claude/settings.json # Hooks for auto-push and auto-pull (per-agent equivalents for Codex/Grok)
CLAUDE.md / AGENTS.md # Gipity commands reference for your agent
```

### Manual sync

If you ever need to sync manually:

```bash
gipity sync --plan   # See what would change, without applying it
gipity sync          # Sync both ways
gipity push <file>   # Push one or more files
```

## Commands

| Command | What it does |
|---------|-------------|
| `gipity build` | Log in, pick a project, pick your coding agent, and launch it - all in one |
| `gipity init` | Link this directory to a project and set up your coding agent |
| `gipity login` / `gipity logout` | Authenticate with email + verification code / sign out |
| `gipity status` | Show project and login status |
| `gipity skill list` / `skill read <name>` | Task docs: read the matching skill before building |
| `gipity project` | List, create, switch, rename, or delete projects |
| `gipity add <template\|kit>` | Add a template (web-simple, web-fullstack, api, 2d-game, 3d-world, ...) or a kit (realtime, stripe, i18n, ...) |
| `gipity deploy [dev\|prod]` | Deploy your project to the web |
| `gipity page inspect\|eval\|screenshot <url>` | Check a page in a real browser: console errors, failed resources, DOM, screenshots |
| `gipity test` | Run project tests in sandboxed containers |
| `gipity db` | Query, list, create, or drop project databases |
| `gipity fn` | List, call, and delete serverless functions |
| `gipity logs fn <name>` / `logs app` | Function logs / recent app activity and errors |
| `gipity secrets` | Manage app secrets (encrypted, never echoed back) |
| `gipity job` | Run long CPU/GPU jobs |
| `gipity workflow` | Create, run, and schedule workflows |
| `gipity approval` | List, create, answer, or cancel pending approvals |
| `gipity memory` | Read/write project memory used by workflow llm steps |
| `gipity ask "<question>"` | Ask a model one question and print the answer |
| `gipity generate` | Generate images, video, speech, sound effects, or music |
| `gipity service` | Call an app service (llm, tts, image, transcribe, ...) |
| `gipity sandbox run` | Execute code in a sandboxed container |
| `gipity records` | Query and manage Records API tables |
| `gipity rbac` / `gipity audit` | Access policies / audit logs |
| `gipity file` | Browse remote files, versions, and rollbacks |
| `gipity sync` / `gipity push` | Sync files between local and Gipity |
| `gipity upload <file>` | Upload a file and print a durable public URL |
| `gipity domain` | Manage custom domains for deployed apps |
| `gipity email` | Send email from gipity@gipity.ai, or test your app's `email()` sends |
| `gipity credits` | Check your plan, balance, and usage |
| `gipity doctor` | Check install + environment health |

Run `gipity --help` for the full list, and `gipity <command> --help` for details.

Every command supports `--json` for scripted/programmatic use.

### deploy

```bash
gipity deploy          # Deploy to dev (dev.gipity.ai)
gipity deploy prod     # Deploy to production (app.gipity.ai)
```

Your project gets a live URL at `https://dev.gipity.ai/{account}/{project}/`.

### ask

One question, one answer: no chat history, no tools. Handy for summarizing a log or getting a second opinion while you work.

```bash
gipity ask "summarize this" --file notes.md
cat errors.log | gipity ask "group these by root cause" --file -
cat prompt.txt | gipity ask                      # piped stdin is the whole prompt
gipity ask "what's in this image" --image shot.png --model haiku
gipity ask "list the causes" --schema '{"type":"array","items":{"type":"string"}}'
```

### db

```bash
gipity db list                # List databases in current project
gipity db list --all          # List all databases across all projects (shows usage/limit)
gipity db query "SELECT * FROM users LIMIT 10"
gipity db query "SELECT * FROM orders" --database my_app_db
gipity db drop old_db         # Drop a database in current project (with confirmation)
gipity db drop old_db --project my-old-app  # Drop from another project (no cd needed)
```

### memory

Project memory is notes by topic, scoped to one project. Workflow llm steps read and write it with the `memory` tool, so it carries context from one run to the next. You can read and edit it from the CLI.

```bash
gipity memory list
gipity memory read design_notes
gipity memory write design_notes "use dark theme"
gipity memory delete design_notes
```

Don't put secrets in memory. Use `gipity secrets set STRIPE_KEY ...` instead: secrets are encrypted at rest and never echoed back.

### sandbox

Run code in a sandboxed Docker container with no network access. JavaScript, Python, and Bash.

```bash
gipity sandbox run "console.log('Hello')" --language js
gipity sandbox run "import pandas; print(pandas.__version__)" --language py
gipity sandbox run --file scripts/report.py
```

### workflow

```bash
gipity workflow                        # List workflows
gipity workflow create workflows/daily_report.yaml
gipity workflow run daily_report       # Run now and print each step's output
gipity workflow enable daily_report    # Turn on its schedule
gipity workflow runs daily_report      # View recent runs
```

### project

```bash
gipity project                         # List projects
gipity project create "My App"         # Create new project
gipity project my-app                  # Switch active project
gipity project rename "My Great App"   # Rename (display name only)
```

## Project Config

### `.gipity.json`

Created by `gipity init`. Links your local directory to a Gipity project.

```json
{
  "projectGuid": "prj-a1b2c3d4",
  "projectSlug": "my-app",
  "accountSlug": "steve",
  "apiBase": "https://a.gipity.ai",
  "ignore": ["node_modules", ".git", "dist", ".env"]
}
```

### `~/.gipity/auth.json`

Your login tokens. Created by `gipity login`. Tokens auto-refresh so you shouldn't need to log in again unless you've been away for a week.

## Questions?

Reach out anytime - steve@gipity.ai

This is early and moving fast. If something's broken or confusing, I want to hear about it.

-- Steve Iverson
