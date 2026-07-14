/**
 * RemoteAgentAdapter - the one abstraction between Gipity and a local coding
 * agent's EXECUTION surface (argv shapes, flags, stream schema). Everything
 * data-side is already agent-agnostic: conversations carry a `source`
 * discriminator, capture has a per-source parser registry
 * (cli/src/hooks/capture-runner.ts CAPTURE_SOURCES), and the DAL/routes are
 * parameterized. The adapter covers what a `source` string alone can't:
 *
 *   - how to launch the agent binary (interactive and headless)
 *   - how to resume a session, pick a model, bypass approvals
 *   - how to spot the session id in the agent's output stream
 *
 * Two consumers: the `gipity build` launcher (interactive + `-p`) and the
 * relay daemon (web-CLI dispatch). Adding an agent = one file here + one
 * capture parser + one REMOTE_TYPES value; no scattered `if (source === …)`.
 */

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
  /** The conversation `source` value the server stores ('claude_code', …). */
  source: string;
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
}
