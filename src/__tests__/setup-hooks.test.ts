/**
 * setupClaudeHooks / ensureGipityPlugin - the Claude Code integration written
 * by the CLI.
 *
 * Hooks ship in the Gipity plugin now (GipityAI/claude-plugin). The CLI's job
 * inverted: instead of writing hook blocks into settings files, it (1) enables
 * the plugin declaratively at user scope, (2) strips the legacy hook blocks
 * older CLI versions wrote into project and user settings - preserving the
 * user's own hooks - and (3) refuses to treat $HOME as a project (the bug
 * that used to leak "project" hooks into the user-global settings).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  setupClaudeHooks,
  ensureGipityPlugin,
  stripGipityHooks,
  isGipityManagedHookCommand,
  GIPITY_PLUGIN_ID,
  GIPITY_MARKETPLACE_NAME,
  GIPITY_MARKETPLACE_REPO,
} from '../setup.js';

/** Run `fn` with cwd inside a temp project dir and $HOME pointed at a sibling
 *  temp dir, so user-scope writes are observable and never touch the real
 *  home. os.homedir() honors $HOME on POSIX. */
function withTempDirs(fn: (project: string, home: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'gipity-hooks-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    process.chdir(project);
    fn(project, home);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
}

function readSettings(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
}

/** A realistic legacy settings.json as written by older CLI versions, plus
 *  user-authored entries that must survive migration. */
function legacySettings(): Record<string, any> {
  return {
    hooks: {
      PreToolUse: [
        { // scaffold nudge (retired)
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: `node -e "const fs=require('fs');if(!fs.existsSync('.gipity.json'))process.exit(0);const m=['gipity.yaml','src','functions','package.json'].some(p=>fs.existsSync(p));if(m)process.exit(0);process.stderr.write('warn');process.exit(0)"` }],
        },
      ],
      PostToolUse: [
        { // file-sync push one-liner
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: `node -e "let d='';process.stdin.on('end',()=>{require('child_process').spawn('gipity',['push',p,'--quiet'],{})})"` }],
        },
        { // throttled capture flush (fire-time launcher form)
          matcher: '',
          hooks: [{ type: 'command', command: `node -e "..." "/old/install/dist/hooks/capture-runner.js" claude-code post-tool-use` }],
        },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: `node -e "require('child_process').exec('gipity sync --json',()=>{})"` }] },
      ],
      Stop: [
        { // bare absolute-path capture hook (oldest form)
          hooks: [{ type: 'command', command: `node "/home/old/.gipity/local/node_modules/gipity/dist/hooks/capture-runner.js" claude-code stop` }],
        },
        { // user's own Stop hook - must survive
          hooks: [{ type: 'command', command: 'say done' }],
        },
      ],
    },
    permissions: { allow: ['Bash(my-custom-tool *)'] },
  };
}

test('setupClaudeHooks strips legacy Gipity hooks but preserves user hooks and permissions', () => {
  withTempDirs((project) => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify(legacySettings()));

    setupClaudeHooks();
    const settings = readSettings(project);

    // Every Gipity-managed entry is gone, emptied events removed entirely.
    assert.equal(settings.hooks.PreToolUse, undefined, 'scaffold nudge removed');
    assert.equal(settings.hooks.PostToolUse, undefined, 'push + capture-flush removed');
    assert.equal(settings.hooks.UserPromptSubmit, undefined, 'sync pull removed');

    // The user's own Stop hook survived alone.
    const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.deepEqual(stopCmds, ['say done']);

    // User permission preserved, gipity allows merged in.
    assert.ok(settings.permissions.allow.includes('Bash(my-custom-tool *)'));
    assert.ok(settings.permissions.allow.includes('Bash(gipity push *)'));
  });
});

test('setupClaudeHooks no longer writes any hooks into project settings', () => {
  withTempDirs((project) => {
    setupClaudeHooks();
    const settings = readSettings(project);
    assert.equal(settings.hooks, undefined, 'no hooks key written');
    assert.ok(settings.permissions.allow.length > 0, 'permissions still merged');
  });
});

