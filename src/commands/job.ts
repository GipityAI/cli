import { Command } from 'commander';
import { get, post, del, getBaseUrl, getAuthHeader } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, bold, muted, success, warning as warn } from '../colors.js';
import { run, printList, resolveBody, parseDuration } from '../helpers/index.js';

export const jobCommand = new Command('job')
  .description('Run long jobs (CPU/GPU)')
  .addHelpText('after', '\nCPU sandbox or GPU (gpu-small=L4, gpu-medium=A10G, gpu-large=A100, gpu-huge=H100). Declared in the gipity.yaml jobs: phase; submit and poll via the subcommands below.');

jobCommand
  .command('list')
  .description('List jobs')
  .option('--json', 'Output as JSON')
  .action((opts) => run('List', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(`/projects/${config.projectGuid}/jobs`);

    printList(res.data, opts, 'No jobs defined.', j => {
      const tags: string[] = [muted(`v${j.version}`), muted(j.runtime), muted(j.compute)];
      if (j.on_complete) tags.push(muted(`→ ${j.on_complete}`));
      const line = `${bold(j.name)}  ${tags.join('  ')}`;
      return j.description ? `${line}\n${muted(j.description)}` : line;
    });
  }));

jobCommand
  .command('submit <name> [body]')
  .description('Submit a job (returns a run guid; block on it with `job wait <guid>`)')
  .option('-d, --data <json>', 'JSON input body: inline JSON, @file to read a file, or @- / - for stdin')
  .option('--file <field=@path>', 'Attach a file as { data, media_type } under <field> (the vision/media service shape), repeatable, e.g. --file image=@scan.png', (v: string, acc: string[]) => (acc || []).concat(v))
  .option('--idempotency-key <key>', 'Idempotency key (replays return the existing run)')
  .option('--json', 'Output as JSON')
  .action((name: string, bodyArg: string | undefined, opts) => run('Submit', async () => {
    const config = requireConfig();
    const input = resolveBody(bodyArg || opts.data, opts.file);
    const body: Record<string, unknown> = { input };
    if (opts.idempotencyKey) body.idempotency_key = opts.idempotencyKey;
    const res = await post<{ data: any }>(
      `/projects/${config.projectGuid}/jobs/${encodeURIComponent(name)}/submit`,
      body,
    );
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      const tag = res.data.replayed ? warn(' (replayed)') : '';
      console.log(`${bold(res.data.run_guid)}  ${muted(res.data.status)}${tag}`);
      // Awaiting the run is the natural next step after every submit; point the
      // agent at the blocking command so it doesn't hand-roll a status poll loop.
      const TERMINAL = new Set(['success', 'failed', 'cancelled', 'canceled', 'error']);
      if (!TERMINAL.has(res.data.status)) {
        console.error(muted(`Block until it finishes: gipity job wait ${res.data.run_guid}`));
      }
    }
  }));

jobCommand
  .command('status <runGuid>')
  .description('Show status of a job run')
  .option('--json', 'Output as JSON')
  .action((runGuid: string, opts) => run('Status', async () => {
    const config = requireConfig();
    const res = await get<{ data: any }>(`/projects/${config.projectGuid}/jobs/runs/${encodeURIComponent(runGuid)}`);
    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }
    const r = res.data;
    const statusColor = r.status === 'success' ? success : r.status === 'failed' ? clrError : muted;
    console.log(`${statusColor(r.status)}  ${muted(r.guid)}`);
    if (r.progress_pct != null) console.log(`progress: ${Math.round(r.progress_pct * 100)}%${r.progress_message ? ` (${r.progress_message})` : ''}`);
    if (r.duration_ms != null) console.log(`duration: ${r.duration_ms}ms`);
    if (r.error) console.log(`${clrError('error:')} ${r.error}`);
    if (r.output) console.log(`output: ${JSON.stringify(r.output)}`);
  }));

