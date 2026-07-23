import { Command } from 'commander';
import { get, post, publicRequest, mintAppToken, ApiError } from '../api.js';
import { getAuth } from '../auth.js';
import { requireConfig } from '../config.js';
import { bold, muted } from '../colors.js';
import { run, emitField, resolveBody } from '../helpers/index.js';

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
  { name: 'sound', method: 'POST', desc: 'Sound effect ({ text, duration_seconds? })' },
  { name: 'music', method: 'POST', desc: 'Music generation ({ prompt, duration_seconds? })' },
  { name: 'video', method: 'POST', desc: 'Video generation ({ prompt, ... })' },
  { name: 'location/ip', method: 'POST', desc: 'IP geolocation ({ ip? })' },
  { name: 'location/geocode', method: 'POST', desc: 'Reverse geocode ({ lat, lon })' },
];

export const serviceCommand = new Command('service')
  .description('Call an app service (llm, tts, image, transcribe, ...)')
  .addHelpText('after', '\nCall a Gipity app service: LLM, image, music, TTS, and more.\nPer-service docs: gipity skill read app-llm | app-tts | app-image | app-video | app-audio (transcribe, sound, music) | app-location');

serviceCommand
  .command('list')
  .description('List callable app services')
  .option('--json', 'Output the service list as JSON')
  .action((opts) => run('Services', async () => {
    requireConfig();
    if (opts.json) {
      console.log(JSON.stringify(SERVICES));
      return;
    }
    const width = SERVICES.reduce((m, s) => Math.max(m, s.name.length), 0);
    console.log('Call one with `gipity service call <name> \'{"json":"body"}\'`');
    console.log(muted('(GET endpoints like llm/models, tts/voices take --get and no body)'));
    console.log(muted('Verifying what a signed-out visitor of your deployed app gets? Add --anon.'));
    console.log('');
    for (const s of SERVICES) {
      console.log(`${bold(s.name.padEnd(width))}  ${muted(`[${s.method}] ${s.desc}`)}`);
    }
  }));

/** A signed-out visitor's 401 on a service is almost never "the caller needs to
 *  log in" — it is the app's service `billing_mode` still on the `user_pays`
 *  default, which asks every anonymous visitor of a PUBLIC page to sign in and
 *  pay from their own credits. The server's raw body says LOGIN_REQUIRED and
 *  nothing about the manifest, so the fix costs a doc hunt across skills. Name
 *  the cause and the exact edit here, at the moment it happens. */
export function anonBillingHint(name: string, err: unknown): string | null {
  if (!(err instanceof ApiError) || err.statusCode !== 401) return null;
  // Only the "sign in to use this" refusal is a billing-mode symptom. A missing
  // credential (the visitor token never minted) is a different failure with a
  // different fix, and must not be dressed up as one.
  if (err.code !== 'LOGIN_REQUIRED') return null;
  const service = name.split('/')[0];
  return (
    `An anonymous visitor cannot call '${service}': it is on the user_pays default, so every signed-out ` +
    `visitor to a public page is asked to sign in and pay from their own credits. If this app serves the ` +
    `public (a help bubble, a landing page), switch it to owner-pays in gipity.yaml and redeploy:\n` +
    `  deploy:\n    phases:\n      - services\n  service_definitions:\n    - service: ${service}\n      billing_mode: owner_pays\n` +
    `  gipity deploy dev --only services`
  );
}

serviceCommand
  .command('call <name> [body]')
  .description('Call an app service by name (e.g. llm, image, music). Uses your logged-in session - no token wrangling; --anon calls it as a signed-out visitor instead.')
  .option('-d, --data <json>', 'JSON request body: inline JSON, @file to read a file, or @- / - for stdin (alternative to the positional [body])')
  .option('--file <field=@path>', 'Attach a file as { data, media_type } under <field> (the vision/media shape these services expect), repeatable, e.g. --file image=@receipt.png', (v: string, acc: string[]) => (acc || []).concat(v))
  .option('--anon', 'Call as an anonymous visitor (the public path a signed-out user of your deployed app hits) instead of as your signed-in account')
  .option('--get', 'Issue a GET (for listing endpoints like llm/models, tts/voices)')
  .option('--field <path>', 'Print only this field of the result (dot path, e.g. choices.0.message.content)')
  .option('--json', 'Output compact JSON')
  .action((name: string, bodyArg: string | undefined, opts) => run('Call', async () => {
    const config = requireConfig();
    // Encode each path segment but preserve the `/` separators so subpaths
    // like `location/geocode` and `llm/models` resolve correctly.
    const path = name.split('/').map(encodeURIComponent).join('/');
    const url = `/api/${config.projectGuid}/services/${path}`;
    const body = resolveBody(bodyArg || opts.data, opts.file);

    // Name the calling identity (stderr, so stdout stays parseable). An owner
    // call always succeeds regardless of billing mode, so without this line a
    // "the service works" verification silently proves nothing about the
    // visitors the deployed app actually serves.
    if (opts.anon) {
      console.error(muted('Auth: anonymous visitor (the public path a signed-out user of your deployed app hits)'));
    } else {
      const who = getAuth()?.email;
      console.error(muted(`Auth: calling as ${who ?? 'your signed-in account'} (the owner persona - always billed to you and never blocked by billing_mode; use --anon for the public visitor path)`));
    }

    let res: unknown;
    try {
      if (opts.anon) {
        // The short-lived app token IS the visitor's credential here (unlike a
        // public function, a service is never callable with no token at all).
        // If it can't be minted, say so — otherwise the request comes back as a
        // bare 401 that reads like an app-permissions problem.
        const headers = await mintAppToken(config.projectGuid);
        if (!headers) {
          throw new Error(
            `Could not mint a visitor token for this project, so there is no anonymous path to call. ` +
            `That means the app is not deployed on this API base yet: run \`gipity deploy dev\` first, ` +
            `then re-run this command.`,
          );
        }
        res = await publicRequest<unknown>(opts.get ? 'GET' : 'POST', url, opts.get ? undefined : body, headers);
      } else {
        res = opts.get ? await get<unknown>(url) : await post<unknown>(url, body);
      }
    } catch (err) {
      const hint = opts.anon ? anonBillingHint(name, err) : null;
      if (!hint) throw err;
      throw new Error(`${(err as Error).message}\n${hint}`);
    }

    if (opts.field) { emitField(res, opts.field); return; }
    console.log(opts.json ? JSON.stringify(res) : JSON.stringify(res, null, 2));
  }));
