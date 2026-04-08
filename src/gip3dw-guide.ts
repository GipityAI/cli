/**
 * Shared 3D World template description.
 * Single source of truth used by:
 *   - server/src/services/skills/ (web agent skills)
 *   - cli/src/setup.ts (CLAUDE.md template for Claude Code)
 */

export const GIP_3DW_GUIDE = `## 3D World

**3D World** is the 3D multiplayer game template on Gipity. All 3D World games share the same visual style, physics engine (Rapier), and multiplayer backend (Colyseus). All files are fully editable.

Scaffold a 3D World project with \`app_scaffold type=3d-world\` (web agent) or \`gipity scaffold --type 3d-world\` (CLI). This creates a playable 3D game with Three.js + Rapier physics + Colyseus multiplayer. Key files: \`config.js\` (metadata), \`settings.js\` (tunable values), \`strings.js\` (display text), \`objects.js\` (entity factories), \`game.js\` (orchestrator), plus engine files (\`core.js\`, \`world.js\`, \`physics.js\`, etc.).

**Genres:** obby/parkour, tycoon, simulator, PvP combat, shooter, tower defense, horror, racing, RPG, social.

**Features:** Opt-in gameplay modules enabled via \`config.features\`. Available: \`rocket-launcher\` (projectile weapon with physics explosions). Example: \`features: { 'rocket-launcher': true }\` in config.js. Features auto-initialize during boot.

Regular game requests ("make a wordle", "build a quiz") should use the standard web scaffold — they don't need the 3D template.`;
