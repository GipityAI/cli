import { Command, Option } from 'commander';
import { post } from '../api.js';
import { formatSize } from '../utils.js';
import { brand, bold, error as clrError, warning, muted, info, success } from '../colors.js';
import { run } from '../helpers/index.js';
import { getAuth } from '../auth.js';
import { capWaitMs } from './page-eval.js';
import { TOUCH_DEVICES as INSPECT_DEVICES, resolveTouchDevice } from './page-screenshot.js';

interface DebugBundle {
  url: string;
  title: string;
  navigationIncomplete?: boolean;
  note?: string;
  console: string[];
  failedResources: string[];
  timing: { ttfb: number; domReady: number; load: number };
  elementCount: number;
  totalBytes: number;
  largeResources: { url: string; size: number; type: string }[];
  renderBlocking: string[];
  oversizedImages: { src: string; natural: string; displayed: string }[];
  lcp: { time: number; element: string; url: string | null; size: number } | null;
  overflow: {
    scrollWidth: number;
    clientWidth: number;
    overflowX: boolean;
    amount: number;
    culprits: { tag: string; cls: string; left: number; right: number; width: number }[];
  } | null;
  transientConsole?: string[];
  crossOriginConsole?: string[];
  auth?: { requested: boolean; established: boolean; detail?: string };
}

/** A console line is an error-level entry (page error or console.error). */
const isErrorLine = (line: string): boolean => /^error:/i.test(line);

/** A message-less, cross-origin "Script error." The throwing <script> lacks
 *  CORS, so the browser strips its message/stack and the source is unknowable
 *  from the console alone — there is no own-code stack to chase. These can't be
 *  attributed to app code, so we surface them apart from real console errors
 *  rather than letting an unactionable (and sometimes growing) count read as a
 *  regression in the app the agent just wrote. */
const isMessagelessCrossOrigin = (line: string): boolean =>
  isErrorLine(line) && /message-less|cross-origin|Script error\.?/i.test(line);

function shortUrl(url: string, truncate = true, maxLen = 100): string {
  let result: string;
  try {
    const u = new URL(url);
    result = u.pathname + u.search;
  } catch {
    result = url;
  }
  if (!truncate || result.length <= maxLen) return result;
  const keep = maxLen - 1;
  const headLen = Math.ceil(keep / 2);
  const tailLen = Math.floor(keep / 2);
  return result.slice(0, headLen) + '…' + result.slice(-tailLen);
}

export const pageInspectCommand = new Command('inspect')
  .description('Inspect a web page (console, failed resources, timing, layout overflow). ONE passive load - to verify realtime/presence across concurrent clients use `page test --observe`')
  .argument('<url>', 'URL to inspect')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before capturing (lets late async/LCP work settle; max 30000)', '500')
  .option('--wait-for <selector>', 'Wait until this CSS selector appears before capturing (deterministic; replaces --wait)')
  .option('--wait-timeout <ms>', 'Max ms to wait for --wait-for before giving up', '5000')
  .option('--json', 'Output as JSON')
  .option('--no-reprobe', 'Skip the automatic second probe that filters one-time transient console errors - roughly halves inspect time on a page with any console error, at the cost of possibly reporting a cold-load transient as real')
  .option('--no-truncate', 'Show full URLs instead of truncating long ones with middle-ellipsis')
  .option('--all', 'Include render-blocking, large resources, oversized images, overflow culprits, and LCP detail')
  .option('--no-fake-media', "Inspect with NO camera or microphone present, so a getUserMedia app takes its no-device error path (use this only when that fallback IS what you're inspecting)")
  .option('--device <name>', `Inspect as a real touch device: ${INSPECT_DEVICES.join(', ')}. Emulates touch events, mobile user-agent and DPR, so a touch-gated mobile layout is what gets inspected.`)
  .option('--auth', 'Load the page signed in as you (your Gipity account), so pages behind a Sign-in-with-Gipity login are reachable. Only works for apps using Sign in with Gipity, hosted on *.gipity.ai.')
  // Hidden redirect: agents reach for `page inspect --screenshot`. We don't take
  // an image here (`page screenshot` is the single path for that) — just point there.
  .addOption(new Option('--screenshot [path]', 'Capture a screenshot').hideHelp())
  .action((url: string, opts) => {
    if (opts.screenshot !== undefined) {
      console.error(clrError('page inspect does not capture screenshots. Use page screenshot:'));
      console.error(`  gipity page screenshot ${url}${typeof opts.screenshot === 'string' ? ` -o ${opts.screenshot}` : ''}`);
      process.exit(1);
    }
    return run('Page inspect', () => inspectPage(url, opts));
  });

