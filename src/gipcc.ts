#!/usr/bin/env node
// Shortcut: gipcc → gipity claude
process.argv = [process.argv[0], process.argv[1], 'claude', ...process.argv.slice(2)];
await import('./index.js');
