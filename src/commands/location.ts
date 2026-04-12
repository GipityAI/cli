import { Command } from 'commander';
import { get, post } from '../api.js';
import { error as clrError } from '../colors.js';
import { run, printList } from '../helpers/index.js';

interface LocationData {
  source: 'ip' | 'coords' | 'latest' | 'history';
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
  lat: number | null;
  lon: number | null;
  ip: string | null;
  accuracy: number | null;
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function looksLikeIp(s: string): boolean {
  return IPV4_RE.test(s) || (IPV6_RE.test(s) && s.includes(':'));
}

function formatLocation(r: LocationData): string {
  const lines: string[] = [];
  const place = [r.city, r.region, r.country].filter(Boolean).join(', ');
  if (place) lines.push(`  ${place}`);
  if (r.lat != null && r.lon != null) lines.push(`  Coordinates: ${r.lat}, ${r.lon}`);
  if (r.ip) lines.push(`  IP:          ${r.ip}`);
  if (r.timezone) lines.push(`  Timezone:    ${r.timezone}`);
  if (r.accuracy != null) lines.push(`  Accuracy:    ${Math.round(r.accuracy)}m`);
  lines.push(`  Source:      ${r.source}`);
  return lines.join('\n');
}

/**
 * gipity location                       → IP geo for this machine
 * gipity location <ip>                  → IP lookup
 * gipity location <lat> <lng>           → reverse geocode
 * gipity location latest                → most recent stored
 * gipity location history [--count N]   → stored history
 */
export const locationCommand = new Command('location')
  .description('Show geographic location: your IP geo, look up an IP, reverse-geocode coords, or view stored history')
  .argument('[args...]', 'Zero args for me; one IP for IP lookup; two numbers for reverse geocode; "latest" or "history"')
  .option('--count <n>', 'History row count (with "history")', (v) => parseInt(v, 10))
  .option('--json', 'Output as JSON')
  .action((args: string[], opts) => run('Location', async () => {
    let res: { data: LocationData | LocationData[] | null };
    let isList = false;

    if (args.length === 0) {
      res = await get<typeof res>('/location/me');
    } else if (args[0].toLowerCase() === 'latest' && args.length === 1) {
      res = await get<typeof res>('/location/latest');
    } else if (args[0].toLowerCase() === 'history') {
      const count = opts.count || (args[1] ? Number(args[1]) : undefined);
      const qs = count ? `?count=${count}` : '';
      res = await get<typeof res>(`/location/history${qs}`);
      isList = true;
    } else if (args.length === 1 && looksLikeIp(args[0])) {
      res = await post<typeof res>('/location/ip', { ip: args[0] });
    } else if (args.length === 2 && NUMBER_RE.test(args[0]) && NUMBER_RE.test(args[1])) {
      res = await post<typeof res>('/location/coords', { lat: Number(args[0]), lng: Number(args[1]) });
    } else {
      console.error(clrError('Usage: gipity location [<ip> | <lat> <lng> | latest | history [--count N]]'));
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(res.data));
      return;
    }

    if (isList) {
      const rows = (res.data as LocationData[]) || [];
      printList(rows, opts, 'No location history.', r => formatLocation(r) + '\n');
      return;
    }

    if (!res.data) {
      console.log('  No location data.');
      return;
    }
    console.log(formatLocation(res.data as LocationData));
  }));
