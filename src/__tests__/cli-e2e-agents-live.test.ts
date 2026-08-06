/**
 * Live multi-agent capture + execution e2e - the "deploy, run this, be sure"
 * suite. For EVERY coding agent installed on this machine (Claude Code,
 * Codex, Grok Build) it drives a REAL agent binary through a REAL hook
 * firing into a REAL (deployed) server, then asserts the session actually
 * recorded: conversation row with the right `source`, prompt / assistant /
 * tool_use / tool_result ingest rows, and an attached remote_session_id.
 *
 * Two tests per agent:
 *   1. terminal session   - bare agent run in a linked project; capture
 *                           self-arms via POST /remote-sessions/resolve.
 *   2. dispatch-style run - conversation pre-created via
 *                           POST /conversations/remote (origin=dispatch),
 *                           then `gipity build --agent <key> -p …
 *                           --bypass-approvals` with GIPITY_CONVERSATION_GUID
 *                           - exactly the argv + env the relay daemon uses.
 *                           (The daemon's claim/ack plumbing itself is
 *                           agent-agnostic and covered by relay-daemon.test.)
 *
 * Environment/auth model:
 *   - Agent binaries need the developer's REAL $HOME (their claude/codex/grok
 *     auth). We keep it.
 *   - Gipity state is isolated via GIPITY_DIR=<scratch>: the suite logs in as
 *     an ec- test account and pairs its own throwaway device there, so the
 *     developer's ~/.gipity auth/relay are never touched and every
 *     conversation this suite creates belongs to the test account.
 *   - Hooks are wired DIRECTLY at this workspace's built capture runner
 *     (dist/hooks/capture-runner.js), not through the published plugin /
 *     installed CLI - so the suite tests the code in this checkout even
 *     before the plugin and CLI are published. Per agent:
 *       claude - `--settings <json>` with hook entries
 *       codex  - project .codex/hooks.json + --dangerously-bypass-hook-trust
 *       grok   - a throwaway LOCAL PLUGIN (grok plugin install <dir> --trust);
 *                this doubles as the live proof that Grok fires Claude-format
 *                plugin hooks with its camelCase payload.
 *
 * Skips are LOUD and narrow: only a missing agent binary skips that agent's
 * tests (external dependency, per the platform testing rules). Everything
 * else that fails must fail.
 *
 * Cost: three short agent turns (one echo + one-word reply each) on the
 * developer's own agent subscriptions, plus free platform CRUD.
 *
 * Run:  GIPITY_E2E=1 npm run test:e2e:agents
 * Env:  GIPITY_E2E_API_BASE (default https://a.gipity.ai)
 *       GIPITY_E2E_EMAIL    (default ec-cli-e2e-agents@914-6.com)
 *       GIPITY_E2E_CODE     (default 914914)
 *       GIPITY_E2E_AGENTS   (comma list to restrict, e.g. "codex,grok")
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runCli } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e-agents@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';
const ONLY = process.env['GIPITY_E2E_AGENTS']?.split(',').map(s => s.trim()).filter(Boolean);

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

const __dir = dirname(fileURLToPath(import.meta.url));
/** This checkout's built capture runner - the code under test. */
const RUNNER = resolve(__dir, '..', 'hooks', 'capture-runner.js');
const NODE = process.execPath;

/** Where each agent's session transcript ends up is the agent's business;
 *  hook payloads point the runner at it. We only need binaries present. */
function binaryOnPath(bin: string): boolean {
  const which = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(which, [bin], { stdio: 'ignore' }).status === 0;
}

