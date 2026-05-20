import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { requireConfig } from '../config.js';
import { error as clrError, success, muted, bold } from '../colors.js';
import { run, printList } from '../helpers/index.js';

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
  .option('--type <type>', 'room type for create: state | relay', 'state')
  .option('--auth <level>', 'auth level for create: public | user', 'public')
  .option('--max-clients <n>', 'max clients for create (1-200)')
  .option('--json', 'Output as JSON')
  .action((action: string, name: string | undefined, opts) => run('Realtime room', async () => {
    const config = requireConfig();
    const base = `/projects/${config.projectGuid}/realtime-rooms`;
    const sub = (action || 'list').toLowerCase();

    switch (sub) {
      case 'list': {
        const res = await get<{ data: RealtimeRoom[] }>(base);
        printList(res.data, opts, 'No realtime rooms. Create one: gipity realtime room create <name>', r =>
          `  ${bold(r.name)}  ${muted(`${r.room_type} · ${r.auth_level} · max ${r.max_clients}`)}`
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
        const res = await post<{ data: RealtimeRoom }>(base, body);
        if (opts.json) {
          console.log(JSON.stringify(res.data));
        } else {
          const r = res.data;
          console.log(success(`Created room '${r.name}' (${r.room_type}, ${r.auth_level}, max ${r.max_clients}).`));
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
          console.log(`Deleted room '${name}'. Active instances drain as clients disconnect.`);
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
          console.log('');
          console.log(`  ${bold(room.name)}`);
          console.log(`  Type:        ${room.room_type}`);
          console.log(`  Auth:        ${room.auth_level}`);
          console.log(`  Max clients: ${room.max_clients}`);
          console.log(`  Live:        ${live ? `${live.instances} instance(s), ${live.clients} client(s)` : muted('Colyseus server unreachable')}`);
          console.log('');
        }
        break;
      }

      default:
        console.error(clrError(`Unknown action: ${sub}`));
        console.log('Usage: gipity realtime room [list|create|delete|info] [name]');
        process.exit(1);
    }
  }));

export const realtimeCommand = new Command('realtime')
  .description('Manage realtime (multiplayer) rooms')
  .addCommand(roomCommand);
