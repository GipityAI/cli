#!/usr/bin/env node
// Shortcut: gipccd → gipity start-cc --dangerously-skip-permissions
process.argv = [process.argv[0], process.argv[1], 'start-cc', '--dangerously-skip-permissions', ...process.argv.slice(2)];
await import('./index.js');
