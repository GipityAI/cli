import { Command, Option } from 'commander';
import { post } from '../api.js';
import { formatSize } from '../utils.js';
import { brand, bold, error as clrError, warning, muted, info } from '../colors.js';
import { run } from '../helpers/index.js';
import { capWaitMs } from './page-eval.js';

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
  .description('Inspect a web page (console, failed resources, timing, layout overflow)')
  .argument('<url>', 'URL to inspect')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before capturing (lets late async/LCP work settle; max 30000)', '500')
  .option('--wait-for <selector>', 'Wait until this CSS selector appears before capturing (deterministic; replaces --wait)')
  .option('--wait-timeout <ms>', 'Max ms to wait for --wait-for before giving up', '5000')
  .option('--json', 'Output as JSON')
  .option('--no-truncate', 'Show full URLs instead of truncating long ones with middle-ellipsis')
  .option('--all', 'Include render-blocking, large resources, oversized images, overflow culprits, and LCP detail')
  .option('--fake-media', 'Grant a synthetic microphone + camera and auto-accept the getUserMedia prompt, so voice/camera apps run headlessly (audio is a built-in tone, not real speech)')
  // Hidden redirect: agents reach for `page inspect --screenshot`. We don't take
  // an image here (`page screenshot` is the single path for that) — just point there.
  .addOption(new Option('--screenshot [path]', 'Capture a screenshot').hideHelp())
  .action((url: string, opts) => {
    if (opts.screenshot !== undefined) {
      console.error(clrError('page inspect does not capture screenshots. Use page screenshot:'));
      console.error(`  gipity page screenshot ${url}${typeof opts.screenshot === 'string' ? ` -o ${opts.screenshot}` : ''}`);
      process.exit(1);
    }
    return run('Page inspect', async () => {
    const waitMs = capWaitMs(opts.wait, url);
    const parsedTimeout = parseInt(opts.waitTimeout, 10);
    const waitForTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 5000;
    const truncate = opts.truncate !== false;
    const showAll = opts.all === true;

    const inspectBody = {
      url, waitMs,
      waitForSelector: opts.waitFor || undefined,
      waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : undefined,
      fakeMedia: opts.fakeMedia || undefined,
    };

    const res = await post<{ data: DebugBundle }>(`/tools/browser/inspect`, inspectBody);

    const b = res.data;

    // ── Strip the platform's own instrumentation noise first ──
    // Every deployed page loads Gipity's injected analytics SDK, which POSTs to
    // Gipity's traffic/error log endpoints (`/api/<guid>/log/traffic|error`).
    // Those are platform infrastructure, not the app's resources, so when one
    // fails it surfaces as a failed resource on the Gipity host PLUS a generic,
    // URL-less "Failed to load resource" console error — identical noise on
    // essentially every deployed app. Drop both so an agent inspecting the app
    // it just built sees only its own code's resources, not the platform's.
    const isPlatformLog = (entry: string): boolean => {
      const urlPart = entry.replace(/\s*\([^)]*\)\s*$/, '');
      try {
        const u = new URL(urlPart);
        return /(^|\.)gipity\.ai$/.test(u.hostname) && /\/log\/(traffic|error)$/.test(u.pathname);
      } catch {
        return false;
      }
    };
    const platformFailures = (b.failedResources || []).filter(isPlatformLog);
    b.failedResources = (b.failedResources || []).filter((r) => !isPlatformLog(r));
    // Each failed platform POST also emits exactly one generic, URL-less
    // "Failed to load resource" console error. Drop one per platform failure —
    // the text is identical, so removing by count is exact and any genuine app
    // 404 keeps its own (indistinguishable) line.
    let platformConsoleToDrop = platformFailures.length;
    if (platformConsoleToDrop > 0) {
      b.console = (b.console || []).filter((l) => {
        if (platformConsoleToDrop > 0 && /^error:\s*Failed to load resource:/i.test(l)) {
          platformConsoleToDrop--;
          return false;
        }
        return true;
      });
    }

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
    if ((b.console || []).some(isErrorLine)) {
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
    });
  });
