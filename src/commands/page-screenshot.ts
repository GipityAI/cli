import { Command, Option } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import { postForTarEntries } from '../api.js';
import { getConfig, getProjectRoot } from '../config.js';
import { getAuth } from '../auth.js';
import { brand, bold, muted, success, warning } from '../colors.js';
import { formatSize } from '../utils.js';
import { run } from '../helpers/index.js';
import { withSpinner } from '../progress.js';
import { uploadCameraFeed, assertCameraFile, deleteFixture, HostedFixture } from '../page-fixtures.js';

type Viewport = { width: number; height: number; deviceScaleFactor?: number; device?: string };

/** `mobile` and `tablet` name a real handset/tablet rather than just a window size.
 *  The server emulates it end to end - mobile user-agent, DPR, and crucially TOUCH,
 *  so a page that gates its mobile UI on `'ontouchstart' in window` or
 *  `navigator.maxTouchPoints` renders that UI instead of its desktop layout. The
 *  dimensions here mirror the device's own metrics (reported in meta.json).
 *  `device` values must be ones the server's BROWSER_DEVICES accepts. */
const DEVICE_PRESETS: Record<string, Viewport> = {
  default: { width: 1280, height: 720 },
  desktop: { width: 1920, height: 1080 },
  laptop:  { width: 1366, height: 768 },
  tablet:  { width: 820,  height: 1180, deviceScaleFactor: 2, device: 'iPad' },
  mobile:  { width: 393,  height: 852,  deviceScaleFactor: 3, device: 'iPhone 15' },
};

const TOUCH_DEVICE_ALIASES: Record<string, string> = { mobile: 'iPhone 15', tablet: 'iPad' };

type PagePerformance = { ttfb: number; domReady: number; load: number; lcp: number | null };

type ScreenshotMeta = {
  requestedUrl: string;
  finalUrl: string | null;
  title: string | null;
  status: number | null;
  full: boolean;
  reloadBetween: boolean;
  performance: PagePerformance | null;
  // Set only when --action ran and its script threw or failed to parse. The
  // capture still succeeded, but it shows the page BEFORE the action.
  actionError?: string;
  // Auth handoff state when --auth ran (same shape page inspect reports).
  auth?: { requested: boolean; established: boolean; detail?: string };
  screenshots: Array<{
    index: number;
    viewport: Viewport & { deviceScaleFactor: number; touch: boolean };
    width: number;
    height: number;
    screenshotSizeBytes: number;
    phase: 'initial-load' | 'reload' | 'no-reload';
    // VFS persistence result when `save` was sent: the stored reference, or
    // {error} when that one save failed (the capture itself still succeeded).
    vfs?: { guid: string; url: string; thumb_url: string | null; path: string } | { error: string };
  }>;
};

const LABEL_WIDTH = 18; // "Screenshot dims:" + trailing space

