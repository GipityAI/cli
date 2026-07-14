import { Command } from 'commander';
import { get, post, del, publicPost } from '../api.js';
import { getAuth } from '../auth.js';
import { requireConfig } from '../config.js';
import { error as clrError, bold, muted, success, warning } from '../colors.js';
import { run, printList, emitField } from '../helpers/index.js';
import { confirm } from '../utils.js';

export const fnCommand = new Command('fn')
  .description('Manage functions');

fnCommand
  .command('list')
  .description('List functions')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/functions`);

    printList(res.data, opts, 'No functions defined.', f => {
      const line = `${bold(f.name)}  ${muted(`v${f.version}`)}  ${muted(f.auth_level)}  ${muted(`timeout=${f.timeout_ms}ms`)}`;
      return f.description ? `${line}\n${muted(f.description)}` : line;
    });
  }));

fnCommand
  .command('logs <name>')
  .description('Show recent logs')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Logs', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(
      `/projects/${config.projectGuid}/functions/${name}/logs?limit=${opts.limit}`,
    );

    printList(res.data, opts, 'No execution logs.', log => {
      const dur = log.duration_ms != null ? `${log.duration_ms}ms` : '?';
      const ts = new Date(log.created_at).toLocaleString();
      const statusColor = log.status === 'success' ? success : log.status === 'error' ? clrError : muted;
      let line = `${statusColor(log.status)}  ${dur}  ${muted(log.trigger_type || 'http')}  ${muted(ts)}`;
      if (log.error_message) line += `\n${clrError(`error: ${log.error_message}`)}`;
      // Captured console.log/warn/error output for this invocation.
      for (const entry of (log.logs ?? []) as Array<{ level: string; message: string }>) {
        const lvlColor = entry.level === 'error' ? clrError : entry.level === 'warn' ? warning : muted;
        const tag = entry.level === 'log' ? '' : `${entry.level}: `;
        line += `\n  ${lvlColor(`${tag}${entry.message}`)}`;
      }
      return line;
    });
  }));

/** Invoke a function exactly like an anonymous visitor: mint the same
 *  short-lived public app token the browser SDK uses (best-effort — public
 *  functions run with no token at all), POST with no user credentials, and
 *  return the standard envelope. A 401 here is the correct answer for an
 *  auth-gated function — the server's message is surfaced as-is, with no
 *  "run: gipity login" misdirection. */
async function callAnon(projectGuid: string, name: string, body: unknown): Promise<{ data: any }> {
  let appToken: string | undefined;
  try {
    const minted = await publicPost<{ data: { token: string } }>('/api/token', { app: projectGuid });
    appToken = minted.data.token;
  } catch { /* public functions work without a token; auth-gated ones will 401 with the real reason */ }
  return publicPost<{ data: any }>(
    `/api/${projectGuid}/fn/${encodeURIComponent(name)}`,
    body,
    appToken ? { 'X-App-Token': appToken } : undefined,
  );
}

fnCommand
  .command('call <name> [body]')
  .description('Call a function')
  .option('--data <json>', 'JSON request body')
  .option('--anon', 'Call as an anonymous visitor (the public path a signed-out user hits) instead of as your signed-in account')
  .option('--field <path>', 'Print only this field of the result (dot path, e.g. items.0.short_guid)')
  .option('--json', 'Output as JSON')
  .action((name: string, bodyArg: string | undefined, opts) => run('Call', async () => {
    const config = requireConfig();
    const raw = bodyArg || opts.data || '{}';
    const body = JSON.parse(raw);
    const path = `/api/${config.projectGuid}/fn/${encodeURIComponent(name)}`;
    // Name the calling identity (stderr, so stdout stays parseable). Without
    // this, a "test the anonymous path" call silently runs authenticated as
    // the signed-in owner and the public path never gets exercised.
    if (opts.anon) {
      console.error(muted('Auth: anonymous visitor (the public path a signed-out user hits)'));
    } else {
      const who = getAuth()?.email;
      console.error(muted(`Auth: calling as ${who ?? 'your signed-in account'} (the owner persona; use --anon for the public visitor path)`));
    }
    const res = opts.anon
      ? await callAnon(config.projectGuid, name, body)
      : await post<{ data: any }>(path, body);
    if (opts.field) { emitField(res.data, opts.field); return; }
    console.log(opts.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
  }));

fnCommand
  .command('delete <name>')
  .alias('rm')
  .description('Delete a function')
  .option('--yes', 'Skip confirmation')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Delete', async () => {
    const config = requireConfig();
    if (!await confirm(`Delete function '${name}'? This cannot be undone.`, { skip: opts.yes })) {
      console.log('Cancelled.');
      return;
    }

    await del<{ data: { deleted: boolean } }>(
      `/projects/${config.projectGuid}/functions/${encodeURIComponent(name)}`,
    );

    if (opts.json) {
      console.log(JSON.stringify({ name, deleted: true }));
    } else {
      console.log(success(`Deleted function '${name}'.`));
    }
  }));
