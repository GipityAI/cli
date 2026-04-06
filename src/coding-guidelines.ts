/**
 * Shared coding guidelines for Gipity-hosted projects.
 * Single source of truth used by:
 *   - server/src/services/skills/web-app-basics.ts (web CLI agent)
 *   - tools/gipity-cli/src/setup.ts (CLAUDE.md template for Claude Code)
 *
 * The CLI build copies this file before compiling (see justfile cli-build).
 */

export const CODING_GUIDELINES = `## File Structure
- **Use src/ convention**: All app files live under \`src/\` — \`src/index.html\`, \`src/css/styles.css\`, \`src/js/main.js\`, \`src/images/\`
- **Separate files**: Split into \`index.html\`, \`styles.css\`, and \`app.js\` (or \`main.js\`). Never inline large blocks of CSS or JS in HTML.
- If the app grows, organize into folders: \`src/css/\`, \`src/js/\`, \`src/assets/\`, \`src/sounds/\`, \`src/images/\`, etc.
- **Use subfolders — don't flatten**: Reference assets from their folders (e.g. \`sounds/click.ogg\`, \`images/logo.png\`). Never copy files to the root just for convenience — deployed apps serve the full directory tree.
- Keep \`index.html\` clean — it should be structure/markup, not behavior or styling

## HTML
- Use semantic elements: \`<header>\`, \`<nav>\`, \`<main>\`, \`<section>\`, \`<footer>\`, \`<article>\`
- Always include \`<meta name="viewport" content="width=device-width, initial-scale=1.0">\`
- Add a proper \`<title>\` and favicon link
- Unless the user specifies a different CSS framework, include Water.css for automatic styling: \`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css">\`
- Water.css styles semantic HTML automatically (buttons, tables, forms, nav, cards) — no classes needed. It supports dark/light themes automatically. Add custom CSS on top for app-specific tweaks.

## CSS
- When using Water.css, it handles base styling, resets, and typography — don't duplicate what it provides
- Water.css exposes CSS variables for theming — override them in \`:root\` for custom colors/fonts
- Use CSS custom properties (variables) for app-specific colors, spacing, and fonts
- Add smooth transitions on interactive elements (buttons, links, hover states)

## JavaScript
- Use \`const\`/\`let\`, arrow functions, template literals, and modern ES6+ syntax
- Wait for DOM: wrap in \`DOMContentLoaded\` or place script at end of body
- Keep functions small and focused
- Use \`addEventListener\` — never inline \`onclick\` attributes in HTML

## Code Quality
- **Keep files under ~400 lines** unless the content genuinely requires it (e.g. a long data table, template string, or config object). When logic grows beyond that, split into focused modules (e.g. \`utils.js\`, \`api.js\`, \`ui.js\`).
- **Don't duplicate code.** If the same logic appears twice, extract it into a shared function. Before writing a new helper, check if one already exists or could be extended.
- **One responsibility per file.** A file that handles both UI rendering and API calls should be split.
- **Name things clearly.** Functions, variables, and files should describe what they do — no \`temp\`, \`data2\`, \`stuff.js\`.
- **Prefer simple, readable code** over clever code that hides bugs. Flat over nested — use early returns, avoid deep nesting.
- **Centralize configuration.** App settings, API URLs, feature flags, and magic numbers should live in a dedicated config file (e.g. \`config.js\` or \`constants.js\`), not scattered across the codebase.
- **Write utility functions** for repeated operations (formatting, validation, API calls). Keep them in a \`utils.js\` or \`helpers.js\` file. Small, pure functions are easy to test and reuse.

## Testing
- **Write tests for new functions** — especially utility/helper functions. Cover the happy path and edge cases (empty input, null, boundary values).
- **Don't mock unless absolutely required.** Tests should exercise real code paths. Only mock external paid services (APIs that cost money per call).
- **E2E tests should hit real infrastructure** (real API, real DB) — just clean up test data when done.
- **Test file naming**: \`*.test.js\` for unit tests, \`*.e2e.test.js\` for end-to-end tests.

## Deployment
- **src/ detection**: If a \`src/\` directory exists, only \`src/\` is deployed. Otherwise the full project root is deployed.`;