function label(text: string): string {
  return muted((text + ':').padEnd(LABEL_WIDTH));
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Identity line on EVERY capture (same format as page inspect/eval): without
 *  it an agent can't tell a signed-in capture from "--auth silently no-op'd and
 *  this is the anonymous page" — or assumes an unflagged capture carried a
 *  signed-in session. */
function printAuthLine(auth?: ScreenshotMeta['auth']): void {
  if (!auth?.requested) {
    console.log(`${label('Auth')} ${muted('anonymous visitor (signed out; pass --auth to capture as your Gipity account)')}`);
    return;
  }
  const who = getAuth()?.email;
  console.log(auth.established
    ? `${label('Auth')} ${success('session established')}${who ? muted(` as ${who}`) : ''} ${muted('(what the page renders with it is app-defined)')}`
    : `${warning('Auth: session NOT established')}${auth.detail ? ` — ${auth.detail}` : ''} ${muted('(this is the anonymous view)')}`);
}

/** A failed pre-capture script still yields a screenshot - of the page it never
 *  touched. Silence there is the trap: the image looks plausible and the command
 *  reports success, so the caller trusts a capture of the wrong state. Say so —
 *  and say WHICH half failed, since --wait-for and --action ride the same script:
 *  a gate that never matched is a different problem (and a different fix) from a
 *  click that threw. */
export function printActionErrorLine(actionError?: string): void {
  if (!actionError) return;
  if (/wait-for:/.test(actionError)) {
    console.log(`${warning('⚠ --wait-for never matched:')} ${actionError.replace(/^EvalError:\s*/, '')} ${muted('(the image below is the state the page WAS in when the gate gave up)')}`);
    return;
  }
  console.log(`${warning('⚠ --action failed:')} ${actionError} ${muted('(this image shows the page BEFORE the action ran)')}`);
}

/** The browser sandbox has one wall-clock budget for the entire capture, and
 *  --action's own runtime spends it. When the sandbox times out on a run that
 *  passed --action, the server's message ("platform-side failure, the page was
 *  never reached") is the whole story only if the action was cheap — so append
 *  the lever the caller actually has. Exported for tests. */
export function augmentSandboxTimeout(message: string): string {
  if (!/did not respond within/i.test(message)) return message;
  return (
    `${message}\n` +
    `A pre-capture script was set (--action and/or the --wait-for gate), and its runtime is spent INSIDE ` +
    `that same sandbox budget — a script that waits on slow work (a WASM/model download, a network fetch, ` +
    `a long animation) can exhaust the budget on its own. Keep --action to the interaction itself (a click, ` +
    `a keypress), let the page do the slow work on load, and absorb that with --wait <ms> or a tighter ` +
    `--wait-for '<selector>' gate instead.`
  );
}

function fmtPerformance(p: PagePerformance): string {
  const parts = [
    `TTFB ${fmtMs(p.ttfb)}`,
    `DOMReady ${fmtMs(p.domReady)}`,
    p.load > 0 ? `Load ${fmtMs(p.load)}` : null,
    p.lcp != null ? `LCP ${fmtMs(p.lcp)}` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

function slugFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'page';
  }
  const labels = host.split('.').filter(Boolean);
  const trimmed = labels.length >= 3 ? labels.slice(1) : labels;
  const slug = trimmed.join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return slug || 'page';
}

function dimSuffix(vp: Viewport): string {
  const dpr = vp.deviceScaleFactor ?? 1;
  return dpr === 1 ? `${vp.width}x${vp.height}` : `${vp.width}x${vp.height}@${dpr}`;
}

/** Default screenshot directory: `<project-root>/screenshots`, falling back
 *  to `./screenshots` in one-off mode (no linked project). Screenshots are
 *  part of the project's build history: the dir syncs to Gipity (the server
 *  also persists captures to VFS `screenshots/` directly — same names, so
 *  sync reconciles by content hash) but is excluded from every deploy
 *  server-side. Timestamped filenames make the history browsable. */
function defaultScreenshotDir(): string {
  const root = getProjectRoot();
  return join(root ?? '.', 'screenshots');
}

/** `yyyy-mm-dd_hh-mm-ss` per the repo timestamp convention - sorts chronologically,
 *  filesystem-safe. One stamp per invocation; viewport suffixes keep multi-shot
 *  runs distinct so they never collide on the shared timestamp. */
export function timestampSlug(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function defaultFilename(slug: string, ts: string, suffix?: string): string {
  return suffix ? `ss-${slug}-${suffix}-${ts}.png` : `ss-${slug}-${ts}.png`;
}

function parseViewportString(s: string): Viewport {
  const m = s.trim().match(/^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/i);
  if (!m) throw new Error(`Invalid --viewport value: "${s}" (expected WxH or WxH@dpr)`);
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  const dpr = m[3] ? parseFloat(m[3]) : undefined;
  if (width < 200 || width > 3840 || height < 200 || height > 2160) {
    throw new Error(`Viewport out of range: ${s} (200-3840 x 200-2160)`);
  }
  return dpr ? { width, height, deviceScaleFactor: dpr } : { width, height };
}

/** Device metrics for the exact server device names, so `--device "Pixel 9"` works
 *  alongside the friendly `mobile`/`tablet` presets. Mirrors agent-browser's own
 *  descriptors; the server re-applies them, these are for filenames + meta. */
const EXACT_DEVICE_VIEWPORTS: Record<string, Viewport> = {
  'iPhone 15':     { width: 393,  height: 852,  deviceScaleFactor: 3,     device: 'iPhone 15' },
  'iPhone 16':     { width: 393,  height: 852,  deviceScaleFactor: 3,     device: 'iPhone 16' },
  'iPhone 16 Pro': { width: 402,  height: 874,  deviceScaleFactor: 3,     device: 'iPhone 16 Pro' },
  'iPhone 17':     { width: 402,  height: 874,  deviceScaleFactor: 3,     device: 'iPhone 17' },
  'iPad':          { width: 820,  height: 1180, deviceScaleFactor: 2,     device: 'iPad' },
  'iPad Pro':      { width: 1024, height: 1366, deviceScaleFactor: 2,     device: 'iPad Pro' },
  'Pixel 9':       { width: 412,  height: 923,  deviceScaleFactor: 2.625, device: 'Pixel 9' },
  'Galaxy S25':    { width: 360,  height: 800,  deviceScaleFactor: 3,     device: 'Galaxy S25' },
};

/** Emulatable devices the server accepts (its BROWSER_DEVICES). Shared with
 *  `page inspect` so both commands take the same names. */
export const TOUCH_DEVICES = Object.keys(EXACT_DEVICE_VIEWPORTS);

/** Case-insensitively resolve a device name or `mobile`/`tablet` alias to a server
 *  device name. Used by `page inspect`, which takes one device rather than viewports. */
export function resolveTouchDevice(name: string): string {
  const key = name.trim().toLowerCase();
  if (TOUCH_DEVICE_ALIASES[key]) return TOUCH_DEVICE_ALIASES[key];
  const exact = TOUCH_DEVICES.find((d) => d.toLowerCase() === key);
  if (exact) return exact;
  throw new Error(`Unknown --device: "${name}" (known: mobile, tablet, ${TOUCH_DEVICES.join(', ')})`);
}

function resolveDevice(name: string): Viewport {
  const key = name.trim().toLowerCase();
  const preset = DEVICE_PRESETS[key];
  if (preset) return preset;
  const exact = TOUCH_DEVICES.find((d) => d.toLowerCase() === key);
  if (exact) return EXACT_DEVICE_VIEWPORTS[exact];
  const available = [...Object.keys(DEVICE_PRESETS), ...TOUCH_DEVICES].join(', ');
  throw new Error(`Unknown --device preset: "${name}" (known: ${available})`);
}

function splitCsv(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return values.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
}

function appendOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

// Pre-capture scripting lives on --action, but agents reach for the JS-intent
// names first — --eval above all, the name they already know from `page eval`.
// The intent is unambiguous (run this JS in the page before the shot), so these
// are working hidden aliases, not errors — same accept-the-reflex-guess pattern
// as --full-page and --width/--height. (Supersedes the earlier decoy approach,
// which swallowed the script and errored with a redirect: when the guess is
// unambiguous, making it WORK beats making it a better error.)
const ACTION_ALIAS_FLAGS = ['--eval', '--js', '--javascript', '--script', '--code', '--exec'];

/** A capture is worthless if it fires before the app reaches the state you meant
 *  to photograph, and the only lever used to be a blind millisecond delay — so a
 *  camera/vision app got screenshotted with a guessed duration (`--wait 22000`).
 *  `--wait-for '<selector>'` is the same deterministic gate `page eval` and
 *  `page inspect` take, and it runs here as the head of the pre-capture script:
 *  poll for the element, then let any --action run. Timing out THROWS, so the
 *  server reports it (the shot still happens) instead of silently handing back a
 *  picture of the wrong moment. Exported for tests. */
export function buildWaitForGate(selector: string, timeoutMs: number): string {
  const sel = JSON.stringify(selector);
  return (
    `await (async () => { const __t0 = Date.now(); ` +
    `while (Date.now() - __t0 < ${timeoutMs}) { ` +
    `try { if (document.querySelector(${sel})) return; } catch (e) { throw new Error('wait-for: invalid selector ' + ${sel}); } ` +
    `await new Promise((r) => setTimeout(r, 100)); } ` +
    `throw new Error('wait-for: nothing matched ' + ${sel} + ' within ${timeoutMs}ms — the page never reached that state (raise --wait-timeout, fix the selector, or check the app actually gets there headlessly)'); })();`
  );
}

/** Max ms the selector gate may wait. The gate runs inside the capture's sandbox
 *  exec budget (page load + delay + script + settle + render), and 15s is what
 *  that budget actually covers — asking for more would blow the whole capture and
 *  come back as "the browser sandbox did not respond", blaming the platform for a
 *  wait the CLI accepted. A state that takes longer than this to appear is not a
 *  screenshot problem: gate it on `page eval --wait-for` (30s) and read it there. */
export const WAIT_FOR_MAX_MS = 15_000;
export const WAIT_FOR_DEFAULT_MS = 15_000;

/** The server's cap on the post-load delay. Over it, the request is rejected by
 *  schema validation with no mention of the flag — clamp and explain instead. */
export const MAX_POST_LOAD_DELAY_MS = 30_000;

/** A camera app has nothing to photograph 1s after load: getUserMedia has to come
 *  up and the vision model (WASM + weights) has to download before the app can
 *  draw a single box or label. Same window `page eval --camera` takes — without it
 *  every camera screenshot is a picture of a loading screen, and the caller is
 *  left guessing a duration. */
export const CAMERA_DEFAULT_DELAY_MS = 15_000;

export const pageScreenshotCommand = new Command('screenshot')
  .description('Screenshot a web page')
  .argument('<url>', 'URL to screenshot')
  // --device / --viewport lead the options: "how does this look on a phone?" is
  // the single most common reason to screenshot, and agents routinely read the
  // help through `--help | head -N` — buried below the timing flags, these two
  // fell off the bottom and the run proceeded at desktop width.
  .option('--device <names>', `Device preset(s): ${Object.keys(DEVICE_PRESETS).join(', ')} (comma-separated or repeat flag). mobile/tablet emulate a real touch device — touch events, mobile user-agent, DPR — so touch-gated mobile UI actually renders.`, appendOption, [] as string[])
  .option('--viewport <dims>', 'Raw viewport(s): WxH or WxH@dpr (comma-separated or repeat flag), e.g. --viewport 390x844 for a phone-sized window', appendOption, [] as string[])
  // No commander default: a default here would make the value always set, so the
  // merge below could not tell "caller chose a delay" from "nobody did" — which
  // is what --camera's model-load default and the --wait-for gate both hinge on.
  .option('--wait <ms>', `Sleep this many ms after DOMContentLoaded before capturing (default 1000, max ${MAX_POST_LOAD_DELAY_MS}). With --camera it defaults to ${CAMERA_DEFAULT_DELAY_MS} so the vision model is up. Same flag as page eval/inspect.`)
  .option('--wait-for <selector>', `Wait until this CSS selector appears before capturing, then capture (deterministic - beats guessing a --wait). Same flag as page eval/inspect. Gate on what you are photographing ('[data-vision="ready"]', '#verdict:not(:empty)'). Max ${WAIT_FOR_MAX_MS}ms (--wait-timeout).`)
  .option('--wait-timeout <ms>', `Max ms to wait for --wait-for before giving up (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}). Timing out is reported - the capture still happens, so you see the state it got stuck in.`)
  .option('--action <js>','Run JS in the page before capturing — e.g. click a button to enter a state ("document.getElementById(\'play\').click()"). Runs as an async function body, so const/await and app-relative import(\'./…\') work. Runs after the post-load delay, then settles again before the shot. If it throws, the capture still happens and the failure is reported.')
  .option('--full', 'Capture the full scrollable page (default: viewport only). Scrolls the page through first so scroll-reveal/fade-in-on-scroll (IntersectionObserver) sections render into the shot instead of capturing blank.')
  .option('-o, --output <file>', 'Output path (single viewport only; default .gipity/screenshots/ss-<host>-<timestamp>.png)')
  .option('--no-reload-between', 'Skip reload between viewports (faster, lower fidelity - only safe for static pages)')
  .option('--fake-media', 'Grant a synthetic microphone + camera and auto-accept the getUserMedia prompt, so voice/camera apps render headlessly. The video feed is a built-in test pattern — to capture what the app does with a REAL frame (a hand, a face, an object), use --camera <path> instead.')
  .option('--camera <path>', 'Play a local image or video (.png/.jpg/.webp/.mp4/.webm/.y4m/.mjpeg) as the browser\'s WEBCAM feed, then capture — so the shot shows the app reacting to a frame you chose (detected gesture, boxes, labels). Implies --fake-media.')
  .option('--auth', 'Capture the page signed in as you (your Gipity account), so UI behind a Sign-in-with-Gipity login is shown. Only works for apps using Sign in with Gipity, hosted on *.gipity.ai. Without this flag the page loads as a genuinely anonymous, signed-out visitor — nothing carries over from earlier --auth runs.')
  .option('--ephemeral', 'Skip the project screenshot history: do not persist this capture to Gipity (screenshots/ in the project). Local file is still written.')
  .option('--json', 'Output JSON metadata instead of a friendly summary')
  .addOption(new Option('--post-load-delay <ms>', 'Alias for --wait').hideHelp())
  // (--eval and the other JS-intent guesses are registered in one place from
  // ACTION_ALIAS_FLAGS below — a second standalone registration here makes
  // commander throw "conflicting flag" at startup.)
  // `--full-page` is the Puppeteer/Playwright name for this (their `fullPage`),
  // so agents reach for it by reflex. Accept it as a hidden alias for `--full`
  // rather than reject it as an unknown option and send them on a --help detour.
  .addOption(new Option('--full-page', 'Alias for --full').hideHelp())
  // `--width 390 --height 844` is the setViewport vocabulary agents guess first
  // when asked for a phone-sized shot. Accept the pair as a working alias for
  // --viewport WxH instead of bouncing the guess into a --help detour.
  .addOption(new Option('--width <px>', 'Alias: --viewport WxH').hideHelp())
  .addOption(new Option('--height <px>', 'Alias: --viewport WxH').hideHelp())
  .action((url: string, opts) => run('Page screenshot', async () => {
    // A JS-intent alias guess (--eval et al., hidden): fold it into the action
    // script so the reflex guess just works, and name the canonical flag once
    // so the next call uses it.
    const aliasFlag = ACTION_ALIAS_FLAGS.find((f) => opts[f.slice(2)] !== undefined);
    if (aliasFlag) {
      console.error(muted(
        `Note: treating ${aliasFlag} as --action — it runs your JS in the page before the capture. --action is the canonical flag.`,
      ));
    }
    const actionScript = [opts.action, ...ACTION_ALIAS_FLAGS.map((f) => opts[f.slice(2)])]
      .filter(Boolean).join('\n');
    // --wait is the canonical name (it is what `page inspect`/`page eval` call it);
    // --post-load-delay stays as a hidden alias. Whether the caller named EITHER is
    // what decides the defaults below, so keep the raw "was it set" signal.
    const delayRaw = opts.wait ?? opts.postLoadDelay;
    const chosenDelay = delayRaw !== undefined;
    let postLoadDelayMs = chosenDelay ? parseInt(String(delayRaw), 10) : 1000;
    if (!Number.isFinite(postLoadDelayMs) || postLoadDelayMs < 0) {
      throw new Error('--wait must be a non-negative integer (ms)');
    }
    if (postLoadDelayMs > MAX_POST_LOAD_DELAY_MS) {
      console.error(warning(
        `--wait ${postLoadDelayMs}ms exceeds the ${MAX_POST_LOAD_DELAY_MS}ms cap — using ${MAX_POST_LOAD_DELAY_MS}ms. ` +
        `Waiting longer is rarely the fix: gate on the state you want with --wait-for '<selector>' instead of guessing a duration.`,
      ));
      postLoadDelayMs = MAX_POST_LOAD_DELAY_MS;
    }

    const waitForTimeoutRaw = opts.waitTimeout !== undefined ? parseInt(String(opts.waitTimeout), 10) : WAIT_FOR_DEFAULT_MS;
    if (!Number.isFinite(waitForTimeoutRaw) || waitForTimeoutRaw < 0) {
      throw new Error('--wait-timeout must be a non-negative integer (ms)');
    }
    const waitForTimeoutMs = Math.min(waitForTimeoutRaw, WAIT_FOR_MAX_MS);
    if (waitForTimeoutRaw > WAIT_FOR_MAX_MS) {
      console.error(warning(
        `--wait-timeout ${waitForTimeoutRaw}ms exceeds the ${WAIT_FOR_MAX_MS}ms the capture's browser budget covers — using ${WAIT_FOR_MAX_MS}ms. ` +
        `A state that takes longer than that to appear is not a screenshot problem: watch for it with ` +
        `\`gipity page eval <url> --wait-for '<selector>' --wait-timeout 30000\` (a wider budget), then capture it.`,
      ));
    }
    if (opts.waitTimeout !== undefined && !opts.waitFor) {
      throw new Error("--wait-timeout only means something with --wait-for '<selector>' (it bounds that gate)");
    }

    // A camera app is a loading screen at the 1s default: the model has to come up
    // first. Give it the same window `page eval --camera` takes, unless the caller
    // said otherwise — either with their own --wait, or by gating on --wait-for,
    // which ends the moment the app is actually ready.
    if (opts.camera && !chosenDelay && !opts.waitFor) {
      postLoadDelayMs = CAMERA_DEFAULT_DELAY_MS;
      console.error(muted(
        `--camera: waiting ${CAMERA_DEFAULT_DELAY_MS / 1000}s before the capture so the camera and the app's vision ` +
        `model finish loading. Override with --wait <ms>, or use --wait-for '<ready-selector>' to shoot the moment it's ready.`,
      ));
    }

    const deviceNames = splitCsv(opts.device as string[]);
    const viewportStrs = splitCsv(opts.viewport as string[]);
    // --width/--height: fold the alias pair into a --viewport entry. Half a
    // pair is a mis-invocation worth one precise line, not a range error.
    if (opts.width !== undefined || opts.height !== undefined) {
      if (opts.width === undefined || opts.height === undefined) {
        pageScreenshotCommand.error(
          'error: --width and --height go together (both in px, equivalent to --viewport WxH) — ' +
          'or use a preset like --device mobile for a real handset (touch events, mobile user-agent, DPR)',
        );
      }
      if (!/^\d+$/.test(String(opts.width)) || !/^\d+$/.test(String(opts.height))) {
        pageScreenshotCommand.error('error: --width and --height must be integers (px)');
      }
      viewportStrs.push(`${opts.width}x${opts.height}`);
      // A raw phone-sized window is NOT a phone: touch-gated mobile UI still
      // renders its desktop variant. Say so once, on the path where the caller
      // was clearly after a phone.
      if (parseInt(String(opts.width), 10) <= 500) {
        console.error(muted('Tip: --device mobile emulates a real handset (touch events, mobile user-agent, DPR) — a raw viewport only resizes the window.'));
      }
    }
    const customViewports: Viewport[] = [
      ...deviceNames.map(resolveDevice),
      ...viewportStrs.map(parseViewportString),
    ];

    if (opts.output && customViewports.length > 1) {
      throw new Error('--output can only be used with a single viewport');
    }

    // Server defaults to 1280×720 when viewports is omitted - don't send it in
    // the no-flag case so the filename stays unsuffixed (no viewport segment).
    const userSpecifiedViewports = customViewports.length > 0;

    // Filenames are decided before the request so the server can persist the
    // captures to the project VFS under the SAME names the local files get —
    // the local screenshots/ dir and the VFS screenshot history stay 1:1 and
    // sync reconciles them by content hash instead of duplicating.
    const slug = slugFromUrl(url);
    const ts = timestampSlug();
    const shotName = (vp?: Viewport) =>
      defaultFilename(slug, ts, vp && userSpecifiedViewports ? dimSuffix(vp) : undefined);
    const names = userSpecifiedViewports ? customViewports.map(shotName) : [shotName()];
    const projectGuid = getConfig()?.projectGuid;
    const save = !opts.ephemeral && projectGuid ? { project_guid: projectGuid, names } : undefined;

    // The webcam frame is hosted in the project's public file store for the
    // browser container to fetch, so it needs a linked project. Validate the
    // file locally first — a bad file type costs one instant error, not an
    // upload plus an opaque browser-side failure.
    let camera: HostedFixture | undefined;
    if (opts.camera) {
      assertCameraFile(opts.camera);
      if (!projectGuid) throw new Error('--camera needs a linked project (the frame is hosted for the browser to fetch) — run `gipity link` first.');
      console.log(muted(`Hosting camera feed ${opts.camera}…`));
      camera = await uploadCameraFeed(projectGuid, opts.camera);
    }

    // The pre-capture script the server runs after the post-load delay: the
    // --wait-for gate first (so the shot waits for the state, deterministically),
    // then the caller's --action (with any alias-flag scripts folded in by
    // actionScript above). All the same in-page primitive, so they
    // compose into one script rather than needing a second server round-trip.
    const preCapture = [
      opts.waitFor ? buildWaitForGate(opts.waitFor, waitForTimeoutMs) : '',
      actionScript,
    ].filter(Boolean).join('\n');

    const body = {
      url,
      postLoadDelayMs,
      full: !!(opts.full || opts.fullPage),
      reloadBetween: opts.reloadBetween !== false,
      ...(userSpecifiedViewports ? { viewports: customViewports } : {}),
      // A camera feed is played into the synthetic devices, so --camera implies
      // --fake-media rather than failing on the pairing.
      ...(opts.fakeMedia || camera ? { fakeMedia: true } : {}),
      ...(camera ? { cameraUrl: camera.url } : {}),
      ...(opts.auth ? { auth: true } : {}),
      ...(preCapture ? { action: preCapture } : {}),
      ...(save ? { save } : {}),
    };

    // Load + render across viewports runs server-side and can take many
    // seconds; animate the wait, then clear so the saved-files summary is the
    // result. JSON mode skips the spinner (shares stdout).
    const doShoot = () => postForTarEntries('/tools/browser/screenshot', body);
    let entries;
    try {
      try {
        entries = opts.json
          ? await doShoot()
          : await withSpinner('Capturing…', doShoot, { done: null });
      } catch (err) {
        // The sandbox budget covers the WHOLE capture — load, --action, settle,
        // render. The server's timeout text (rightly) says the page was never
        // reached, which reads as "nothing you can do" and leaves a long-running
        // --action looking innocent. Name it, so the retry is an informed one.
        throw preCapture ? new Error(augmentSandboxTimeout((err as Error).message)) : err;
      }
    } finally {
      if (camera) {
        try {
          await deleteFixture(projectGuid!, camera.guid);
        } catch (err) {
          console.error(warning(`⚠ Could not auto-delete camera feed "${camera.name}" (${camera.guid}) — still hosted at ${camera.url}: ${(err as Error).message}`));
        }
      }
    }

    const metaEntry = entries.find((e) => e.name === 'meta.json');
    if (!metaEntry) throw new Error('Server response missing meta.json');
    const meta = JSON.parse(metaEntry.buffer.toString('utf8')) as ScreenshotMeta;

    const pngs = entries.filter((e) => e.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name));
    if (pngs.length !== meta.screenshots.length) {
      throw new Error(`Server returned ${pngs.length} PNGs but ${meta.screenshots.length} metadata entries`);
    }

    const dir = defaultScreenshotDir();
    const savedFiles: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const target = opts.output
        ? opts.output
        : join(dir, names[i] ?? shotName(meta.screenshots[i].viewport));
      // Create the target's parent dir so a `-o` path under a not-yet-existing
      // directory (e.g. .gipity/screenshots/home.png) writes cleanly instead of
      // failing with a raw ENOENT and forcing a manual `mkdir -p`.
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, pngs[i].buffer);
      // Absolute path so the agent knows exactly where the file landed.
      savedFiles.push(resolvePath(target));
    }

    if (opts.json) {
      console.log(JSON.stringify({
        url,
        page: {
          title: meta.title,
          final_url: meta.finalUrl,
          status: meta.status,
          performance: meta.performance,
          ...(meta.auth ? { auth: meta.auth } : {}),
        },
        screenshots: meta.screenshots.map((s, i) => ({
          file: savedFiles[i],
          viewport: {
            width: s.viewport.width,
            height: s.viewport.height,
            device_scale_factor: s.viewport.deviceScaleFactor,
            ...(s.viewport.device ? { device: s.viewport.device } : {}),
            touch: !!s.viewport.touch,
          },
          width: s.width,
          height: s.height,
          size_bytes: s.screenshotSizeBytes,
          full_page: meta.full,
          phase: s.phase,
          ...(s.vfs ? { gipity: s.vfs } : {}),
        })),
      }));
      return;
    }

    /** One-line VFS-history status for a screenshot ("saved to Gipity" or why not). */
    const printVfsLine = (s: ScreenshotMeta['screenshots'][number]) => {
      if (!s.vfs) return;
      if ('error' in s.vfs) {
        console.log(`${warning('⚠ Gipity save failed:')} ${s.vfs.error} ${muted('(local file is fine)')}`);
      } else {
        console.log(`${label('Gipity history')} ${s.vfs.path} ${muted('(synced, not deployed)')}`);
      }
    };

    if (meta.screenshots.length === 1) {
      const s = meta.screenshots[0];
      console.log(`${brand('Screenshot')} ${bold(url)}`);
      if (meta.title) console.log(`${label('Web page title')} ${meta.title}`);
      if (meta.finalUrl) console.log(`${label('Web page URL')} ${meta.finalUrl}`);
      if (meta.status != null) console.log(`${label('Web page status')} ${meta.status}`);
      if (meta.performance) console.log(`${label('Web page perf')} ${fmtPerformance(meta.performance)}`);
      printAuthLine(meta.auth);
      printActionErrorLine(meta.actionError);
      if (s.viewport.device) console.log(`${label('Emulated device')} ${s.viewport.device} ${muted('(touch events, mobile user-agent)')}`);
      const sizePart = formatSize(s.screenshotSizeBytes) + (meta.full ? ' (full page)' : '');
      console.log(`${label('Screenshot size')} ${sizePart}`);
      if (s.width && s.height) console.log(`${label('Screenshot dims')} ${s.width} × ${s.height}`);
      console.log(`${label('Screenshot file')} ${success(savedFiles[0])}`);
      printVfsLine(s);
      return;
    }

    console.log(`${brand('Loading')} ${bold(url)} ${muted(`once → ${meta.screenshots.length} viewports`)}`);
    if (meta.title) console.log(`${label('Web page title')} ${meta.title}`);
    if (meta.finalUrl) console.log(`${label('Web page URL')} ${meta.finalUrl}`);
    if (meta.status != null) console.log(`${label('Web page status')} ${meta.status}`);
    if (meta.performance) console.log(`${label('Web page perf')} ${fmtPerformance(meta.performance)}`);
    printAuthLine(meta.auth);
    printActionErrorLine(meta.actionError);

    for (let i = 0; i < meta.screenshots.length; i++) {
      const s = meta.screenshots[i];
      const dims = `${s.viewport.width}×${s.viewport.height}${s.viewport.deviceScaleFactor > 1 ? ` @${s.viewport.deviceScaleFactor}x` : ''}`;
      const deviceTag = s.viewport.device ? muted(` — ${s.viewport.device}, touch`) : '';
      console.log(`\n${brand('@ ' + dims)}${deviceTag}`);
      const sizePart = formatSize(s.screenshotSizeBytes) + (meta.full ? ' (full page)' : '');
      console.log(`${label('Screenshot size')} ${sizePart}`);
      if (s.width && s.height) console.log(`${label('Screenshot dims')} ${s.width} × ${s.height}`);
      console.log(`${label('Screenshot file')} ${success(savedFiles[i])}`);
      printVfsLine(s);
    }
  }));