jobCommand
  .command('wait <runGuid>')
  .description('Block until a job run finishes, or exit at --timeout so the shell never hangs (poll again to keep waiting)')
  .option('--timeout <seconds>', 'Max seconds to wait before giving up and reporting current progress. Bare number = seconds; an explicit unit (90s) means the same here and on `sandbox run --timeout`.', '90')
  .option('--interval <seconds>', 'Seconds between polls', '3')
  .option('--json', 'Output as JSON')
  .action((runGuid: string, opts) => run('Wait', async () => {
    const config = requireConfig();
    // Terminal states end the wait; anything else means "still working, keep polling".
    const TERMINAL = new Set(['success', 'failed', 'cancelled', 'canceled', 'error']);
    const durOpt = parseDuration(opts.timeout, 's');
    const timeoutSec = durOpt ? Math.max(1, Math.round(durOpt.value)) : parseInt(opts.timeout, 10);
    const timeout = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 90;
    const interval = Math.max(1, parseInt(opts.interval, 10) || 3);
    const deadline = Date.now() + timeout * 1000;

    const fetchRun = async () =>
      (await get<{ data: any }>(`/projects/${config.projectGuid}/jobs/runs/${encodeURIComponent(runGuid)}`)).data;

    let r = await fetchRun();
    let lastProgress = '';
    while (!TERMINAL.has(r.status) && Date.now() < deadline) {
      // Surface progress changes to stderr so an agent watching sees liveness
      // without the poll noise polluting the machine-readable stdout result.
      if (!opts.json) {
        const prog = r.progress_pct != null
          ? `${Math.round(r.progress_pct * 100)}%${r.progress_message ? ` (${r.progress_message})` : ''}`
          : r.status;
        if (prog !== lastProgress) { console.error(muted(`... ${prog}`)); lastProgress = prog; }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(res => setTimeout(res, Math.min(interval * 1000, remaining)));
      r = await fetchRun();
    }

    const done = TERMINAL.has(r.status);
    if (opts.json) {
      console.log(JSON.stringify(done ? r : { ...r, waiting: true, timed_out: true }));
    } else if (!done) {
      // Not an error - the job is simply still going. Say so plainly and tell
      // the agent exactly how to resume, then exit non-zero so a chained `&&`
      // doesn't proceed as if the run had finished.
      const prog = r.progress_pct != null ? ` ${Math.round(r.progress_pct * 100)}%` : '';
      console.log(`${warn('still running')}${prog}${r.progress_message ? ` (${r.progress_message})` : ''}  ${muted(runGuid)}`);
      console.log(muted(`Not finished after ${timeout}s. Run \`gipity job wait ${runGuid}\` again to keep waiting.`));
    } else {
      const statusColor = r.status === 'success' ? success : clrError;
      console.log(`${statusColor(r.status)}  ${muted(r.guid)}`);
      if (r.duration_ms != null) console.log(`duration: ${r.duration_ms}ms`);
      if (r.error) console.log(`${clrError('error:')} ${r.error}`);
      if (r.output) console.log(`output: ${JSON.stringify(r.output)}`);
    }
    // Exit codes: success → 0, failed/cancelled → 1, still-running-at-timeout → 2
    // (distinct from a real failure so agents can tell "not yet" from "broke").
    if (!done) process.exit(2);
    if (r.status !== 'success') process.exit(1);
  }));

jobCommand
  .command('runs <name>')
  .description('List recent runs for a job')
  .option('--limit <n>', 'Max entries', '20')
  .option('--json', 'Output as JSON')
  .action((name: string, opts) => run('Runs', async () => {
    const config = requireConfig();
    const res = await get<{ data: any[] }>(
      `/projects/${config.projectGuid}/jobs/${encodeURIComponent(name)}/runs?limit=${opts.limit}`,
    );
    printList(res.data, opts, 'No runs for this job.', r => {
      const statusColor = r.status === 'success' ? success : r.status === 'failed' ? clrError : muted;
      const dur = r.duration_ms != null ? `${r.duration_ms}ms` : '?';
      const ts = new Date(r.created_at).toLocaleString();
      const line = `${statusColor(r.status)}  ${dur}  ${muted(r.trigger_type)}  ${muted(r.guid)}  ${muted(ts)}`;
      return r.error ? `${line}\n${clrError(`error: ${r.error}`)}` : line;
    });
  }));

jobCommand
  .command('logs <runGuid>')
  .description('Stream live logs for a job run (--no-follow for a one-shot snapshot)')
  .option('--follow', 'Stream via SSE (default)', true)
  .option('--no-follow', 'One-shot snapshot of run state instead of streaming')
  .option('--timeout <seconds>', 'Stop streaming after N seconds and exit cleanly, so a bounded peek at the live log never hangs the shell (no shell `timeout` wrapper needed). Bare number = seconds; unit (20s) also accepted.')
  .option('--json', 'Output as JSON')
  .action((runGuid: string, opts) => run('Logs', async () => {
    const config = requireConfig();
    if (!opts.follow) {
      const res = await get<{ data: any }>(`/projects/${config.projectGuid}/jobs/runs/${encodeURIComponent(runGuid)}`);
      console.log(opts.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
      return;
    }
    // Optional bounded peek: close the stream after --timeout seconds instead of
    // holding open until the run finishes. Lets an agent glance at early stdout
    // (e.g. catch an import error during cold start) without wrapping the command
    // in a shell `timeout`, then poll again to keep watching.
    let peekSeconds = 0;
    if (opts.timeout != null) {
      const dur = parseDuration(String(opts.timeout), 's');
      const secs = dur ? dur.value : parseFloat(String(opts.timeout));
      peekSeconds = Number.isFinite(secs) && secs > 0 ? secs : 0;
    }
    // SSE stream. Manual fetch + line buffering - Node's EventSource isn't built-in,
    // and the SSE format is simple enough to parse inline (event: <name>\ndata: <json>\n\n).
    const url = `${getBaseUrl()}/projects/${config.projectGuid}/jobs/runs/${encodeURIComponent(runGuid)}/logs/stream`;
    const authHeader = await getAuthHeader();
    const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
    if (authHeader) headers.Authorization = authHeader;
    // Abort the underlying request when the peek window elapses so the socket is
    // torn down cleanly rather than left dangling.
    const controller = new AbortController();
    let peekTimer: NodeJS.Timeout | undefined;
    let peekedOut = false;
    if (peekSeconds > 0) {
      peekTimer = setTimeout(() => { peekedOut = true; controller.abort(); }, peekSeconds * 1000);
    }
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } catch (e) {
      if (peekedOut) {
        console.error(muted(`... still streaming after ${peekSeconds}s. Run \`gipity job logs ${runGuid} --timeout ${Math.round(peekSeconds)}\` again to keep watching, or \`gipity job wait ${runGuid}\` to block until it finishes.`));
        return;
      }
      throw e;
    }
    if (!res.ok || !res.body) {
      if (peekTimer) clearTimeout(peekTimer);
      console.error(clrError(`Failed to open stream: HTTP ${res.status}`));
      process.exit(1);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        // Peek window elapsed mid-stream: report cleanly and exit 0 (not an error).
        if (peekedOut) {
          console.error(muted(`... still streaming after ${peekSeconds}s. Run \`gipity job logs ${runGuid} --timeout ${Math.round(peekSeconds)}\` again to keep watching, or \`gipity job wait ${runGuid}\` to block until it finishes.`));
          return;
        }
        throw e;
      }
      const { done, value } = chunk;
      if (done) { if (peekTimer) clearTimeout(peekTimer); break; }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const dataRaw = line.slice(5).trim();
          if (currentEvent === 'log') {
            try {
              const { type, chunk } = JSON.parse(dataRaw);
              // stderr chunks go to real stderr so pipes / redirects work
              // correctly (e.g. `gipity job logs <guid> > out.txt 2> err.txt`).
              if (type === 'stderr') process.stderr.write(clrError(chunk));
              else process.stdout.write(chunk);
            } catch { /* ignore malformed */ }
          } else if (currentEvent === 'status') {
            try {
              const s = JSON.parse(dataRaw);
              const statusColor = s.status === 'success' ? success : s.status === 'failed' ? clrError : muted;
              const extras: string[] = [];
              if (s.attempt && s.attempt > 1) extras.push(`attempt=${s.attempt}`);
              if (s.progress_pct != null) extras.push(`${Math.round(s.progress_pct * 100)}%`);
              if (s.progress_message) extras.push(`"${s.progress_message}"`);
              console.error(muted(`[status: ${statusColor(s.status)}${extras.length ? ' ' + extras.join(' ') : ''}]`));
            } catch { /* ignore */ }
          } else if (currentEvent === 'error') {
            try {
              const { message } = JSON.parse(dataRaw);
              console.error(clrError(`[error] ${message}`));
            } catch { /* ignore */ }
          } else if (currentEvent === 'output') {
            console.error(muted('[output]'));
            console.error(dataRaw);
          }
          // skip 'ping' heartbeats silently
        } else if (line === '') {
          currentEvent = '';
        }
      }
    }
  }));

