import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { Command, Option } from 'commander';
import { get, post, del, getBaseUrl } from '../api.js';
import { requireConfig, getConfigPath } from '../config.js';
import { error as clrError, success, muted, bold } from '../colors.js';
import { run, printList } from '../helpers/index.js';

/**
 * True when this project is a Gipity-deployed app - i.e. it has a gipity.yaml
 * deploy manifest next to its .gipity.json. Projects that use Gipity purely as
 * realtime infrastructure (the app itself is hosted elsewhere) have no
 * manifest; for them imperative room creation is the right and only path.
 */
function hasDeployManifest(): boolean {
  const cfgPath = getConfigPath();
  if (!cfgPath) return false;
  return existsSync(resolve(dirname(cfgPath), 'gipity.yaml'));
}

interface RealtimeRoom {
  name: string;
  room_type: string;
  auth_level: string;
  max_clients: number;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface RoomInfo {
  room: RealtimeRoom;
  live: { instances: number; clients: number } | null;
}

const roomCommand = new Command('room')
  .description('Manage realtime rooms')
  .argument('[action]', 'list | create | delete | info', 'list')
  .argument('[name]', 'room name (for create | delete | info)')
  .addOption(new Option('--type <type>', 'Room type for create').choices(['state', 'relay']).default('state'))
  .addOption(new Option('--auth <level>', 'Auth level for create').choices(['public', 'user']).default('public'))
  .option('--max-clients <n>', 'max clients for create (1-200)')
  .option('--seat-hold <seconds>', 'create: how long a dropped client keeps its seat (0-300, default 30)')
  .option('--host-hold <seconds>', 'create: how long the host role waits for a dropped or reloading host (0-600, default 60)')
  .option('--json', 'Output as JSON')
  .action((action: string, name: string | undefined, opts) => run('Realtime room', async () => {
    const config = requireConfig();
    const base = `/projects/${config.projectGuid}/realtime-rooms`;
    const sub = (action || 'list').toLowerCase();

    switch (sub) {
      case 'list': {
        const res = await get<{ data: RealtimeRoom[] }>(base);
        printList(res.data, opts, 'No realtime rooms. Create one: gipity realtime room create <name>', r =>
          `${bold(r.name)}  ${muted(`${r.room_type} · ${r.auth_level} · max ${r.max_clients}`)}`
        );
        break;
      }

      case 'create': {
        if (!name) {
          console.error(clrError('Usage: gipity realtime room create <name> [--type state|relay] [--auth public|user] [--max-clients N]'));
          process.exit(1);
        }
        const body: Record<string, unknown> = { name, room_type: opts.type, auth_level: opts.auth };
        if (opts.maxClients !== undefined) body.max_clients = Number(opts.maxClients);
        if (opts.seatHold !== undefined) body.seat_hold_seconds = Number(opts.seatHold);
        if (opts.hostHold !== undefined) body.host_hold_seconds = Number(opts.hostHold);
        const res = await post<{ data: RealtimeRoom }>(base, body);
        if (opts.json) {
          console.log(JSON.stringify(res.data));
        } else {
          const r = res.data;
          console.log(success(`Created room '${r.name}' (${r.room_type}, ${r.auth_level}, max ${r.max_clients}).`));
          // Only nudge toward the declarative path for Gipity-deployed apps -
          // an imperative room isn't tracked in gipity.yaml, so it won't be
          // recreated on redeploy or for teammates. Infra-only projects have
          // no manifest and are using this command exactly as intended.
          if (hasDeployManifest()) {
            console.log('');
            console.log(muted('This project has a gipity.yaml - if this room backs the app,'));
            console.log(muted('declare it there (run `gipity add realtime`) so it is recreated'));
            console.log(muted('on every deploy and for teammates, instead of imperatively.'));
          }
        }
        break;
      }

      case 'delete':
      case 'remove': {
        if (!name) {
          console.error(clrError('Usage: gipity realtime room delete <name>'));
          process.exit(1);
        }
        await del(`${base}/${encodeURIComponent(name)}`);
        if (opts.json) {
          console.log(JSON.stringify({ success: true }));
        } else {
          console.log(success(`Deleted room '${name}'.`) + ' Active instances drain as clients disconnect.');
        }
        break;
      }

      case 'info': {
        if (!name) {
          console.error(clrError('Usage: gipity realtime room info <name>'));
          process.exit(1);
        }
        const res = await get<{ data: RoomInfo }>(`${base}/${encodeURIComponent(name)}`);
        if (opts.json) {
          console.log(JSON.stringify(res.data));
        } else {
          const { room, live } = res.data;
          console.log(`${bold(room.name)}`);
          console.log(`Type:        ${room.room_type}`);
          console.log(`Auth:        ${room.auth_level}`);
          console.log(`Max clients: ${room.max_clients}`);
          console.log(`Seat hold:   ${room.config?.seat_hold_seconds ?? 30}s (host ${room.config?.host_hold_seconds ?? 60}s)`);
          console.log(`Live:        ${live ? `${live.instances} instance(s), ${live.clients} client(s)` : muted('Gipity Realtime unreachable')}`);
        }
        break;
      }

      default:
        console.error(clrError(`Unknown action: ${sub}`));
        console.log('Usage: gipity realtime room [list|create|delete|info] [name]');
        process.exit(1);
    }
  }));

interface BenchReportShape {
  room: string; scope: string; controllers: number; sent: number; simulatedDrops: number;
  delivered: number; lost: number; outOfOrder: number;
  inputAgeMs: { p50: number; p95: number; p99: number; max: number } | null;
  serverToHostMs: { p50: number; p95: number; p99: number; max: number } | null;
  rttMs: { p50: number; p95: number; p99: number; max: number } | null;
}

const benchCommand = new Command('bench')
  .description('Measure controller-to-host latency in a live room: 1 host + N simulated controllers')
  .argument('<room>', 'a provisioned room of this project (joins a fresh scope, so real players are never disturbed)')
  .option('--clients <n>', 'simulated controllers', '8')
  .option('--rate <n>', 'inputs per second per controller', '20')
  .option('--duration <seconds>', 'how long to send', '10')
  .option('--latency <ms>', 'added one-way delay per input', '0')
  .option('--jitter <ms>', 'random +/- extra delay per input', '0')
  .option('--drop <fraction>', 'share of inputs never sent (0-1), to simulate loss', '0')
  .option('--ws-url <url>', 'realtime endpoint', 'wss://rt.gipity.ai')
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
Each controller syncs its clock with the server, then sends small inputs to the
host (the screen). The host measures each input's age on arrival: controller ->
Gipity Realtime -> host, end to end. Needs Node 22+ (built-in WebSocket).

Example: gipity realtime bench couch --clients 8 --rate 20 --latency 30 --jitter 15`)
  .action((roomName: string, opts) => run('Realtime bench', async () => {
    const config = requireConfig();
    if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
      console.error(clrError('gipity realtime bench needs Node 22 or newer (built-in WebSocket).'));
      process.exit(1);
    }
    const info = await get<{ data: RoomInfo }>(`/projects/${config.projectGuid}/realtime-rooms/${encodeURIComponent(roomName)}`);
    const num = (v: string, name: string, min: number, max: number) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        console.error(clrError(`--${name} must be between ${min} and ${max}`));
        process.exit(1);
      }
      return n;
    };
    // Kept out of the main bundle: a variable specifier stops esbuild inlining it.
    const benchModule = './realtime-bench.js';
    const { runBench } = await import(benchModule) as { runBench: (o: Record<string, unknown>) => Promise<BenchReportShape> };
    const report = await runBench({
      apiBase: getBaseUrl(),
      wsUrl: opts.wsUrl,
      appGuid: config.projectGuid,
      room: roomName,
      roomType: info.data.room.room_type === 'relay' ? 'relay' : 'state',
      clients: num(opts.clients, 'clients', 1, 199),
      rate: num(opts.rate, 'rate', 1, 100),
      durationMs: num(opts.duration, 'duration', 1, 120) * 1000,
      latencyMs: num(opts.latency, 'latency', 0, 5000),
      jitterMs: num(opts.jitter, 'jitter', 0, 5000),
      dropRate: num(opts.drop, 'drop', 0, 1),
      onProgress: opts.json ? undefined : (line: string) => console.log(muted(line)),
    });
    if (opts.json) { console.log(JSON.stringify(report)); return; }
    const fmt = (p: BenchReportShape['inputAgeMs']) => p ? `p50 ${p.p50}  p95 ${p.p95}  p99 ${p.p99}  max ${p.max} ms` : 'no samples';
    console.log('');
    console.log(bold(`${report.room}: ${report.controllers} controllers`));
    console.log(`Input age (controller -> host): ${fmt(report.inputAgeMs)}`);
    console.log(`Server -> host leg:             ${fmt(report.serverToHostMs)}`);
    console.log(`Round trip to the server:       ${fmt(report.rttMs)}`);
    console.log(`Delivered ${report.delivered}/${report.sent} sent`
      + (report.simulatedDrops ? `, ${report.simulatedDrops} dropped by --drop` : '')
      + `, lost ${report.lost}, out of order ${report.outOfOrder}`);
    if (report.lost || report.outOfOrder) process.exitCode = 1;
  }));

export const realtimeCommand = new Command('realtime')
  .description('Manage realtime (multiplayer) rooms and measure their latency')
  .addCommand(roomCommand)
  .addCommand(benchCommand);
