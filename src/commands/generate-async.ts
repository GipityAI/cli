// Async image generations: submit, wait (live status), download, and the
// status / cancel / list / models subcommands of `gipity generate`.
//
// Gipity GPU models (`gipity-*`) are queued: a job can wait a while behind
// others, so they always go through the generations API rather than one long
// request. Any model can use it with `--no-wait`.

import { Command } from 'commander';
import { get, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { error as clrError, success, muted, warning } from '../colors.js';
import { printCommandError, run } from '../helpers/command.js';
import { confirm } from '../utils.js';

export interface GenerationOutput { url: string; bytes?: number; mime?: string; width?: number; height?: number; file_guid?: string }

export interface Generation {
  id: string;
  object: 'image.generation';
  status: 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  model: string;
  prompt: string;
  seed?: number | null;
  width?: number | null;
  height?: number | null;
  metadata?: Record<string, unknown> | null;
  queue_position?: number | null;
  eta_ms?: number | null;
  phase?: string | null;
  step?: number | null;
  total?: number | null;
  progress?: number | null;
  outputs?: { full?: GenerationOutput; display?: GenerationOutput; thumb?: GenerationOutput } | null;
  error?: { code: string; message: string } | null;
  credits_charged?: number | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface ImageModelInfo {
  id: string;
  label?: string;
  description?: string;
  provider: string;
  async_only?: boolean;
  nsfw?: boolean;
  sizes?: Record<string, [number, number]>;
  max_references?: number;
  avoid_supported?: boolean;
  available?: boolean;
  unavailable_reason?: string | null;
  price_credits?: number | null;
  eta_s?: number | null;
}

export interface GpuQueueInfo {
  online: boolean;
  queue?: { paid_ahead: number; free_ahead: number };
  est_wait_s?: { paid: number; free: number };
}

/** Gipity GPU models are queued and always generate asynchronously. */
export const isQueuedModel = (model?: string): boolean => !!model && model.startsWith('gipity-');

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

const gensPath = (guid: string) => `/projects/${guid}/generate/image/generations`;

/** How often to re-read status while waiting. Overridable for tests. */
function pollMs(): number {
  const v = Number(process.env.GIPITY_GENERATE_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 2000;
}

/** "about 2 min", "about 40s", "under 10s". */
export function fmtEta(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 10) return 'under 10s';
  if (s < 90) return `about ${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `about ${m} min`;
  return `about ${Math.round(m / 60)} h`;
}

/** One short line describing where a generation is. */
export function statusText(g: Generation): string {
  switch (g.status) {
    case 'queued': {
      const ahead = g.queue_position != null ? Math.max(0, g.queue_position - 1) : null;
      const eta = fmtEta(g.eta_ms);
      const where = ahead === null ? 'queued' : ahead === 0 ? 'queued: next up' : `queued: ${ahead} ahead`;
      return eta ? `${where}, ${eta}` : where;
    }
    case 'dispatched':
      return 'starting';
    case 'running': {
      if (g.phase === 'loading') return 'loading the model';
      if (g.step != null && g.total) return `rendering ${g.step}/${g.total}`;
      if (g.progress != null) return `rendering ${Math.round(g.progress * 100)}%`;
      return 'rendering';
    }
    case 'succeeded':
      return 'done';
    case 'failed':
      return `failed: ${g.error?.message ?? 'unknown error'}`;
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired: it waited too long in the queue (not charged)';
  }
}

export async function submitGenerations(projectGuid: string, body: Record<string, unknown>): Promise<Generation[]> {
  const res = await post<{ data: Generation[] }>(gensPath(projectGuid), body);
  return res.data;
}

export async function fetchGenerations(projectGuid: string, ids: string[]): Promise<Generation[]> {
  const res = await get<{ data: Generation[] }>(`${gensPath(projectGuid)}?ids=${ids.map(encodeURIComponent).join(',')}`);
  return res.data;
}

/** Combined status line for one or several generations. */
function combinedText(gens: Generation[]): string {
  if (gens.length === 1) return statusText(gens[0]);
  const done = gens.filter((g) => TERMINAL.has(g.status)).length;
  const live = gens.find((g) => !TERMINAL.has(g.status));
  return `${done}/${gens.length} finished${live ? `; ${statusText(live)}` : ''}`;
}

/**
 * Poll until every generation is finished. Draws one live line on a TTY;
 * otherwise prints a line each time the status changes (to stderr under --json,
 * so stdout stays pure JSON). Ctrl-C asks whether to cancel or leave them queued.
 */
export async function waitForGenerations(projectGuid: string, initial: Generation[], opts: { json?: boolean } = {}): Promise<Generation[]> {
  const ids = initial.map((g) => g.id);
  const tty = !!process.stdout.isTTY && !opts.json;
  const say = (line: string) => (opts.json ? console.error(line) : console.log(line));
  let gens = initial;
  let last = '';
  let lineOpen = false;

  const draw = (text: string) => {
    if (tty) {
      process.stdout.write(`\r  ${muted(text)}\x1b[K`);
      lineOpen = true;
    } else if (text !== last) {
      say(`  ${text}`);
    }
    last = text;
  };
  const closeLine = () => {
    if (lineOpen) { process.stdout.write('\r\x1b[K'); lineOpen = false; }
  };

  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.on('SIGINT', onSigint);
  try {
    draw(combinedText(gens));
    while (!gens.every((g) => TERMINAL.has(g.status))) {
      await sleepUnlessInterrupted(pollMs(), () => interrupted);
      if (interrupted) break;
      gens = await fetchGenerations(projectGuid, ids);
      draw(combinedText(gens));
    }
  } finally {
    process.off('SIGINT', onSigint);
    closeLine();
  }

  if (interrupted) {
    const open = gens.filter((g) => !TERMINAL.has(g.status)).map((g) => g.id);
    if (process.stdin.isTTY && await confirm(`Cancel ${open.length === 1 ? 'the generation' : `${open.length} generations`}? No leaves ${open.length === 1 ? 'it' : 'them'} queued`, { default: 'no', headless: 'no' })) {
      for (const id of open) await post(`${gensPath(projectGuid)}/${encodeURIComponent(id)}/cancel`);
      console.log(muted(`Cancelled ${open.join(' ')} (not charged).`));
    } else {
      console.error(muted(`Left queued. Check later with: gipity generate status ${open.join(' ')}`));
    }
    process.exit(130);
  }
  return gens;
}

function sleepUnlessInterrupted(ms: number, stop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (stop() || Date.now() - started >= ms) return resolve();
      setTimeout(tick, Math.min(100, ms));
    };
    tick();
  });
}

// ── Subcommands ────────────────────────────────────────────────────────

function printGeneration(g: Generation): void {
  const head = g.status === 'succeeded' ? success(g.id) : g.status === 'failed' || g.status === 'expired' ? clrError(g.id) : g.id;
  console.log(`${head}  ${muted(g.model)}  ${statusText(g)}`);
  if (g.status === 'succeeded' && g.outputs?.full?.url) console.log(`  ${muted('url:')} ${g.outputs.full.url}`);
  if (g.credits_charged != null && g.credits_charged > 0) console.log(`  ${muted('credits:')} ${g.credits_charged}`);
}

const statusCommand = new Command('status')
  .description('Show where queued or finished image generations are')
  .argument('<ids...>', 'Generation ids (gen_...)')
  .option('--json', 'Output as JSON')
  .action((ids: string[], opts) => run('Generation status', async () => {
    const { config } = await resolveProjectContext();
    const gens = await fetchGenerations(config.projectGuid, ids);
    if (opts.json) { console.log(JSON.stringify(gens)); return; }
    const found = new Set(gens.map((g) => g.id));
    for (const g of gens) printGeneration(g);
    for (const id of ids.filter((i) => !found.has(i))) console.log(`${clrError(id)}  not found`);
  }));

const cancelCommand = new Command('cancel')
  .description('Cancel queued or running image generations (a cancelled one is not charged)')
  .argument('<ids...>', 'Generation ids (gen_...)')
  .option('--json', 'Output as JSON')
  .action((ids: string[], opts) => run('Cancel', async () => {
    const { config } = await resolveProjectContext();
    const out: Generation[] = [];
    for (const id of ids) {
      const res = await post<{ data: Generation }>(`${gensPath(config.projectGuid)}/${encodeURIComponent(id)}/cancel`);
      out.push(res.data);
    }
    if (opts.json) { console.log(JSON.stringify(out)); return; }
    for (const g of out) printGeneration(g);
  }));

const listCommand = new Command('list')
  .description('List your recent image generations in this project')
  .option('--open', 'Only queued or running ones')
  .option('--limit <n>', 'How many (default 20)', (v) => parseInt(v, 10))
  .option('--json', 'Output as JSON')
  .action((opts) => run('List generations', async () => {
    const { config } = await resolveProjectContext();
    const qs = opts.open ? 'status=open' : `limit=${Number.isFinite(opts.limit) ? opts.limit : 20}`;
    const res = await get<{ data: Generation[] }>(`${gensPath(config.projectGuid)}?${qs}`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    if (!res.data.length) { console.log(muted(opts.open ? 'Nothing queued or running.' : 'No generations yet.')); return; }
    for (const g of res.data) printGeneration(g);
  }));

function fmtWait(s: number | undefined): string {
  return s === undefined ? '?' : (fmtEta(s * 1000) ?? '?');
}

const modelsCommand = new Command('models')
  .description('List image models, with prices and queue estimates for Gipity GPU models')
  .option('--json', 'Output as JSON')
  .action((opts) => run('Image models', async () => {
    const { config } = await resolveProjectContext();
    const res = await get<{ data: { models: ImageModelInfo[]; gipity_gpu: GpuQueueInfo | null } }>(
      `/projects/${config.projectGuid}/generate/image/models`,
    );
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    const { models, gipity_gpu: gpu } = res.data;
    const cloud = models.filter((m) => !isQueuedModel(m.id));
    const queued = models.filter((m) => isQueuedModel(m.id));
    if (cloud.length) {
      console.log('Cloud models (one request, immediate):');
      for (const m of cloud) console.log(`  ${m.id.padEnd(30)} ${muted(m.provider)}`);
    }
    if (queued.length) {
      if (cloud.length) console.log('');
      console.log('Gipity GPU models (queued, half the usual price):');
      if (gpu) {
        console.log(muted(gpu.online
          ? `  queue: ${gpu.queue?.paid_ahead ?? 0} paid + ${gpu.queue?.free_ahead ?? 0} free ahead; wait ${fmtWait(gpu.est_wait_s?.paid)} on a paid plan, ${fmtWait(gpu.est_wait_s?.free)} on Free`
          : '  offline right now: new jobs wait in the queue until it is back'));
      }
      const width = Math.max(...queued.map((m) => m.id.length));
      for (const m of queued) {
        const price = m.price_credits != null ? `${m.price_credits} credits` : 'not priced yet';
        const tags = [m.nsfw ? warning('NSFW') : '', m.max_references ? muted(`refs:${m.max_references}`) : ''].filter(Boolean).join(' ');
        const state = m.available === false ? clrError(`unavailable${m.unavailable_reason ? `: ${m.unavailable_reason}` : ''}`) : '';
        console.log(`  ${m.id.padEnd(width)}  ${price.padEnd(16)} ${[tags, state].filter(Boolean).join(' ')}`.trimEnd());
        if (m.label || m.description) console.log(muted(`  ${''.padEnd(width)}  ${[m.label, m.description].filter(Boolean).join(': ')}`));
      }
    }
  }));

/** Attach the async subcommands to the `generate` parent. */
export function addGenerationSubcommands(parent: Command): Command {
  return parent.addCommand(statusCommand).addCommand(cancelCommand).addCommand(listCommand).addCommand(modelsCommand);
}

export { printCommandError };
