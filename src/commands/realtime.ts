import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { Command, Option } from 'commander';
import { get, post, del } from '../api.js';
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
          console.log(`Live:        ${live ? `${live.instances} instance(s), ${live.clients} client(s)` : muted('Colyseus server unreachable')}`);
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
