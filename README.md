# Gipity CLI

Most AI tools give you a chatbot. We gave ours a computer.

[Gipity](https://gipity.ai) is an AI agent with 90+ tools and a full cloud platform — app hosting, databases, file storage, deployment, workflows, code execution, and more. Use it standalone or plug it into Claude Code to give your local agent cloud superpowers.

This CLI connects [Claude Code](https://claude.ai/claude-code) to Gipity's cloud platform — databases, deployment, browser testing, image gen, and 50+ other capabilities your local agent doesn't have. It also syncs files so Claude Code and the Gipity web agent share the same project.

## Getting Started

You need **Node.js 18+** (which includes npm) and **Claude Code**.

```bash
# 1. Install Node.js (if you don't have it)

# macOS
brew install node

# Windows — download the installer from https://nodejs.org

# Linux (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

# 2. Install Gipity CLI and Claude Code
npm install -g gipity @anthropic-ai/claude-code

# 3. Go
gipity claude
```

That's it. `claude` walks you through login, project setup, and launches Claude Code.

## Updates

The CLI auto-updates in the background. After your one-time `npm install -g gipity`, every run silently checks npm for a new version and installs it into `~/.gipity/local/` — no sudo, no re-running install commands. The new version takes effect on your next invocation.

```bash
gipity doctor   # show install version, last update check, opt-out status
gipity update   # force an immediate update now
```

To opt out: `export DISABLE_AUTOUPDATER=1` (matches Claude Code), or set `{ "autoUpdates": false }` in `~/.gipity/settings.json`. CI environments are auto-detected and skipped.

## Quick Start

One command. It walks you through login, project setup, and drops you into Claude Code.

```bash
gipity claude --dangerously-skip-permissions
```

That's it. You'll see:

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
  Project name [project01]: cool-app
  Creating "cool-app"...
  Created.

  Launching Claude Code...
```

If you're already logged in, it skips straight to project setup. If you already have a project in the current directory, it skips straight to launching Claude Code.

Projects live in `~/GipityProjects/{project-slug}/` — created automatically on first use. Any extra flags (like `--dangerously-skip-permissions`, `--model opus`, etc.) get passed through to Claude.

### The manual way

If you prefer to do things step by step:

```bash
gipity login --email you@example.com
gipity login --code 123456
cd my-project
gipity init
claude
```

## Claude Code Integration

This is the good part. When you run `gipity init` in a project, it sets up two hooks in `.claude/settings.json`:

**Auto-push** — Every time Claude Code writes or edits a file, it gets pushed to Gipity in the background. No extra steps.

**Auto-pull** — Before each turn, Claude Code pulls any changes that happened remotely (like if your Gipity agent built something via chat). Claude sees what changed and can pick up where things left off.

That means Claude Code and your Gipity agent share the same files, same project, same context. You get the best of both — Claude Code for hands-on coding, Gipity for autonomous agent work.

### What gets set up

```
.gipity.json          # Project config (which project, which agent)
.gipity/              # Local sync state (gitignored)
.claude/settings.json # Hooks for auto-push and auto-pull
CLAUDE.md             # Gipity commands reference for Claude Code
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
| `gipity claude` | Log in, pick a project, and launch Claude Code — all in one |
| `gipity login` | Authenticate with email + verification code |
| `gipity init` | Set up a Gipity project and configure Claude Code |
| `gipity status` | Show project, agent, and auth info |
| `gipity sync` | Sync files between local and Gipity |
| `gipity push <file>` | Push a single file |
| `gipity deploy [dev\|prod]` | Deploy your project to the web |
| `gipity chat <message>` | Send a message to your Gipity agent |
| `gipity db` | Query, list, create, or drop project databases |
| `gipity memory` | Read/write agent and project memory |
| `gipity sandbox run <code>` | Execute code in a sandboxed container |
| `gipity project` | List, create, switch, or delete projects |
| `gipity agent` | List, create, switch, or configure agents |
| `gipity workflow` | Manage and trigger automated workflows |
| `gipity file` | Browse remote files (ls, cat, tree) |
| `gipity scaffold [title]` | Create app structure (`--type web`, `--type 2d-game`, or `--type 3d-world`) |
| `gipity test` | Run project tests in sandboxed containers |
| `gipity logs fn <name>` | View function execution logs |
| `gipity page-inspect <url>` | Inspect a URL: console errors, performance, failed resources |
| `gipity records` | Query and manage Records API tables |
| `gipity fn` | Manage and call serverless functions |
| `gipity rbac` | Manage RBAC policies |
| `gipity audit` | Query audit logs |
| `gipity credits` | Check your balance and usage |
| `gipity skills` | List and manage agent skills |
| `gipity domain` | Manage custom domains for deployed apps |
| `gipity email` | Send emails via your agent |
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
gipity sandbox run "console.log('Hello')"
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

Reach out anytime — steve@gipity.ai

This is early and moving fast. If something's broken or confusing, I want to hear about it.

-- Steve Iverson