jobCommand
  .command('cancel <runGuid>')
  .description('Cancel a queued or running job')
  .option('--json', 'Output as JSON')
  .action((runGuid: string, opts) => run('Cancel', async () => {
    const config = requireConfig();
    const res = await del<{ data: any }>(`/projects/${config.projectGuid}/jobs/runs/${encodeURIComponent(runGuid)}`);
    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(`${success('cancelled')}  ${muted(runGuid)}`);
    }
  }));

jobCommand
  .command('run-local <name>')
  .description('Run the job in a local Docker container against your local filesystem (no platform round-trip)')
  .option('--image <image>', 'Docker image to run inside', 'easyclaw/sandbox:latest')
  .option('--no-deps', 'Skip pip/npm install even if a deps file is present')
  .action(async (name: string, opts) => {
    const { existsSync, statSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const { spawnCommand, spawnSyncCommand } = await import('../platform.js');

    const jobDir = resolve(process.cwd(), 'jobs', name);
    if (!existsSync(jobDir) || !statSync(jobDir).isDirectory()) {
      console.error(clrError(`jobs/${name}/ not found in current directory`));
      process.exit(1);
    }

    // Auto-detect runtime from handler filename.
    const variants: Array<{ file: string; runtime: 'python-3.11' | 'node-20' | 'bash'; entry: string; depsFile?: string; installCmd?: string[] }> = [
      { file: 'main.py', runtime: 'python-3.11', entry: 'python3', depsFile: 'requirements.txt',
        installCmd: ['pip', 'install', '--user', '--break-system-packages', '--quiet', '--disable-pip-version-check', '-r', '/work/requirements.txt'] },
      { file: 'main.js', runtime: 'node-20', entry: 'node', depsFile: 'package.json',
        installCmd: ['npm', 'install', '--silent', '--no-audit', '--no-fund', '--prefix', '/work'] },
      { file: 'main.sh', runtime: 'bash', entry: 'bash' },
    ];
    const picked = variants.find(v => existsSync(join(jobDir, v.file)));
    if (!picked) {
      console.error(clrError(`No main.py / main.js / main.sh found under jobs/${name}/`));
      process.exit(1);
    }

    // Confirm docker is reachable before bothering to build args.
    const probe = spawnSyncCommand('docker', ['info'], { stdio: 'ignore' });
    if (probe.status !== 0) {
      console.error(clrError('docker daemon not reachable. Start Docker Desktop / dockerd and retry.'));
      process.exit(1);
    }

    const sharedArgs = [
      '--rm',
      '--network', 'bridge',
      '--memory', '1g',
      '--cpus', '1',
      '--user', 'sandbox',
      '--workdir', '/work',
      '-v', `${jobDir}:/work`,
    ];

    // Run deps install + handler in ONE docker run. Two separate `docker run --rm`
    // calls would lose the pip --user / npm install state to the destroyed container.
    const needsDeps = opts.deps !== false && picked.depsFile && picked.installCmd && existsSync(join(jobDir, picked.depsFile));
    const handlerCmd = `${picked.entry} /work/${picked.file}`;
    let shellCmd: string;
    if (needsDeps && picked.installCmd) {
      const installShell = picked.installCmd.map(a => /\s/.test(a) ? `'${a}'` : a).join(' ');
      shellCmd = `echo '[run-local] installing deps from ${picked.depsFile}...' >&2 && ${installShell} && echo '[run-local] running ${handlerCmd} (${picked.runtime})' >&2 && exec ${handlerCmd}`;
    } else {
      shellCmd = `echo '[run-local] running ${handlerCmd} (${picked.runtime})' >&2 && exec ${handlerCmd}`;
    }

    const runArgs = ['run', ...sharedArgs, '--entrypoint', 'sh', opts.image, '-c', shellCmd];
    const child = spawnCommand('docker', runArgs, { stdio: 'inherit' });
    // A missing `docker` binary is reported asynchronously via 'error' (not a
    // throw), so a try/catch can't stop it - without this handler Node crashes
    // with a raw stack trace instead of a clear message.
    child.on('error', (err: NodeJS.ErrnoException) => {
      console.error(clrError(err.code === 'ENOENT'
        ? 'Docker not found. Install Docker to use `gipity job run-local`.'
        : `Failed to launch docker: ${err.message}`));
      process.exit(1);
    });
    child.on('exit', (code) => {
      if (code === 0) console.error(muted(`[run-local] ${success('done')}`));
      else console.error(muted(`[run-local] ${clrError('failed')} (exit ${code})`));
      process.exit(code ?? 1);
    });
  });