// Register the JS-intent guesses as hidden aliases for --action (value-taking,
// so they capture the script) — the action folds them into the pre-capture body.
for (const f of ACTION_ALIAS_FLAGS) pageScreenshotCommand.addOption(new Option(`${f} <js>`, 'Alias for --action').hideHelp());

// `screenshot` captures the page AFTER load + settle (+ optional --wait-for gate
// and --action). There is no scroll-to-a-position lever (agents reach for
// --scroll and get an unknown-option detour) — but `--full` does walk the page
// top→bottom→top before the shot so scroll-reveal content paints in. State the
// supported levers right here, so the help (rendered on any bad flag, and this
// 'after' block survives `| tail`/`| grep`) ends the hunt in one shot.
// --wait-for covers "shoot once it's ready"; --action covers "click, then shoot";
// --full + crop covers off-screen regions; `page eval` reads data, no picture.
pageScreenshotCommand.addHelpText('after', `
Examples:
  gipity page screenshot "https://dev.gipity.ai/me/app/"
  gipity page screenshot "https://dev.gipity.ai/me/app/" --full          # whole scrollable page (scroll-reveal sections triggered)
  gipity page screenshot "https://dev.gipity.ai/me/app/" --device mobile,desktop
  gipity page screenshot "https://dev.gipity.ai/me/app/" \\
    --action "document.getElementById('play').click()"                   # capture an in-game frame
  # Camera / vision app: play a real frame in as the webcam and shoot once the app
  # says it's ready — same --camera / --wait-for flags as 'page eval', no guessed delay:
  gipity page screenshot "https://dev.gipity.ai/me/app/" --camera fist.png \\
    --wait-for '[data-vision="ready"]'

Waiting for the page to reach a state before the shot?
  --wait-for '<selector>' gates the capture on the app's own signal (deterministic).
  Reach for --wait <ms> only when there is nothing to gate on — a guessed duration
  either shoots too early or wastes the difference.

Capturing a state that needs an interaction (start a game, open a menu, dismiss a modal)?
  Use --action to run JS in the page before the shot — it fires after the wait
  (and after any --wait-for gate), then settles again so the result has painted. Do
  NOT hand-roll a 'page eval' that returns a base64 image: the eval result is capped
  (~16KB) and truncates the PNG.

Capturing an off-screen region or reading element data?
    • --full captures the ENTIRE scrollable page (then crop to the region).
    • 'gipity page eval <url> "<expr>"' reads any (even off-screen) element's
      data/state/rect without a picture — e.g. read the chart's bar values
      directly instead of screenshotting the slide.`);
