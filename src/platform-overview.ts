/**
 * Shared Gipity platform capability descriptions.
 * Single source of truth used by:
 *   - server/src/services/skills/ (web agent skills)
 *   - tools/gipity-cli/src/setup.ts (CLAUDE.md template for Claude Code)
 */

export const PLATFORM_SERVICES = `## Platform Services

Capabilities beyond local file editing — use \`gipity chat\` (CLI) or the built-in tools (web agent):

- **Image generation**: OpenAI (gpt-image-1, DALL-E 3) and BFL/Flux
- **Speech / TTS**: ElevenLabs and OpenAI voices (streaming and batch)
- **Sound effects / Music**: ElevenLabs audio generation
- **Audio processing**: Transcription, source isolation
- **Web search**: Brave API
- **Twitter/X search**: v2 API, last 7 days
- **Browser automation**: Open URLs, screenshot, click, fill forms, read console
- **Workflow automation**: Cron-scheduled or webhook-triggered multi-step AI pipelines
- **Email**: SendGrid transactional email
- **Google services**: Gmail, Google Calendar integration
- **External services**: Slack, GitHub, Todoist, Notion via service connectors
- **Cross-model queries**: Ask GPT-5, Claude, etc. for second opinions
- **Serverless functions**: JavaScript functions callable via REST`;

export const CLI_COMMANDS = `## CLI Commands

| Command | Purpose |
|---------|---------|
| \`gipity scaffold [title]\` | Create app structure (\`--type web\` default, or \`--type 3d-world\` for 3D games) |
| \`gipity deploy [dev\\|prod]\` | Deploy and get live URL |
| \`gipity sync [up\\|down\\|check]\` | Manual file sync |
| \`gipity db create <name>\` | Create a project database |
| \`gipity db query "SQL"\` | Run SQL on project database |
| \`gipity db list\` | List databases |
| \`gipity memory list\\|read\\|write\` | Persistent key-value memory |
| \`gipity api list\\|define\\|get\` | Manage backend API procedures |
| \`gipity checkpoint list\` | List file snapshots |
| \`gipity checkpoint restore <id>\` | Restore files to a snapshot (undo) |
| \`gipity logs fn <name>\` | View function execution logs (errors, timing) |
| \`gipity browser <url>\` | Inspect a URL: console errors, timing, failed resources |
| \`gipity status\` | Check project and sync status |

All commands support \`--json\` for structured output.`;

export const DEPLOY_VERIFICATION = `## Deploy Verification

Use the browser tool to verify deploys when it matters — first deploy, structural changes (new pages, new frameworks, changed imports), or when something might have broken. Skip verification for trivial changes (copy tweaks, style adjustments, config values).

To verify: \`browser action=open url=<deployed-url>\` — waits for async modules, captures console errors automatically. Check output for \`[Console errors captured after page load]\`. Use \`browser action=screenshot\` to confirm visual correctness.

**Debugging in production:** Add \`console.error()\` calls to app code for diagnostics, redeploy, then use \`browser action=console\` to read the output. Remove debug logging when done.

**Screenshots via \`gipity chat\`**: For 3D games and pages with async rendering (WebGL, canvas, dynamic content), tell the agent to wait a few seconds after opening before capturing so the scene renders. The saved filename may differ from what you requested (collision-free naming). Always check the tool output for the actual saved path.`;
