#!/usr/bin/env node
// Shortcut: gipcc → gipity start-cc
process.argv = [process.argv[0], process.argv[1], 'start-cc', ...process.argv.slice(2)];
await import('./index.js');
