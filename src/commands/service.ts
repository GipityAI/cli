import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';
import { bold, muted } from '../colors.js';
import { run } from '../helpers/index.js';

/** Known app-service endpoints, shown by `gipity service list` and used to
 *  give a helpful hint on typos. POST endpoints take a JSON body; GET
 *  endpoints (model/voice listings) are reached with `--get`. */
const SERVICES: Array<{ name: string; method: 'POST' | 'GET'; desc: string }> = [
  { name: 'llm', method: 'POST', desc: 'Chat completion ({ prompt | messages, model?, ... })' },
  { name: 'llm/models', method: 'GET', desc: 'List available LLM models' },
  { name: 'image', method: 'POST', desc: 'Generate an image ({ prompt, provider?, size? })' },
  { name: 'image/models', method: 'GET', desc: 'List image providers/models' },
  { name: 'tts', method: 'POST', desc: 'Text-to-speech ({ text, voice?, ... })' },
  { name: 'tts/voices', method: 'GET', desc: 'List TTS voices' },
  { name: 'sound', method: 'POST', desc: 'Sound effect ({ prompt, duration_seconds? })' },
  { name: 'music', method: 'POST', desc: 'Music generation ({ prompt, duration_seconds? })' },
  { name: 'video', method: 'POST', desc: 'Video generation ({ prompt, ... })' },
  { name: 'location/ip', method: 'POST', desc: 'IP geolocation ({ ip? })' },
  { name: 'location/geocode', method: 'POST', desc: 'Reverse geocode ({ lat, lon })' },
];

export const serviceCommand = new Command('service')
  .description('Call a Gipity app service (LLM, image, music, TTS, ...)');

serviceCommand
  .command('list')
  .description('List callable app services')
  .action(() => run('Services', async () => {
    requireConfig();
    const width = SERVICES.reduce((m, s) => Math.max(m, s.name.length), 0);
    console.log('');
    console.log('Call one with `gipity service call <name> \'{"json":"body"}\'`');
    console.log(muted('(GET endpoints like llm/models, tts/voices take --get and no body)'));
    console.log('');
    for (const s of SERVICES) {
      console.log(`  ${bold(s.name.padEnd(width))}  ${muted(`[${s.method}] ${s.desc}`)}`);
    }
    console.log('');
  }));

serviceCommand
  .command('call <name> [body]')
  .description('Call an app service by name (e.g. llm, image, music). Uses your logged-in session - no token wrangling.')
  .option('--data <json>', 'JSON request body (alternative to the positional [body])')
  .option('--get', 'Issue a GET (for listing endpoints like llm/models, tts/voices)')
  .option('--json', 'Output compact JSON')
  .action((name: string, bodyArg: string | undefined, opts) => run('Call', async () => {
    const config = requireConfig();
    // Encode each path segment but preserve the `/` separators so subpaths
    // like `location/geocode` and `llm/models` resolve correctly.
    const path = name.split('/').map(encodeURIComponent).join('/');
    const url = `/api/${config.projectGuid}/services/${path}`;

    const res = opts.get
      ? await get<unknown>(url)
      : await post<unknown>(url, JSON.parse(bodyArg || opts.data || '{}'));

    console.log(opts.json ? JSON.stringify(res) : JSON.stringify(res, null, 2));
  }));
