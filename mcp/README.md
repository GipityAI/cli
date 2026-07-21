# gipity-mcp

MCP server for [Gipity](https://gipity.ai), the full-stack platform tuned for AI agents. Gives any MCP client (Claude Code, Claude Desktop, Cursor, Codex, Copilot, Windsurf) typed tools for deploying web apps and APIs, running SQL, calling serverless functions, and executing sandboxed code.

## Setup

1. Get a Gipity account and a long-lived agent token:

```bash
npm install -g gipity
gipity login
gipity token create --name "mcp"
```

2. Add the server to your client. Claude Code:

```bash
claude mcp add gipity -e GIPITY_TOKEN=gip_at_... -- npx -y gipity-mcp
```

Cursor / Claude Desktop / other JSON-config clients:

```json
{
  "mcpServers": {
    "gipity": {
      "command": "npx",
      "args": ["-y", "gipity-mcp"],
      "env": { "GIPITY_TOKEN": "gip_at_..." }
    }
  }
}
```

`GIPITY_TOKEN` is optional on a machine where `gipity login` has run; the server then uses the session in `~/.gipity/auth.json` (short-lived, so the token is recommended for anything unattended).

## Tools

| Tool | Actions |
|---|---|
| `project` | list, get, create, rename, delete |
| `deploy` | deploy to dev.gipity.ai or app.gipity.ai |
| `database` | list, query (raw SQL), create, drop |
| `function` | list, call, logs, delete |
| `memory` | list, write, delete (project-scoped notes) |
| `workflow` | list, get, run, runs, enable, disable |
| `file` | list, tree, read, push, url, delete |
| `sandbox` | run JS / Python / Bash in the cloud sandbox |

## Scope

This is the lighter alternative to the [`gipity` CLI](https://www.npmjs.com/package/gipity), which remains the primary agent surface (30+ commands, file sync, interactive login, chat, log tailing). Interactive and admin flows are deliberately not exposed here; use the CLI for those.

Docs: https://docs.gipity.ai (LLM-ready: [llms.txt](https://docs.gipity.ai/llms.txt), [llms-full.txt](https://docs.gipity.ai/llms-full.txt))