test('setupClaudeHooks enables the plugin at user scope and strips legacy global residue', () => {
  withTempDirs((_project, home) => {
    // Seed the user-global settings with legacy residue (the $HOME-leak bug).
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(legacySettings()));

    setupClaudeHooks();
    const userSettings = readSettings(home);

    assert.equal(userSettings.enabledPlugins[GIPITY_PLUGIN_ID], true, 'plugin enabled');
    assert.deepEqual(
      userSettings.extraKnownMarketplaces[GIPITY_MARKETPLACE_NAME].source,
      { source: 'github', repo: GIPITY_MARKETPLACE_REPO },
      'marketplace registered',
    );
    assert.equal(userSettings.hooks.PostToolUse, undefined, 'legacy global capture/push hooks stripped');
    const stopCmds = (userSettings.hooks?.Stop ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.deepEqual(stopCmds, ['say done'], 'user global hook survived');
  });
});

test('an explicit user disable of the plugin is respected (and force overrides it)', () => {
  withTempDirs((_project, home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { [GIPITY_PLUGIN_ID]: false } }),
    );

    setupClaudeHooks();
    assert.equal(readSettings(home).enabledPlugins[GIPITY_PLUGIN_ID], false, 'disable respected');

    ensureGipityPlugin(true); // gipity status --repair-hooks
    assert.equal(readSettings(home).enabledPlugins[GIPITY_PLUGIN_ID], true, 'force re-enables');
  });
});

test('$HOME is never treated as a project', () => {
  withTempDirs((_project, home) => {
    const prev = process.cwd();
    process.chdir(home);
    try {
      setupClaudeHooks();
    } finally {
      process.chdir(prev);
    }
    const userSettings = readSettings(home);
    assert.equal(userSettings.enabledPlugins[GIPITY_PLUGIN_ID], true, 'plugin still enabled');
    assert.equal(userSettings.hooks, undefined, 'no hooks written at $HOME');
    assert.equal(userSettings.permissions, undefined, 'no project permissions written at $HOME');
  });
});

test('isGipityManagedHookCommand matches all legacy shapes and nothing else', () => {
  const legacy = [
    'node "/x/dist/hooks/capture-runner.js" claude-code stop',
    `node -e "launcher" "/x/dist/hooks/capture-runner.js" claude-code stop`,
    `node -e "...spawn('gipity',['push',p,'--quiet'],...)"`,
    `node -e "...exec('gipity sync --json',...)"`,
    `node -e "...exec('gipity sync down --json',...)"`,
    `node -e "...['gipity.yaml','src','functions','package.json'].some..."`,
  ];
  for (const cmd of legacy) assert.ok(isGipityManagedHookCommand(cmd), cmd);

  const userOwned = [
    'say done',
    'npx prettier --write .',
    'gipity deploy dev', // a user hook that calls gipity is NOT ours
    'node my-hook.js',
  ];
  for (const cmd of userOwned) assert.ok(!isGipityManagedHookCommand(cmd), cmd);
});

test('stripGipityHooks reports change status and drops an emptied hooks key', () => {
  const settings: Record<string, any> = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/x/capture-runner.js" claude-code stop' }] }] },
  };
  assert.equal(stripGipityHooks(settings), true);
  assert.equal(settings.hooks, undefined, 'empty hooks object removed entirely');
  assert.equal(stripGipityHooks(settings), false, 'second pass is a no-op');
  assert.equal(stripGipityHooks({}), false, 'no hooks key is a no-op');
});

test('plugin enablement is idempotent - no rewrite when already configured', () => {
  withTempDirs((_project, home) => {
    setupClaudeHooks();
    const path = join(home, '.claude', 'settings.json');
    const first = readFileSync(path, 'utf-8');
    setupClaudeHooks();
    assert.equal(readFileSync(path, 'utf-8'), first, 'identical content after second run');
    assert.ok(existsSync(path));
  });
});