/** The commander opts shape of `page inspect` - every field optional so other
 *  commands (deploy --inspect) can invoke the same pipeline with defaults. */
export interface InspectPageOptions {
  wait?: string;
  waitFor?: string;
  waitTimeout?: string;
  json?: boolean;
  reprobe?: boolean;
  truncate?: boolean;
  all?: boolean;
  fakeMedia?: boolean;
  device?: string;
  auth?: boolean;
}

/** Run the full inspect pipeline (probe, transient-error re-probe, noise
 *  filtering) against a URL and print the report. Shared by `page inspect`
 *  and `deploy --inspect`, so a build agent can deploy + verify in ONE
 *  command instead of two round trips through the model. */
export async function inspectPage(url: string, opts: InspectPageOptions = {}): Promise<void> {
    const waitMs = capWaitMs(opts.wait ?? '500', url);
    const parsedTimeout = parseInt(opts.waitTimeout ?? '5000', 10);
    const waitForTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 5000;
    const truncate = opts.truncate !== false;
    const showAll = opts.all === true;

    // The headless browser has a synthetic camera + mic BY DEFAULT. A real user
    // inspecting a camera app has a camera; a browser without one makes every
    // getUserMedia app report a NotFoundError that is an artifact of the probe,
    // not a defect in the page — and worse, the app stops at its error path, so
    // the pipeline the agent actually wanted inspected never runs. A synthetic
    // device costs a page that never asks for media exactly nothing.
    const inspectBody = {
      url, waitMs,
      waitForSelector: opts.waitFor || undefined,
      waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : undefined,
      fakeMedia: opts.fakeMedia !== false ? true : undefined,
      device: opts.device ? resolveTouchDevice(opts.device) : undefined,
      auth: opts.auth || undefined,
    };

    const res = await post<{ data: DebugBundle }>(`/tools/browser/inspect`, inspectBody);

    const b = res.data;

    // ── Move resource-load failures out of the console, where they're noise ──
    // A sub-resource that returns an HTTP 4xx/5xx is reported twice: once in
    // `failedResources` (CDP network layer — carries the full URL, method, and
    // status) and once as a generic, URL-less console echo ("Failed to load
    // resource: the server responded with a status of 404 ()"). The echo names
    // nothing, so it can't be triaged on its own and only duplicates — worse —
    // what `failedResources` already says with a URL. Drop one echo per failed
    // resource we actually have, so every attributed failure (a real app 404 AND
    // the platform's own injected-SDK telemetry-beacon 404, which 404s on
    // essentially every deployed page) is surfaced exactly once, under Failed
    // resources, with its URL — never as a bare, unattributable console line.
    // Count BEFORE stripping the platform log endpoints below, so their echoes go
    // too. Any SURPLUS echo (a failure the network drain missed, leaving
    // failedResources short) is KEPT — a real problem is never hidden just because
    // we couldn't name it.
    const isPlatformLog = (entry: string): boolean => {
      const urlPart = entry.replace(/\s*\([^)]*\)\s*$/, '');
      try {
        const u = new URL(urlPart);
        return /(^|\.)gipity\.ai$/.test(u.hostname) && /\/log\/(traffic|error)$/.test(u.pathname);
      } catch {
        return false;
      }
    };
    let resourceEchoesToDrop = (b.failedResources || []).length;
    if (resourceEchoesToDrop > 0) {
      const isHttpStatusResourceError = (l: string): boolean =>
        /^error:\s*Failed to load resource: the server responded with a status of \d{3}/i.test(l);
      b.console = (b.console || []).filter((l) => {
        if (resourceEchoesToDrop > 0 && isHttpStatusResourceError(l)) {
          resourceEchoesToDrop--;
          return false;
        }
        return true;
      });
    }
    // The injected analytics SDK POSTs to `/log/{traffic,error}` on the Gipity
    // host; a failure there is platform infrastructure, not the app's, so strip it
    // from the failed-resource list entirely (its console echo is already gone,
    // dropped above with every other attributed failure).
    b.failedResources = (b.failedResources || []).filter((r) => !isPlatformLog(r));

    // Pull message-less cross-origin "Script error." lines out first. They carry
    // no source/stack, so they're never actionable as app-code defects, and on a
    // Gipity-deployed page the platform's own injected SDK is itself a
    // cross-origin script — so these are reported separately (not as app console
    // errors, and not folded into the re-probe count) instead of misleading the
    // agent into chasing its own code.
    const crossOriginErrors = (b.console || []).filter(isMessagelessCrossOrigin);
    b.console = (b.console || []).filter((l) => !isMessagelessCrossOrigin(l));

    // Self-verify the remaining console errors before flagging them. A
    // freshly-deployed page's first hit can throw a one-time, non-reproducible
    // error from an asset still propagating — and reporting it as a real defect
    // sends agents chasing a phantom. So when the first probe reports error-level
    // console lines, re-probe once (the sticky session is now warm) and keep only
    // the errors that recur; errors seen on a single probe are surfaced
    // separately as transient noise.
    let transientErrors: string[] = [];
    if (opts.reprobe !== false && (b.console || []).some(isErrorLine)) {
      try {
        const verify = await post<{ data: DebugBundle }>(`/tools/browser/inspect`, inspectBody);
        const recurring = new Set((verify.data.console || []).filter(isErrorLine));
        transientErrors = (b.console || []).filter((l) => isErrorLine(l) && !recurring.has(l));
        b.console = (b.console || []).filter((l) => !isErrorLine(l) || recurring.has(l));
      } catch {
        // Re-probe failed (timeout / browser error) — report the first probe's
        // console as-is rather than hiding anything.
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({
        ...b,
        ...(transientErrors.length ? { transientConsole: transientErrors } : {}),
        ...(crossOriginErrors.length ? { crossOriginConsole: crossOriginErrors } : {}),
      }));
      return;
    }

    const timing = b.timing || { ttfb: 0, domReady: 0, load: 0 };

    // ── Page Info ──
    console.log(`${brand('Inspecting')} ${bold(b.url || url)}`);
    if (b.navigationIncomplete) {
      console.log(`${warning('⚠ Navigation incomplete:')} ${b.note || 'page did not reach full load'}`);
    }
    // Auth state: without this line an agent can't distinguish "signed-in render"
    // from "--auth silently no-op'd and I'm looking at the anonymous page".
    if (b.auth?.requested) {
      const who = getAuth()?.email;
      console.log(b.auth.established
        ? `${muted('Auth:')} ${success('session established')}${who ? muted(` as ${who}`) : ''} ${muted('(what the page renders with it is app-defined)')}`
        : `${warning('Auth: session NOT established')}${b.auth.detail ? ` — ${b.auth.detail}` : ''} ${muted('(this is the anonymous view)')}`);
    }
    console.log(`${muted('Title:')} ${b.title || '(none)'}`);
    console.log(`${muted('Elements:')} ${b.elementCount || 0}`);
    console.log(`${muted('Page weight:')} ${info(formatSize(b.totalBytes || 0))}`);

    // ── Timing ──
    console.log(`\n${bold('Timing:')}`);
    console.log(`${muted('TTFB:')} ${timing.ttfb}ms`);
    console.log(`${muted('DOM ready:')} ${timing.domReady}ms`);
    console.log(`${muted('Load:')} ${timing.load}ms`);
    if (showAll && b.lcp) {
      console.log(`LCP: ${b.lcp.time}ms (${b.lcp.element}${b.lcp.url ? ' ' + shortUrl(b.lcp.url, truncate) : ''})`);
    }

    // ── Console ──
    if (b.console?.length > 0) {
      console.log(`\n${bold('Console')} ${muted(`(${b.console.length})`)}:`);
      for (const line of b.console) {
        console.log(`${warning(line)}`);
      }
    } else {
      console.log(`\n${bold('Console:')} ${muted('(clean)')}`);
    }

    // ── Transient console errors (seen on first probe, gone on re-probe) ──
    if (transientErrors.length > 0) {
      console.log(`\n${bold('Transient console errors')} ${muted(`(${transientErrors.length}, not reproduced on re-probe)`)}:`);
      for (const line of transientErrors) {
        console.log(muted(line));
      }
      console.log(muted('One-time cold-load artifact (first hit of freshly-deployed assets) — not reproducible, not in your app code. Ignore unless it recurs.'));
    }

    // ── Cross-origin console errors (message-less; source hidden by the browser) ──
    if (crossOriginErrors.length > 0) {
      console.log(`\n${bold('Cross-origin console errors')} ${muted(`(${crossOriginErrors.length}, source hidden by the browser)`)}:`);
      console.log(muted("Message-less — the throwing <script> lacks CORS, so the browser hides its source and there's no own-code stack to chase. Gipity's injected SDK is itself cross-origin, so if your app loads no third-party CDN scripts these are platform noise — ignore them. If your app DOES load a third-party <script>, add crossorigin=\"anonymous\" to that tag to surface the real error."));
    }

    // ── Failed Resources ──
    // Browsers auto-request /favicon.ico at the site root for every page, so a
    // 404 there isn't a resource the page actually links — it's noise on any
    // app served under a subpath. Split that implicit request out of the failure
    // list into a harmless note rather than flagging it as an error.
    const isImplicitFavicon = (entry: string): boolean => {
      const urlPart = entry.replace(/\s*\([^)]*\)\s*$/, '');
      try {
        return new URL(urlPart).pathname === '/favicon.ico';
      } catch {
        return false;
      }
    };
    const failed = (b.failedResources || []).filter((r) => !isImplicitFavicon(r));
    const rootFaviconMissing = (b.failedResources || []).some(isImplicitFavicon);
    if (failed.length > 0) {
      console.log(`\n${clrError(`Failed resources (${failed.length}):`)}`);
      for (const r of failed) {
        console.log(`${clrError(r)}`);
      }
    }
    if (rootFaviconMissing) {
      console.log(`\n${muted('No root /favicon.ico (browsers request this automatically; harmless for app pages served under a subpath)')}`);
    }

    // ── Layout (horizontal overflow) ──
    if (b.overflow) {
      if (b.overflow.overflowX) {
        console.log(`\n${clrError(`Horizontal overflow: +${b.overflow.amount}px`)} ${muted(`(content ${b.overflow.scrollWidth}px vs viewport ${b.overflow.clientWidth}px)`)}`);
        if (showAll && b.overflow.culprits.length > 0) {
          console.log(`${muted('Overflowing elements:')}`);
          for (const c of b.overflow.culprits) {
            const sel = c.cls ? `${c.tag}.${c.cls.split(/\s+/)[0]}` : c.tag;
            console.log(`${sel} ${muted(`(right ${c.right}px, width ${c.width}px)`)}`);
          }
        } else if (b.overflow.culprits.length > 0) {
          console.log(`${muted(`${b.overflow.culprits.length} overflowing element(s) - use --all to list`)}`);
        }
      } else {
        console.log(`\n${bold('Layout:')} ${muted('no horizontal overflow')}`);
      }
    }

    if (showAll) {
      // ── Render Blocking ──
      if (b.renderBlocking?.length > 0) {
        console.log(`\n${warning(`Render-blocking (${b.renderBlocking.length}):`)}`);
        for (const r of b.renderBlocking) {
          console.log(`${shortUrl(r, truncate)}`);
        }
      }

      // ── Large Resources ──
      if (b.largeResources?.length > 0) {
        console.log(`\n${warning(`Large resources >100KB (${b.largeResources.length}):`)}`);
        for (const r of b.largeResources) {
          console.log(`${info(formatSize(r.size).padEnd(10))} ${muted(r.type.padEnd(8))} ${shortUrl(r.url, truncate)}`);
        }
      }

      // ── Oversized Images ──
      if (b.oversizedImages?.length > 0) {
        console.log(`\n${warning(`Oversized images (${b.oversizedImages.length}):`)}`);
        for (const img of b.oversizedImages) {
          console.log(`${img.natural} served, ${img.displayed} displayed - ${shortUrl(img.src, truncate)}`);
        }
      }
    }
}
