import { Command, Option } from 'commander';
import { get } from '../api.js';
import { requireConfig } from '../config.js';
import { success, error as clrError, warning, muted, bold } from '../colors.js';
import { run } from '../helpers/index.js';

interface FnLogLine {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

interface FnLog {
  id: string;
  status: string;
  duration_ms: number | null;
  trigger_type: string;
  limits_consumed: Record<string, number> | null;
  error_message: string | null;
  logs: FnLogLine[] | null;
  created_at: string;
}

interface AppLogEntry {
  kind: 'error' | 'function' | 'service' | 'traffic';
  at: string;
  severity?: string;
  summary: string;
  detail: Record<string, unknown>;
}

interface AppLogResponse {
  data: {
    entries: AppLogEntry[];
    since: string;
    severity: string;
    types: string[];
    count: number;
    truncated: boolean;
  };
}

export const logsCommand = new Command('logs')
  .description('View logs');

logsCommand
  .command('fn <name>')
  .description('Show function logs')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON (top-level ARRAY of invocations, newest first)')
  .addHelpText('after', `
Each line: time, status (ok / error / limit_exceeded), duration, trigger, and
svc:N when the invocation made N platform service calls (notify, email, LLM,
image, ...). Captured console output is indented beneath its invocation.

--json emits a top-level ARRAY (not an object) of invocation rows:
  [{ id, status, duration_ms, trigger_type, error_message,
     limits_consumed: { max_queries, max_service_calls, ... }, logs: [...], created_at }]

To confirm an individual service call succeeded (and see provider, latency,
and its own error message), use the per-call log instead:
  $ gipity logs app --type services
`)
  .action((name: string, opts) => run('Logs', async () => {
    const config = requireConfig();
    const limit = parseInt(opts.limit, 10) || 20;
    const res = await get<{ data: FnLog[] }>(
      `/projects/${config.projectGuid}/functions/${encodeURIComponent(name)}/logs?limit=${limit}`
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }

    if (res.data.length === 0) {
      console.log(`No logs for function "${name}".`);
      return;
    }

    console.log(`Logs for ${bold(`"${name}"`)} ${muted(`(last ${res.data.length})`)}:`);
    for (const log of res.data) {
      const time = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const dur = log.duration_ms !== null ? `${log.duration_ms}ms`.padEnd(8) : ''.padEnd(8);
      // The runtime writes 'ok' | 'error' | 'limit_exceeded'; it has never
      // written 'success'. Matching on that dead value painted every healthy
      // invocation with the warning colour, so a clean log read as a problem.
      const statusColor = log.status === 'ok' ? success : log.status === 'error' ? clrError : warning;
      const status = statusColor(log.status.padEnd(8));
      const trigger = muted(log.trigger_type.padEnd(8));
      // Service calls made inside the invocation (notify, email, LLM, ...) are
      // otherwise invisible here - surface the count so "did my send happen?"
      // doesn't require spelunking --json limits counters. Per-call outcomes
      // live in `gipity logs app --type services`.
      const svcCalls = log.limits_consumed?.max_service_calls;
      const svc = svcCalls ? ` ${muted(`svc:${svcCalls}`)}` : '';
      const err = log.error_message ? `  ${clrError(`"${log.error_message}"`)}` : '';
      console.log(`${muted(time)}  ${status} ${dur} ${trigger}${svc}${err}`);
      // Captured console.log/warn/error output for this invocation, indented
      // under its summary line. Empty for calls that printed nothing.
      for (const line of log.logs ?? []) {
        const lvlColor = line.level === 'error' ? clrError : line.level === 'warn' ? warning : muted;
        const tag = line.level === 'log' ? '' : `${line.level}: `;
        console.log(`${muted('         │')} ${lvlColor(`${tag}${line.message}`)}`);
      }
    }
  }));

logsCommand
  .command('app')
  .description('Unified recent activity for this app: JS errors, failed function calls, failed services, network failures. Designed for agents debugging a deployed app.')
  .option('--since <window>', "Window: 5m / 10m / 30m / 1h / 6h / 24h / 7d", '10m')
  .addOption(new Option('--severity <level>', 'Severity filter').choices(['error', 'warn', 'network', 'all']).default('all'))
  .option('--type <list>', "Comma-separated: errors,functions,services,traffic. Default excludes traffic (high volume).")
  .option('--filter <pattern>', 'Substring match against message / fn name / path (case-insensitive)')
  .option('--limit <n>', 'Max entries', '100')
  .option('--json', 'Output as JSON (parseable by agents / pipes)')
  .addHelpText('after', `
Examples:
  $ gipity logs app                              Last 10 min of errors + fn failures
  $ gipity logs app --since 1h                   Last hour
  $ gipity logs app --severity network           Only fetch/XHR failures
  $ gipity logs app --filter song-create         Anything mentioning song-create
  $ gipity logs app --type errors                Only JS errors
  $ gipity logs app --json | jq .data.entries[0] Pipe-friendly
`)
  .action((opts) => run('App logs', async () => {
    const config = requireConfig();
    const limit = parseInt(opts.limit, 10) || 100;
    const qs = new URLSearchParams();
    qs.set('since', String(opts.since));
    qs.set('severity', String(opts.severity));
    if (opts.type) qs.set('type', String(opts.type));
    if (opts.filter) qs.set('filter', String(opts.filter));
    qs.set('limit', String(limit));

    const res = await get<AppLogResponse>(
      `/projects/${config.projectGuid}/logs/app?${qs.toString()}`
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }

    const { entries, since, types, severity, truncated } = res.data;
    if (entries.length === 0) {
      console.log(`No activity in the last ${since} ${muted(`(severity=${severity} types=${types.join(',')})`)}.`);
      return;
    }

    console.log(`${bold(`Recent activity`)} ${muted(`(last ${since}, ${entries.length}${truncated ? '+' : ''} entries, severity=${severity})`)}\n`);
    for (const e of entries) {
      const time = new Date(e.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const kindColor = e.kind === 'error' ? clrError : e.kind === 'function' ? warning : e.kind === 'service' ? warning : muted;
      const kindTag = kindColor(`[${e.kind.padEnd(8)}]`);
      console.log(`${muted(time)} ${kindTag} ${e.summary}`);

      // Per-kind drilldown lines — what an agent most often needs without
      // having to re-fetch the row.
      const d = e.detail as Record<string, unknown>;
      if (e.kind === 'error') {
        const capturedBy = d.captured_by as string | null;
        const url = d.network_url as string | null;
        const status = d.network_status as number | null;
        if (url) console.log(`             ${muted(`${capturedBy} → ${d.network_method || 'GET'} ${url} (${status ?? 'failed'})`)}`);
        if (d.network_response_snippet) console.log(`             ${muted(`resp: ${String(d.network_response_snippet).slice(0, 160)}`)}`);
        const corr = d.correlated_function_log as Record<string, unknown> | undefined;
        if (corr) {
          console.log(`             ${muted(`└─ server fn ${corr.function_name} → ${corr.status}${corr.error_message ? ': ' + String(corr.error_message).slice(0, 100) : ''}`)}`);
        }
        const breadcrumbs = d.breadcrumbs as Array<{ kind: string; detail?: Record<string, unknown> }> | null;
        if (breadcrumbs && breadcrumbs.length > 0) {
          const lastFew = breadcrumbs.slice(-3).map(b => `${b.kind}${b.detail?.selector || b.detail?.url || b.detail?.path ? `:${b.detail.selector || b.detail.url || b.detail.path}` : ''}`).join(' → ');
          console.log(`             ${muted(`crumbs: ${lastFew}`)}`);
        }
      }
      if (e.kind === 'function') {
        const dur = d.duration_ms as number | null;
        console.log(`             ${muted(`${d.trigger_type} • ${dur ?? '?'}ms`)}${d.error_message ? muted(' • ') + clrError(String(d.error_message).slice(0, 200)) : ''}`);
      }
      if (e.kind === 'traffic') {
        const where = [d.city, d.region, d.country].filter(Boolean).join(', ');
        const bits = [where, d.referrer ? `from ${d.referrer}` : ''].filter(Boolean).join(' • ');
        if (bits) console.log(`             ${muted(bits)}`);
      }
      if (e.kind === 'service') {
        const dur = d.latency_ms as number | null;
        console.log(`             ${muted(`${d.service} (${d.provider ?? '?'}/${d.model ?? '?'}) • ${dur ?? '?'}ms`)}${d.error_message ? muted(' • ') + clrError(String(d.error_message).slice(0, 200)) : ''}`);
      }
    }

    if (truncated) {
      console.log(`\n${muted(`(truncated at ${limit} entries: bump --limit or narrow --filter)`)}`);
    }
  }));

interface TopItem { key: string; count: number; sessions?: number; region?: string | null; country?: string | null }
interface TopResponse { data: { items: TopItem[] } }

const TRAFFIC_RANGES = ['1h', '24h', '7d', '30d'];

logsCommand
  .command('traffic')
  .description('Visitor summary for this app: page views, sessions, and the top countries, cities, pages and referring sites')
  .addOption(new Option('--range <window>', 'Time window').choices(TRAFFIC_RANGES).default('7d'))
  .option('--country <code>', 'Only visitors from one country (ISO code, e.g. US)')
  .option('--limit <n>', 'Rows per list', '10')
  .option('--json', 'Output as JSON (parseable by agents / pipes)')
  .addHelpText('after', `
Counts page views recorded by the Gipity tracker (gipity.js), on a Gipity app or
on any other site that loads it with this project's data-app. Country and city
come from each visitor's IP address when the view arrives; the address itself is
not stored.

Examples:
  $ gipity logs traffic                    Last 7 days
  $ gipity logs traffic --range 24h        Last 24 hours
  $ gipity logs traffic --country US       US visitors only: their pages and cities
  $ gipity logs traffic --json             { pageviews, sessions, countries, cities, pages, referrers }

Page-by-page rows: gipity logs app --type traffic --since 1h
`)
  .action((opts) => run('Traffic', async () => {
    const config = requireConfig();
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 50);
    const country = opts.country ? String(opts.country).trim().toUpperCase() : undefined;
    if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
      throw new Error(`--country takes a two-letter country code (e.g. US), not "${opts.country}"`);
    }
    const base = new URLSearchParams({ range: String(opts.range), app_guid: config.projectGuid });
    const top = (signal: string) => {
      const qs = new URLSearchParams(base);
      qs.set('signal', signal);
      qs.set('limit', String(limit));
      if (country) qs.set('country', country);
      return get<TopResponse>(`/account/logs/top?${qs.toString()}`).then((r) => r.data.items);
    };
    const [stats, sessions, countries, cities, pages, referrers] = await Promise.all([
      get<{ data: { cards: { traffic: number } } }>(`/account/logs/stats?${base.toString()}`),
      get<{ data: { sessions: number; live: number } }>(`/account/logs/stats/sessions?${base.toString()}`),
      top('country'), top('city'), top('path'), top('referrer_host'),
    ]);

    const summary = {
      range: String(opts.range),
      country: country ?? null,
      pageviews: stats.data.cards.traffic,
      sessions: sessions.data.sessions,
      live: sessions.data.live,
      countries, cities, pages, referrers,
    };
    if (opts.json) {
      console.log(JSON.stringify(summary));
      return;
    }

    const scope = country ? `, visitors from ${country}` : '';
    if (country) {
      console.log(`${bold('Traffic')} ${muted(`(last ${summary.range}${scope})`)}\n`);
    } else {
      console.log(`${bold('Traffic')} ${muted(`(last ${summary.range})`)}: ${summary.pageviews} page views, ${summary.sessions} sessions, ${summary.live} live now\n`);
    }
    const section = (title: string, items: TopItem[], label: (i: TopItem) => string) => {
      console.log(bold(title));
      if (items.length === 0) { console.log(`  ${muted('none in this window')}\n`); return; }
      const width = Math.min(Math.max(...items.map((i) => label(i).length)), 48);
      for (const i of items) {
        const name = label(i);
        const shown = name.length > 48 ? name.slice(0, 45) + '...' : name.padEnd(width);
        const sess = typeof i.sessions === 'number' ? muted(`  ${i.sessions} sessions`) : '';
        console.log(`  ${shown}  ${String(i.count).padStart(6)} views${sess}`);
      }
      console.log('');
    };
    section('Countries', countries, (i) => i.key);
    section('Cities', cities, (i) => [i.key, i.region, i.country].filter(Boolean).join(', '));
    section('Pages', pages, (i) => i.key);
    section('Referring sites', referrers, (i) => i.key);
    if (countries.length === 0 && pages.length === 0) {
      console.log(muted('No page views yet. Load gipity.js on the site with data-app="' + config.projectGuid + '" (gipity skill read app-debugging).'));
    }
  }));