interface AgentSpec {
  key: 'claude' | 'codex' | 'grok' | 'agy' | 'opencode';
  binary: string;
  source: string;
  /** argv for a bare terminal run of `prompt` inside the project; null when
   *  the agent has no hook-capturing headless mode (see terminalViaBuild). */
  terminalArgs: ((prompt: string, extra: { settingsFile?: string }) => string[]) | null;
  /** Grok fires plugin hooks ONLY in its interactive TUI (verified live
   *  2026-07-13) - a bare `grok -p` records nothing, by Grok's design. Its
   *  headless capture is launcher-driven (`gipity build` pins --session-id
   *  and replays the transcript), so the "terminal" e2e goes through the
   *  launcher. Bare INTERACTIVE grok still records via the plugin, but a TTY
   *  can't be automated here. */
  terminalViaBuild?: boolean;
}

const AGENTS: AgentSpec[] = [
  {
    key: 'claude',
    binary: 'claude',
    source: 'claude_code',
    terminalArgs: (prompt, { settingsFile }) => [
      '-p', prompt, '--permission-mode', 'bypassPermissions', '--settings', settingsFile!,
    ],
  },
  {
    key: 'codex',
    binary: 'codex',
    source: 'codex',
    terminalArgs: (prompt) => [
      'exec', prompt,
      '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
      // Live-verifies the exact trust-bypass the relay daemon relies on.
      '--dangerously-bypass-hook-trust', '--skip-git-repo-check',
    ],
  },
  {
    key: 'grok',
    binary: 'grok',
    source: 'grok',
    terminalArgs: null,
    terminalViaBuild: true,
  },
  {
    key: 'agy',
    binary: 'agy',
    source: 'agy',
    // Unlike Grok, agy fires hooks in headless -p too (verified live) - no
    // launcher indirection needed. --new-project binds a fresh session to
    // cwd (a bare launch silently mis-binds to agy's own config dir instead,
    // confirmed live - see cli/src/agents/agy.ts).
    terminalArgs: (prompt) => ['-p', prompt, '--new-project', '--dangerously-skip-permissions'],
  },
  {
    key: 'opencode',
    binary: 'opencode',
    source: 'opencode',
    // opencode runs no Claude-format hooks at all - capture is driven by the
    // Gipity opencode plugin (session.idle -> transcript + capture runner),
    // which the launcher installs. So the terminal e2e goes through
    // `gipity build --agent opencode -p`, like grok.
    terminalArgs: null,
    terminalViaBuild: true,
  },
];

/** Claude-format hook entries invoking this checkout's runner. Used verbatim
 *  for claude's --settings, the grok test plugin, and (reshaped) codex. */
function hookEntries(source: string): Record<string, unknown> {
  const cmd = (event: string) => `"${NODE}" "${RUNNER}" ${source} ${event}`;
  const group = (event: string) => [{ hooks: [{ type: 'command', command: cmd(event), timeout: 60 }] }];
  const hooks: Record<string, unknown> = {
    SessionStart: group('session-start'),
    PostToolUse: group('post-tool-use'),
    Stop: group('stop'),
  };
  if (source === 'claude-code') hooks['SessionEnd'] = group('session-end');
  return hooks;
}

/** agy needs an exact JSON reply on stdout for every hook (unlike the other
 *  three agents, which tolerate empty output) - this tiny wrapper satisfies
 *  that contract while calling straight into THIS CHECKOUT's runner, mirroring
 *  how hookEntries() above bypasses the installed CLI for claude/codex/grok.
 *  No PreToolUse here (deliberately not wired - see cli/src/setup.ts's
 *  applyAgyHooks() comment: a PreToolUse "allow" would override agy's own
 *  approval prompt for every tool, not just writes). Production ships the
 *  PostToolUse/Stop equivalent as AGY_HOOKS_SCRIPT in cli/src/setup.ts. */
