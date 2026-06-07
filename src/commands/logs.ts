import { Command } from 'commander';
import { get } from '../api.js';
import { requireConfig } from '../config.js';
import { success, error as clrError, warning, muted, bold } from '../colors.js';
import { run } from '../helpers/index.js';

interface FnLog {
  id: string;
  status: string;
  duration_ms: number | null;
  trigger_type: string;
  limits_consumed: Record<string, number> | null;
  error_message: string | null;
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
  .option('--json', 'Output as JSON')
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
      const statusColor = log.status === 'success' ? success : log.status === 'error' ? clrError : warning;
      const status = statusColor(log.status.padEnd(8));
      const trigger = muted(log.trigger_type.padEnd(8));
      const err = log.error_message ? `  ${clrError(`"${log.error_message}"`)}` : '';
      console.log(`${muted(time)}  ${status} ${dur} ${trigger}${err}`);
    }
  }));

logsCommand
  .command('app')
  .description('Unified recent activity for this app — JS errors, failed function calls, failed services, network failures. Designed for agents debugging a deployed app.')
  .option('--since <window>', "Window: 5m / 10m / 30m / 1h / 6h / 24h / 7d", '10m')
  .option('--severity <level>', 'error | warn | network | all', 'all')
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
      if (e.kind === 'service') {
        const dur = d.latency_ms as number | null;
        console.log(`             ${muted(`${d.service} (${d.provider ?? '?'}/${d.model ?? '?'}) • ${dur ?? '?'}ms`)}${d.error_message ? muted(' • ') + clrError(String(d.error_message).slice(0, 200)) : ''}`);
      }
    }

    if (truncated) {
      console.log(`\n${muted(`(truncated at ${limit} entries — bump --limit or narrow --filter)`)}`);
    }
  }));
