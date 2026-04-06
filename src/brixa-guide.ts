/**
 * Shared Brixa game framework description.
 * Single source of truth used by:
 *   - server/src/services/skills/ (web agent skills)
 *   - tools/gipity-cli/src/setup.ts (CLAUDE.md template for Claude Code)
 */

export const BRIXA_GUIDE = `## Brixa

**Brixa** is the 3D multiplayer voxel game framework on Gipity. All Brixa games share the same visual style, physics engine (Rapier), and multiplayer backend (Colyseus). The framework is locked — creators only write game logic.

Scaffold a Brixa game with \`app_scaffold type=brixa\` (web agent) or \`gipity scaffold --type brixa\` (CLI). This creates a playable 3D game with Three.js + Rapier physics + Colyseus multiplayer. The \`src/framework/\` directory is READ-ONLY (locked engine). Editable files: \`config.js\` (metadata), \`settings.js\` (tunable values), \`strings.js\` (display text), \`objects.js\` (entity factories), \`game.js\` (orchestrator).

**Genres:** obby/parkour, tycoon, simulator, PvP combat, shooter, tower defense, horror, racing, RPG, social.

Regular game requests ("make a wordle", "build a quiz") should use the standard web scaffold — they don't need the 3D framework.`;