function writeAgyWrapper(dir: string): string {
  const path = join(dir, 'agy-e2e-wrapper.cjs');
  writeFileSync(path, [
    "const { spawnSync } = require('child_process');",
    "let data = '';",
    "process.stdin.setEncoding('utf-8');",
    "process.stdin.on('data', (c) => { data += c; });",
    "process.stdin.on('end', () => {",
    "  const event = process.argv[2];",
    // GIPITY_CAPTURE=off is set (by this suite) around the agy launch to
    // suppress the PRODUCTION 'gipity' hooks.json block - see the comment on
    // agyHooksJson() for why that block also fires (stale installed CLI,
    // divergent parser). This wrapper IS the code under test, so it must run
    // regardless of that env var - clear it before spawning the runner.
    "  const env = { ...process.env }; delete env.GIPITY_CAPTURE;",
    `  spawnSync(${JSON.stringify(NODE)}, [${JSON.stringify(RUNNER)}, 'agy', event], { input: data, env, stdio: ['pipe', 'ignore', 'ignore'] });`,
    "  process.stdout.write('{}');",
    '});',
  ].join('\n'));
  return path;
}

/** agy's own hooks.json shape: a named-block object, tool-scoped events need a
 *  `matcher`. See cli/src/setup.ts's applyAgyHooks() for the production version.
 *
 * Deliberately NOT keyed "gipity" (unlike claude/codex's hookEntries(), which
 * share their respective production key/namespace): the dispatch-style test
 * below runs the REAL `gipity build`, which calls setupProjectTools() ->
 * setupAgyHooks() on every invocation for an already-linked project (confirmed
 * live) - and applyAgyHooks() wholesale-replaces the "gipity" key (by design -
 * see its own comment). Codex/grok survive that same re-invocation because
 * their production merge is per-command additive into a SHARED key/array, so
 * the test's differently-commanded entries are never removed, just added
 * alongside. agy's merge is wholesale-replace-by-key, so a same-keyed test
 * entry would be destroyed outright and replaced with production's, which
 * points at the installed CLI's bundled runner - stale relative to this
 * checkout until republished. Using a distinct key sidesteps the clobber the
 * same way codex/grok's distinct command achieves it: confirmed live that agy
 * fires Stop hooks from multiple independent top-level named blocks in the
 * same hooks.json, so both this checkout's wiring and production's fire side
 * by side without either clobbering the other's file entry.
 *
 * They do NOT, however, fire *harmlessly* side by side the way claude/codex's
 * dupes do (published parser == checkout parser there, so a race is a no-op
 * dedup either way). Here the two runners share one capture-state watermark
 * file (keyed by convGuid, under homedir()), so whichever flushes Stop first
 * wins the watermark - and the stale installed runner's pre-fix agy parser
 * (wrong Stop shape, no tool_use/tool_result extraction) produces zero tool
 * rows for a run_command session. If it wins the race, the good runner's own
 * flush sees an already-advanced watermark and the test starves waiting for a
 * tool row that will never arrive (confirmed live - intermittent failures
 * only ever showed up once a prior `gipity build` call had written the
 * production key into this same file). Fix: every agy spawn below sets
 * GIPITY_CAPTURE=off (which capture.cjs and this checkout's own runner both
 * honor as "stand down"), suppressing the stale production block outright;
 * writeAgyWrapper()'s generated script explicitly clears that var before
 * invoking the checkout runner it wraps, so the one runner under test always
 * captures regardless. Not a production concern - a real installed CLI only
 * ever has the one "gipity" key, never a second competing block. */
function agyHooksJson(wrapperPath: string): Record<string, unknown> {
  const cmd = (event: string) => `"${NODE}" "${wrapperPath}" ${event}`;
  return {
    'gipity-e2e-agy': {
      PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: cmd('post-tool-use'), timeout: 60 }] }],
      // Flat, not {hooks:[...]}-wrapped - see applyAgyHooks()'s comment in
      // cli/src/setup.ts for why (a wrapped Stop silently kills the whole block).
      Stop: [{ type: 'command', command: cmd('stop'), timeout: 60 }],
    },
  };
}

