/**
 * `gipity realtime bench`: a controller-latency benchmark against a live room.
 *
 * One host (the "screen") plus N controllers join a fresh scope of the room.
 * Each controller syncs its clock with the server (__ping/__pong), then sends
 * small inputs to the host at a fixed rate, optionally with added latency,
 * jitter and drops to simulate a worse network. The host measures each
 * input's age on arrival in server time (its receive time minus the
 * controller's stamped send time), so the numbers are end-to-end:
 * controller -> Gipity Realtime -> host.
 *
 * Bundled separately (dist/realtime-bench.js) with the Colyseus client, and
 * loaded only by this command, so ordinary `gipity` invocations stay fast.
 */
import { Client, type Room } from 'colyseus.js';

export interface BenchOptions {
  apiBase: string;
  wsUrl: string;
  appGuid: string;
  room: string;
  roomType: 'state' | 'relay';
  clients: number;
  rate: number;           // inputs per second per controller
  durationMs: number;
  latencyMs: number;      // added one-way delay before each send
  jitterMs: number;       // +/- random extra delay
  dropRate: number;       // 0..1 share of inputs never sent
  onProgress?: (line: string) => void;
}

export interface Percentiles { p50: number; p95: number; p99: number; max: number; }

export interface BenchReport {
  room: string;
  scope: string;
  controllers: number;
  sent: number;
  simulatedDrops: number;
  delivered: number;
  lost: number;
  outOfOrder: number;
  inputAgeMs: Percentiles | null;
  serverToHostMs: Percentiles | null;
  rttMs: Percentiles | null;
}

const INPUT = 'bench:input';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const r = (n: number) => Math.round(n * 10) / 10;
  return { p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(s[s.length - 1]) };
}

/** Clock offset (server minus local) from the lowest-RTT of a few pings. */
async function syncClock(room: Room, samples = 6): Promise<{ offset: number; rtts: number[] }> {
  const rtts: number[] = [];
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const t = Date.now();
    const pong = await new Promise<{ t: number; serverTs: number } | null>((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, 2000);
      const off = room.onMessage('__pong', (d: { t: number; serverTs: number }) => {
        if (d?.t !== t) return;
        clearTimeout(timer); off(); resolve(d);
      });
      room.send('__ping', { t });
    });
    if (!pong) continue;
    const rtt = Date.now() - t;
    rtts.push(rtt);
    const offset = pong.serverTs - (t + rtt / 2);
    if (!best || rtt < best.rtt) best = { rtt, offset };
    await sleep(50);
  }
  if (!best) throw new Error('no __pong from the realtime server (is it running the current version?)');
  return { offset: best.offset, rtts };
}

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const say = o.onProgress ?? (() => {});
  const res = await fetch(`${o.apiBase.replace(/\/+$/, '')}/api/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: o.appGuid }),
  });
  if (!res.ok) throw new Error(`app token request failed (HTTP ${res.status})`);
  const token = ((await res.json()) as { data: { token: string } }).data.token;

  const scope = `bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const opts = { app: o.appGuid, room: o.room, token, scope };
  const rooms: Room[] = [];
  const join = async (extra: Record<string, unknown>) => {
    const room = await new Client(o.wsUrl).joinOrCreate(o.roomType, { ...opts, ...extra });
    room.onMessage('*', () => { /* roster, host and relay traffic: not measured */ });
    rooms.push(room);
    return room;
  };

  try {
    say(`joining ${o.room} (${o.roomType}) as 1 host + ${o.clients} controllers, scope ${scope}`);
    const host = await join({ host: true, clientId: 'bench-host', displayName: 'bench host' });
    const controllers: Room[] = [];
    for (let i = 0; i < o.clients; i++) {
      controllers.push(await join({ clientId: `bench-c${i}`, displayName: `controller ${i + 1}` }));
    }

    say('syncing clocks');
    const hostClock = await syncClock(host);
    const clocks = await Promise.all(controllers.map((c) => syncClock(c)));
    const allRtts = [...hostClock.rtts, ...clocks.flatMap((c) => c.rtts)];

    const ages: number[] = [];
    const serverToHost: number[] = [];
    const lastSeq = new Map<string, number>();
    let delivered = 0;
    let outOfOrder = 0;
    host.onMessage(INPUT, (d: { senderId: string; seq: number; sentAt: number; serverTs: number }) => {
      const nowServer = Date.now() + hostClock.offset;
      delivered++;
      ages.push(nowServer - d.sentAt);
      serverToHost.push(nowServer - d.serverTs);
      const prev = lastSeq.get(d.senderId) ?? -1;
      if (d.seq < prev) outOfOrder++;
      lastSeq.set(d.senderId, Math.max(prev, d.seq));
    });

    let sent = 0;
    let simulatedDrops = 0;
    const pending: Promise<void>[] = [];
    const interval = 1000 / o.rate;
    const deadline = Date.now() + o.durationMs;
    say(`sending ${o.rate}/s from each controller for ${Math.round(o.durationMs / 1000)}s`
      + (o.latencyMs || o.jitterMs || o.dropRate ? ` (+${o.latencyMs}ms ±${o.jitterMs}ms, ${Math.round(o.dropRate * 100)}% drops)` : ''));
    await Promise.all(controllers.map(async (c, idx) => {
      let seq = 0;
      // Added delay is applied in order per controller, the way a slow TCP
      // link behaves (it can delay but never reorder), so any out-of-order
      // arrival the host sees is the server's doing.
      let chain = Promise.resolve();
      await sleep((interval / o.clients) * idx);   // spread controllers across the interval
      while (Date.now() < deadline) {
        const mySeq = seq++;
        if (Math.random() < o.dropRate) {
          simulatedDrops++;
        } else {
          const readyAt = Date.now() + Math.max(0, o.latencyMs + (Math.random() * 2 - 1) * o.jitterMs);
          const sentAt = Date.now() + clocks[idx].offset;
          sent++;
          chain = chain
            .then(() => sleep(Math.max(0, readyAt - Date.now())))
            .then(() => c.send(INPUT, { __to: 'host', seq: mySeq, sentAt }));
        }
        await sleep(interval);
      }
      pending.push(chain);
    }));
    await Promise.all(pending);
    await sleep(1000);   // let the tail arrive

    return {
      room: o.room,
      scope,
      controllers: o.clients,
      sent,
      simulatedDrops,
      delivered,
      lost: Math.max(0, sent - delivered),
      outOfOrder,
      inputAgeMs: percentiles(ages),
      serverToHostMs: percentiles(serverToHost),
      rttMs: percentiles(allRtts),
    };
  } finally {
    await Promise.allSettled(rooms.map((r) => r.leave(true)));
  }
}
