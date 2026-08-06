# Gipity CLI

The full-stack platform tuned for AI agents.

[Gipity](https://gipity.ai) is the platform: hosting, databases, file storage, deployment, workflows, code execution, and monitoring. Agent-tuned from idea to deploy. Use standalone, or pair with your coding agent - Claude Code, Codex, or Grok - to give it cloud superpowers. Any model, any infra, always your code.

This CLI connects your coding agent - [Claude Code](https://claude.ai/claude-code), Codex, or Grok - to Gipity's cloud platform: databases, deployment, browser testing, image gen, and 50+ other capabilities your local agent doesn't have. It also syncs files so your local agent and the Gipity web agent share the same project.

## Getting Started

**Step 1 - install.** One line installs everything. It sets up Node 18+ (if you don't already have it) and the Gipity CLI, with no sudo required:

```bash
# macOS / Linux / WSL
curl -fsSL https://gipity.ai/install.sh | bash

# Windows (PowerShell)
irm https://gipity.ai/install.ps1 | iex
```

**Step 2 - pick your path.** There are three, and they mix freely:

| You want to... | Run |
|----------------|-----|
| Start building right now, from anywhere | `gipity build` |
| Use your own workflow in your own directory | `gipity init`, then `claude` / `codex` / `grok` / `opencode` |
| Drive this computer from gipity.ai (phone, browser) | `gipity connect` |

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

### `gipity connect` - drive it from the web

Want to start chats from gipity.ai (including your phone) and have them run the coding agent on this computer? Connect it once:

```bash
gipity connect
```

It logs you in, pairs the machine, starts the Gipity relay in the background, and installs the login service so it survives reboots - then stops, without launching anything. From then on, open gipity.ai and start a chat to drive your agent here. Manage it with `gipity relay status` / `pause` / `resume` / `revoke`.

### Prefer npm

If you already have **Node.js 18+** you can install directly:

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

**Auto-pull** - Before each turn, your agent pulls any changes that happened remotely (like if your Gipity agent built something via chat). It sees what changed and can pick up where things left off.

That means your local agent and your Gipity agent share the same files, same project, same context. You get the best of both - hands-on coding locally, autonomous agent work on Gipity.

Sessions are also recorded to your Gipity project so you can watch them live at prompt.gipity.ai. Opt out per project with `gipity init --no-capture`.

### What gets set up

```
.gipity.json          # Project config (which project, which agent)
.gipity/              # Local sync state (gitignored)
.claude/settings.json # Hooks for auto-push and auto-pull (per-agent equivalents for Codex/Grok)
CLAUDE.md / AGENTS.md # Gipity commands reference for your agent
```

### Manual sync

If you ever need to sync manually:

```bash
gipity sync check    # See what's different
gipity sync up       # Push local changes
gipity sync down     # Pull remote changes
```

## Commands

| Command | What it does |
|---------|-------------|
| `gipity build` | Log in, pick a project, pick your coding agent, and launch it - all in one |
| `gipity init` | Link this directory to a project and set up your coding agent |
| `gipity connect` | Connect this computer to gipity.ai so the web CLI can drive it |
| `gipity relay` | Manage the relay (status, pause, resume, revoke) |
| `gipity login` | Authenticate with email + verification code |
| `gipity status` | Show project, agent, and auth info |
| `gipity sync` | Sync files between local and Gipity |
| `gipity push <file>` | Push a single file |
| `gipity deploy [dev\|prod]` | Deploy your project to the web |
| `gipity chat <message>` | Send a message to your Gipity agent |
| `gipity db` | Query, list, create, or drop project databases |
| `gipity memory` | Read/write agent and project memory |
| `gipity sandbox run <code> --lang <js\|py\|bash>` | Execute code in a sandboxed container (language is required) |
| `gipity project` | List, create, switch, or delete projects |
| `gipity agent` | List, create, switch, or configure agents |
| `gipity approval` | List, create, answer, or cancel pending approvals |
| `gipity workflow` | Manage and trigger automated workflows |
| `gipity file` | Browse remote files (ls, cat, tree) |
| `gipity add <template>` | Add a template (web-simple, 2d-game, 3d-world, web-fullstack, api) |
| `gipity test` | Run project tests in sandboxed containers |
| `gipity logs fn <name>` | View function execution logs |
| `gipity page inspect <url>` | Inspect a URL: console errors, performance, failed resources |
| `gipity records` | Query and manage Records API tables |
| `gipity fn` | Manage and call serverless functions |
| `gipity rbac` | Manage RBAC policies |
| `gipity audit` | Query audit logs |
| `gipity credits` | Check your balance and usage |
| `gipity skill` | List and manage agent skills |
| `gipity chat [list\|rename\|archive\|delete]` | Manage chats (or `gipity chat <message>` to send) |
| `gipity gmail [send\|reply\|search\|read]` | Send/read via your own Gmail (different from `gipity email`) |
| `gipity domain` | Manage custom domains for deployed apps |
| `gipity email [send]` | Send emails from the platform (gipity@gipity.ai) |
| `gipity generate` | Generate images, audio, or video via your agent |
| `gipity logout` | Sign out and clear local tokens |

Every command supports `--json` for scripted/programmatic use.

### deploy

```bash
gipity deploy          # Deploy to dev (dev.gipity.ai)
gipity deploy prod     # Deploy to production (app.gipity.ai)
```

Your project gets a live URL at `https://dev.gipity.ai/{account}/{project}/`.

### chat

Talk to your Gipity agent from the terminal. If the agent creates or modifies files (including generated images, audio, video, and sandbox outputs), they sync back automatically.

```bash
gipity chat "Build me a landing page"
gipity chat "Add a contact form" --new    # Start a fresh conversation
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

Agent memory persists across all conversations. Project memory is scoped to one project.

```bash
gipity memory list
gipity memory read preferences
gipity memory write api_keys "stripe: sk_live_..."
gipity memory write design_notes "use dark theme" --project
```

### sandbox

Run code in a sandboxed Docker container with no network access. JavaScript, Python, and Bash.

```bash
gipity sandbox run "console.log('Hello')" --lang js
gipity sandbox run "import pandas; print(pandas.__version__)" --lang py
gipity sandbox run "echo hello" --lang bash
```

### workflow

```bash
gipity workflow                        # List workflows
gipity workflow run daily_report       # Trigger manually
gipity workflow enable daily_report    # Turn on cron schedule
gipity workflow runs daily_report      # View recent runs
```

### agent

```bash
gipity agent                           # List agents
gipity agent create "Research Bot"     # Create a new agent
gipity agent set model claude-opus     # Change the model
gipity agent "Research Bot"            # Switch active agent
```

### project

```bash
gipity project                         # List projects
gipity project create "My App"         # Create new project
gipity project my-app                  # Switch active project
```

## Project Config

### `.gipity.json`

Created by `gipity init`. Links your local directory to a Gipity project.

```json
{
  "projectGuid": "prj-a1b2c3d4",
  "projectSlug": "my-app",
  "accountSlug": "steve",
  "agentGuid": "agt-x1y2z3w4",
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