describe('cli-e2e-agents-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const gipityDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-agents-dir-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-agents-proj-'));
  const projectSlug = `e2e-agents-${Date.now().toString(36)}`;
  const grokPluginDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-grok-plugin-'));
  const claudeSettingsFile = join(projectDir, '.e2e-claude-settings.json');

  // gipity CLI runs: REAL HOME (so PATH-resolved tools behave) but isolated
  // GIPITY_DIR, so auth/device state never touch the developer's account.
  const gipityEnv = { HOME: process.env['HOME'] ?? '', GIPITY_DIR: gipityDir };
  const cli = (args: string[], opts: { cwd?: string; timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env: gipityEnv,
      cwd: opts.cwd ?? projectDir,
      timeout: opts.timeout ?? 120_000,
      enableUpdater: false,
    });

  /** Spawn a real agent binary with the developer's full env + our Gipity
   *  isolation. Hook processes inherit this env, which is how the runner
   *  finds the test account's device token. */
  const runAgent = (bin: string, args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(bin, args, {
      cwd: projectDir,
      env: { ...process.env, GIPITY_DIR: gipityDir, GIPITY_API_BASE: API_BASE, NO_COLOR: '1', ...extraEnv },
      encoding: 'utf-8',
      timeout: 300_000,
    });

  let deviceGuid = '';
  let projectGuid = '';

  const authToken = (): string =>
    JSON.parse(readFileSync(join(gipityDir, 'auth.json'), 'utf-8')).accessToken;

  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${authToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };

  /** Poll `fn` until it returns non-null or the deadline passes. Transient
   *  fetch failures (a keep-alive socket dropped by a dev server under tsx
   *  watch, a blip mid-deploy) count as "not yet", not as test failures -
   *  the deadline still bounds them. */
  const poll = async <T>(label: string, deadlineMs: number, fn: () => Promise<T | null>): Promise<T> => {
    const until = Date.now() + deadlineMs;
    let lastErr = '';
    for (;;) {
      try {
        const v = await fn();
        if (v !== null) return v;
      } catch (err: any) {
        lastErr = err?.message || String(err);
      }
      if (Date.now() > until) throw new Error(`timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr})` : ''}`);
      await new Promise(r => setTimeout(r, 2_000));
    }
  };

  interface MessageRow { role: string; content: string; tool_calls?: any; tool_name?: string | null }

  const messagesOf = async (convGuid: string): Promise<MessageRow[]> =>
    (await api('GET', `/conversations/${convGuid}/messages?limit=200`)).data as MessageRow[];

  /** The suite's standard assertions: the full shape of a captured session. */
  const assertCaptured = (msgs: MessageRow[], nonce: string, agent: string) => {
    const texts = msgs.map(m => `${m.role}:${m.content ?? ''}`);
    assert.ok(
      msgs.some(m => m.role === 'user' && m.content?.includes(nonce)),
      `${agent}: no prompt row carrying the nonce. rows: ${texts.join(' | ').slice(0, 800)}`,
    );
    assert.ok(msgs.some(m => m.role === 'assistant'), `${agent}: no assistant row`);
    assert.ok(msgs.some(m => m.role === 'tool'), `${agent}: no tool rows (tool_use/tool_result)`);
    assert.ok(
      msgs.some(m => m.role === 'tool' && JSON.stringify(m).includes(nonce)),
      `${agent}: no tool row carrying the echoed nonce (tool_result missing?)`,
    );
  };

  /** Newest conversation of `source` (the test account only owns this
   *  suite's data, so newest-of-source is unambiguous). */
  const newestConv = async (source: string, notIn: Set<string>): Promise<any | null> => {
    const list = (await api('GET', `/conversations?source=${source}&limit=20`)).data as any[];
    const fresh = list.filter(c => !notIn.has(c.short_guid));
    return fresh.length ? fresh[0] : null;
  };

  before(async () => {
    const login = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(login.status, 0, `login failed: ${login.stderr || login.stdout}`);

    // Throwaway device: capture needs a paired device for /remote-sessions auth.
    const pair = cli(['relay', 'setup', '--name', 'e2e-agents', '--no-start', '--no-autostart', '--json']);
    assert.equal(pair.status, 0, `relay setup failed: ${pair.stderr || pair.stdout}`);
    deviceGuid = JSON.parse(pair.stdout).device.guid;

    const init = cli(['init', projectSlug]);
    assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);
    projectGuid = JSON.parse(readFileSync(join(projectDir, '.gipity.json'), 'utf-8')).projectGuid;

    // claude hook settings (this checkout's runner).
    writeFileSync(claudeSettingsFile, JSON.stringify({ hooks: hookEntries('claude-code') }, null, 2));

    // codex project hooks (this checkout's runner; overwrites init's version).
    mkdirSync(join(projectDir, '.codex'), { recursive: true });
    writeFileSync(join(projectDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: hookEntries('codex') }, null, 2));

    // agy project hooks (this checkout's runner via a small wrapper - agy
    // requires an exact JSON reply per hook, unlike the other three agents).
    if (binaryOnPath('agy')) {
      const agyWrapper = writeAgyWrapper(projectDir);
      mkdirSync(join(projectDir, '.agents'), { recursive: true });
      writeFileSync(join(projectDir, '.agents', 'hooks.json'), JSON.stringify(agyHooksJson(agyWrapper), null, 2));
    }

    // grok throwaway plugin (Claude-format hooks, absolute commands).
    if (binaryOnPath('grok')) {
      mkdirSync(join(grokPluginDir, '.claude-plugin'), { recursive: true });
      mkdirSync(join(grokPluginDir, 'hooks'), { recursive: true });
      writeFileSync(join(grokPluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: 'gipity-e2e-agents', version: '0.0.1', description: 'throwaway e2e capture hooks',
      }, null, 2));
      writeFileSync(join(grokPluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: hookEntries('grok') }, null, 2));
      const inst = spawnSync('grok', ['plugin', 'install', grokPluginDir, '--trust'], {
        encoding: 'utf-8', timeout: 60_000, env: { ...process.env },
      });
      assert.equal(inst.status, 0, `grok plugin install failed: ${inst.stderr || inst.stdout}`);
    }
  });

  after(async () => {
    // Best-effort cleanup; never mask a test failure.
    try { if (binaryOnPath('grok')) spawnSync('grok', ['plugin', 'uninstall', 'gipity-e2e-agents'], { timeout: 30_000 }); } catch { /* ignore */ }
    try { cli(['-y', 'relay', 'revoke']); } catch { /* ignore */ }
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    for (const d of [gipityDir, projectDir, grokPluginDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const seenConvs = new Set<string>();

  for (const agent of AGENTS) {
    const enabled = !ONLY || ONLY.includes(agent.key);

    it(`${agent.key}: terminal session records to Gipity (capture self-arm)`, {
      skip: (!enabled && 'excluded by GIPITY_E2E_AGENTS')
        || (!binaryOnPath(agent.binary) && `${agent.binary} not installed on this machine`),
    }, async () => {
      const nonce = `e2e-${agent.key}-${Date.now().toString(36)}`;
      const prompt = `Run the shell command \`echo ${nonce}\` using your shell/terminal tool, then reply with exactly: done`;

      const r = agent.terminalViaBuild
        // No hook-capturing headless mode (grok): the supported terminal-style
        // headless path IS the launcher, which pins the session id and
        // replays the transcript after the run.
        ? spawnSync(NODE, [resolve(__dir, '..', 'index.js'), '--api-base', API_BASE,
            'build', '--agent', agent.key, '-p', prompt, '--bypass-approvals'], {
            cwd: projectDir,
            env: { ...process.env, GIPITY_DIR: gipityDir, GIPITY_API_BASE: API_BASE, NO_COLOR: '1', DISABLE_AUTOUPDATER: '1' },
            encoding: 'utf-8', timeout: 300_000,
          })
        // agy: suppress the stale production hooks.json block (see
        // agyHooksJson()'s comment) so only this checkout's wrapper captures.
        : runAgent(agent.binary, agent.terminalArgs!(prompt, { settingsFile: claudeSettingsFile }),
            agent.key === 'agy' ? { GIPITY_CAPTURE: 'off' } : {});
      assert.equal(r.status, 0, `${agent.binary} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-800)}`);

      // Hooks fire during/after the run; Stop flushes on clean exit. Give the
      // ingest a moment and find the conversation the runner self-armed.
      const conv = await poll(`${agent.key} conversation`, 90_000, () => newestConv(agent.source, seenConvs));
      seenConvs.add(conv.short_guid);
      assert.equal(conv.source, agent.source);

      const msgs = await poll(`${agent.key} ingest rows`, 90_000, async () => {
        const m = await messagesOf(conv.short_guid);
        return m.some(x => x.role === 'assistant') && m.some(x => x.role === 'tool') ? m : null;
      });
      assertCaptured(msgs, nonce, agent.key);

      // The session id must be attached (it's what makes resume work).
      const detail = (await api('GET', `/conversations/${conv.short_guid}`)).data;
      assert.ok(detail.remote_session_id, `${agent.key}: remote_session_id not attached`);
    });

    it(`${agent.key}: dispatch-style headless run records into a pre-created remote conversation`, {
      skip: (!enabled && 'excluded by GIPITY_E2E_AGENTS')
        || (!binaryOnPath(agent.binary) && `${agent.binary} not installed on this machine`),
    }, async () => {
      const created = await api('POST', '/conversations/remote', {
        project_guid: projectGuid, device_guid: deviceGuid, source: agent.source, origin: 'dispatch',
      });
      const convGuid = created.data.conversation_guid as string;
      seenConvs.add(convGuid);

      const nonce = `e2e-dispatch-${agent.key}-${Date.now().toString(36)}`;
      const prompt = `Run the shell command \`echo ${nonce}\` using your shell/terminal tool, then reply with exactly: done`;

      // Exactly what the relay daemon spawns for this agent, with the same
      // conversation binding env. (Claude additionally passes our settings
      // hooks through build's passthrough; if the published plugin is also
      // installed on this machine both fire, and source_uuid dedup collapses
      // the duplicates server-side - worth exercising, not avoiding.)
      const args = ['--api-base', API_BASE, 'build', '--agent', agent.key, '-p', prompt, '--bypass-approvals'];
      if (agent.key === 'claude') args.push('--settings', claudeSettingsFile);
      const r = spawnSync(NODE, [resolve(__dir, '..', 'index.js'), ...args], {
        cwd: projectDir,
        env: {
          ...process.env, GIPITY_DIR: gipityDir, GIPITY_API_BASE: API_BASE,
          GIPITY_CONVERSATION_GUID: convGuid, NO_COLOR: '1', DISABLE_AUTOUPDATER: '1',
          // agy: suppress the stale production hooks.json block - see
          // agyHooksJson()'s comment. build.ts's generic adapter path spreads
          // its own process.env into the agy child verbatim, so this reaches
          // the hook subprocesses agy spawns; writeAgyWrapper() clears it
          // again before invoking the checkout runner it wraps.
          ...(agent.key === 'agy' ? { GIPITY_CAPTURE: 'off' } : {}),
        },
        encoding: 'utf-8',
        timeout: 300_000,
      });
      assert.equal(r.status, 0, `gipity build --agent ${agent.key} exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-800)}`);

      const msgs = await poll(`${agent.key} dispatch ingest`, 90_000, async () => {
        const m = await messagesOf(convGuid);
        return m.some(x => x.role === 'assistant') && m.some(x => x.role === 'tool') ? m : null;
      });
      assertCaptured(msgs, nonce, agent.key);

      const detail = (await api('GET', `/conversations/${convGuid}`)).data;
      assert.equal(detail.source, agent.source);
      assert.ok(detail.remote_session_id, `${agent.key}: dispatch conv has no attached session id`);
    });
  }
});
