/**
 * RemoteAgentAdapter - the one abstraction between Gipity and a local coding
 * agent, covering execution (argv shapes, flags, stream schema), environment
 * detection, session capture, and machine/project setup. The adapter is
 * everything a `source` string alone can't express:
 *
 *   - how to launch the agent binary (interactive and headless)
 *   - how to resume a session, pick a model, bypass approvals
 *   - how to spot the session id in the agent's output stream
 *   - how to tell this agent's env footprint apart from the others
 *   - how to parse this agent's transcript into ingest entries
 *   - how to install/uninstall this agent's Gipity integration
 *
 * Consumers: the `gipity build` launcher (interactive + `-p`), the relay
 * daemon (web-CLI dispatch), `client-context.ts` (harness detection),
 * `hooks/capture-runner.ts` (session capture), and `setup.ts`/`init.ts`/
 * `uninstall.ts` (machine + project integration). Adding an agent = one file
 * here + one capture parser under `capture/sources/`; no scattered
 * `if (source === …)`.
 */
import type { IngestEntry } from '../capture/sources/claude-code.js';

/** Raw hook-fire payload, normalized to snake_case by
 *  `hooks/capture-runner.ts`'s normalizeHookInput(). */
export interface CaptureHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  trigger?: string;
}

export interface CaptureParseResult {
  entries: IngestEntry[];
  lastUuid: string | null;
  foundWatermark: boolean;
}

/** This agent's session-capture wiring - absorbed from the old
 *  `capture-runner.ts` CAPTURE_SOURCES map. The parser implementation stays
 *  in `capture/sources/<agent>.ts`; this just wires it into the registry. */
export interface AgentCapture {
  /** Hook-argv spelling this agent's hook scripts pass as the source arg
   *  (`capture.cjs <hookKey> <event>`). Equal to `harness` for every agent
   *  today - kept as its own field in case a future agent's hook wiring
   *  ever needs to diverge from its telemetry spelling. */
  hookKey: string;
  parse(content: string, afterUuid: string | null, hook: CaptureHookInput): CaptureParseResult;
  /** Where the transcript lives when the hook payload doesn't say. */
  resolveTranscriptPath?(hook: CaptureHookInput): string | null;
}

/** This agent's machine/project Gipity integration - absorbed from the
 *  bespoke per-agent blocks in `setup.ts`. The implementation (plugin
 *  enable, skills copy, hook-file merge) stays in `setup.ts`; this just
 *  wires it into the registry for `init.ts`/`uninstall.ts` to loop over. */
export interface AgentSetup {
  /** Current install/integration state (best-effort, no subprocess). */
  state(): { current: boolean };
  /** Best-effort materialize the Gipity integration at user/global scope
   *  (plugin install, skills copy). Idempotent, self-gating on the binary. */
  install(): void;
  /** Remove what install()/writeProjectHooks() put in place. Returns a
   *  human-readable summary line to print, or null if there was nothing to
   *  remove. */
  uninstall(): string | null;
  /** Write/refresh the project-level integration (hooks file, project
   *  settings) at process.cwd(). Absent for agents with no project-level
   *  file (Grok - a pure user-scope plugin, like Claude). */
  writeProjectHooks?(): void;
}

/** True if any env var name starts with `prefix`. Shared by agent env
 *  detection (Codex, Grok) and the passive-harness checks in
 *  client-context.ts (aider). */
export function hasEnvPrefix(prefix: string): boolean {
  return Object.keys(process.env).some((k) => k.startsWith(prefix));
}

export interface HeadlessArgsOpts {
  /** The prompt message (already context-wrapped when applicable). */
  message: string;
  /** Agent session id to resume, when continuing an existing session. */
  resume?: string;
  /** Concrete model id, or undefined for the agent's own default. */
  model?: string;
  /** Skip interactive approvals - a relay dispatch has no human present.
   *  Each agent maps this to its own least-broad equivalent. */
  bypassApprovals?: boolean;
  /** Emit machine-readable output on stdout (the agent's JSON stream). */
  jsonStream?: boolean;
}

export interface RemoteAgentAdapter {
  /** CLI-facing key: the `--agent <key>` value and picker identity. */
  key: string;
  /** The conversation `source` value the server stores ('claude_code', …).
   *  Underscore spelling - the DB/API discriminator. */
  source: string;
  /** Hook/telemetry spelling ('claude-code', …). Used by client-context.ts's
   *  `X-Gipity-Client` header and capture-runner's hook-argv lookup. Hyphen
   *  spelling - deliberately NOT unified with `source` (see the spec's hard
   *  constraint #3: two key spellings exist and both stay). */
  harness: string;
  displayName: string;
  /** Shown in the picker in parentheses: 'Anthropic', 'OpenAI', 'xAI'. */
  providerName: string;
  /** The executable on PATH. */
  binary: string;

  /** argv for an interactive launch (after the binary). Model/resume ride
   *  the shared `--model` / `--resume` flags where the agent supports them
   *  directly; agents with different resume syntax translate here. */
  buildInteractiveArgs(opts: { resume?: string; model?: string }): string[];

  /** argv for a headless one-shot (after the binary). */
  buildHeadlessArgs(opts: HeadlessArgsOpts): string[];

  /** Pull the agent's session id out of one parsed stdout-stream event, or
   *  null if this event doesn't carry it. */
  sessionIdFromStreamEvent(event: unknown): string | null;

  /** Whether hook-based session capture works on this OS. */
  hooksSupportedOnPlatform(platform: NodeJS.Platform): boolean;

  /** Whether the relay daemon parses this agent's stdout stream into ingest
   *  entries itself (Claude's proven stream-json path). When false, hook
   *  capture stays ON for dispatches and the daemon only tracks progress. */
  daemonStreamCapture: boolean;

  /** One-time manual step the user must do before hooks fire, if any -
   *  printed at launch when applicable (e.g. Codex `/hooks` approval). */
  oneTimeSetupNote?: string;

  /** Set when the agent does NOT fire lifecycle hooks in headless mode
   *  (verified live: Grok Build runs plugin hooks only in its interactive
   *  TUI). `gipity build -p` then pins the session id itself via
   *  `sessionIdArgs` and, after the child exits, replays the on-disk
   *  transcript through the capture runner (a synthetic session-start +
   *  stop) so headless runs and relay dispatches still record. */
  headlessCapture?: {
    sessionIdArgs(sessionId: string): string[];
  };

  /** Best-effort auto-install when the binary is missing. Returns true when
   *  the binary is usable afterwards. Absent = we can only print a hint. */
  ensureInstalled?(): boolean;
  /** Copy-paste install hint when auto-install is unavailable or failed. */
  installHint: string;

  /** Identify this agent from its env footprint (env vars the harness leaks
   *  into the shell it spawns us in). Returns null when not detected. Order
   *  of checks across the registry = specificity; client-context.ts iterates
   *  AGENT_ADAPTERS in registry order, falling back to non-agent harnesses
   *  (cursor, aider, gemini, ci, manual) when no adapter matches. */
  detectEnv?(): { harness: string; harnessVersion?: string; harnessSession?: string } | null;

  /** This agent's session-capture wiring. */
  capture: AgentCapture;

  /** This agent's machine/project Gipity integration. Absent for an agent
   *  with no deeper integration than the AGENTS.md primer. */
  setup?: AgentSetup;
}
