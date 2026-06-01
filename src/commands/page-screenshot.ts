import { Command, Option } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { postForTarEntries } from '../api.js';
import { getProjectRoot } from '../config.js';
import { brand, bold, muted, success } from '../colors.js';
import { formatSize } from '../utils.js';
import { run } from '../helpers/index.js';

type Viewport = { width: number; height: number; deviceScaleFactor?: number };

const DEVICE_PRESETS: Record<string, Viewport> = {
  default: { width: 1280, height: 720 },
  desktop: { width: 1920, height: 1080 },
  laptop:  { width: 1366, height: 768 },
  tablet:  { width: 768,  height: 1024, deviceScaleFactor: 2 },
  mobile:  { width: 390,  height: 844,  deviceScaleFactor: 3 },
};

type PagePerformance = { ttfb: number; domReady: number; load: number; lcp: number | null };

type ScreenshotMeta = {
  requestedUrl: string;
  finalUrl: string | null;
  title: string | null;
  status: number | null;
  full: boolean;
  reloadBetween: boolean;
  performance: PagePerformance | null;
  screenshots: Array<{
    index: number;
    viewport: Viewport & { deviceScaleFactor: number };
    width: number;
    height: number;
    screenshotSizeBytes: number;
    phase: 'initial-load' | 'reload' | 'no-reload';
  }>;
};

const LABEL_WIDTH = 18; // "Screenshot dims:" + trailing space

function label(text: string): string {
  return muted((text + ':').padEnd(LABEL_WIDTH));
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
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

/** Default screenshot directory: `<project-root>/.gipity/screenshots`, falling
 *  back to `./.gipity/screenshots` in one-off mode (no linked project). `.gipity/`
 *  is sync-ignored, so these verification artifacts never sync to Gipity or
 *  deploy to the CDN - and they stay out of the project root. */
function defaultScreenshotDir(): string {
  const root = getProjectRoot();
  return join(root ?? '.', '.gipity', 'screenshots');
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

function resolveDevice(name: string): Viewport {
  const key = name.trim().toLowerCase();
  const preset = DEVICE_PRESETS[key];
  if (!preset) {
    const available = Object.keys(DEVICE_PRESETS).join(', ');
    throw new Error(`Unknown --device preset: "${name}" (known: ${available})`);
  }
  return preset;
}

function splitCsv(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return values.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean));
}

function appendOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export const pageScreenshotCommand = new Command('screenshot')
  .description('Screenshot a web page')
  .argument('<url>', 'URL to screenshot')
  .option('--post-load-delay <ms>', 'Delay after DOMContentLoaded before capture, in ms', '1000')
  .option('--full', 'Capture the full scrollable page (default: viewport only)')
  .option('-o, --output <file>', 'Output path (single viewport only; default .gipity/screenshots/ss-<host>-<timestamp>.png)')
  .option('--device <names>', `Viewport preset(s): ${Object.keys(DEVICE_PRESETS).join(', ')} (comma-separated or repeat flag)`, appendOption, [] as string[])
  .option('--viewport <dims>', 'Raw viewport(s): WxH or WxH@dpr (comma-separated or repeat flag)', appendOption, [] as string[])
  .option('--no-reload-between', 'Skip reload between viewports (faster, lower fidelity - only safe for static pages)')
  .option('--fake-media', 'Grant a synthetic microphone + camera and auto-accept the getUserMedia prompt, so voice/camera apps render headlessly (audio is a built-in tone, not real speech)')
  .option('--eval <js>', 'Run this JS in the page and await it before capturing - builds state in the same session (e.g. draw shapes via a test hook) so the screenshot shows the result of an interaction, not a fresh load')
  .option('--json', 'Output JSON metadata instead of a friendly summary')
  .addOption(new Option('--wait <ms>', 'Alias for --post-load-delay').hideHelp())
  .addOption(new Option('--setup <js>', 'Alias for --eval').hideHelp())
  .action((url: string, opts) => run('Page screenshot', async () => {
    const delayRaw = opts.postLoadDelay ?? opts.wait;
    const postLoadDelayMs = delayRaw !== undefined ? parseInt(String(delayRaw), 10) : undefined;
    if (postLoadDelayMs !== undefined && (!Number.isFinite(postLoadDelayMs) || postLoadDelayMs < 0)) {
      throw new Error('--post-load-delay must be a non-negative integer (ms)');
    }

    const deviceNames = splitCsv(opts.device as string[]);
    const viewportStrs = splitCsv(opts.viewport as string[]);
    const customViewports: Viewport[] = [
      ...deviceNames.map(resolveDevice),
      ...viewportStrs.map(parseViewportString),
    ];

    if (opts.output && customViewports.length > 1) {
      throw new Error('--output can only be used with a single viewport');
    }

    // --eval/--setup: JS to run in the page before capture, so the shot shows
    // the result of an interaction (state built in the same session).
    const setupJs: string | undefined = opts.eval ?? opts.setup;
    // A reload between viewports throws away whatever the setup JS built, so the
    // multi-viewport reload path can't carry that state forward.
    if (setupJs && customViewports.length > 1 && opts.reloadBetween !== false) {
      throw new Error('--eval is incompatible with multiple viewports unless --no-reload-between is set (reload wipes the state the JS built); use one viewport or pass --no-reload-between');
    }

    // Server defaults to 1280×720 when viewports is omitted - don't send it in
    // the no-flag case so the filename stays unsuffixed (no viewport segment).
    const userSpecifiedViewports = customViewports.length > 0;
    const body = {
      url,
      postLoadDelayMs,
      full: !!opts.full,
      reloadBetween: opts.reloadBetween !== false,
      ...(userSpecifiedViewports ? { viewports: customViewports } : {}),
      ...(opts.fakeMedia ? { fakeMedia: true } : {}),
      ...(setupJs ? { setupJs } : {}),
    };

    const entries = await postForTarEntries('/tools/browser/screenshot', body);

    const metaEntry = entries.find((e) => e.name === 'meta.json');
    if (!metaEntry) throw new Error('Server response missing meta.json');
    const meta = JSON.parse(metaEntry.buffer.toString('utf8')) as ScreenshotMeta;

    const pngs = entries.filter((e) => e.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name));
    if (pngs.length !== meta.screenshots.length) {
      throw new Error(`Server returned ${pngs.length} PNGs but ${meta.screenshots.length} metadata entries`);
    }

    const slug = slugFromUrl(url);
    const ts = timestampSlug();
    const dir = defaultScreenshotDir();
    if (!opts.output) mkdirSync(dir, { recursive: true });
    const savedFiles: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const shot = meta.screenshots[i];
      const suffix = userSpecifiedViewports ? dimSuffix(shot.viewport) : undefined;
      const target = opts.output
        ? opts.output
        : join(dir, defaultFilename(slug, ts, suffix));
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
        },
        screenshots: meta.screenshots.map((s, i) => ({
          file: savedFiles[i],
          viewport: {
            width: s.viewport.width,
            height: s.viewport.height,
            device_scale_factor: s.viewport.deviceScaleFactor,
          },
          width: s.width,
          height: s.height,
          size_bytes: s.screenshotSizeBytes,
          full_page: meta.full,
          phase: s.phase,
        })),
      }));
      return;
    }

    if (meta.screenshots.length === 1) {
      const s = meta.screenshots[0];
      console.log(`\n${brand('Screenshot')} ${bold(url)}`);
      if (meta.title) console.log(`  ${label('Web page title')} ${meta.title}`);
      if (meta.finalUrl) console.log(`  ${label('Web page URL')} ${meta.finalUrl}`);
      if (meta.status != null) console.log(`  ${label('Web page status')} ${meta.status}`);
      if (meta.performance) console.log(`  ${label('Web page perf')} ${fmtPerformance(meta.performance)}`);
      const sizePart = formatSize(s.screenshotSizeBytes) + (meta.full ? ' (full page)' : '');
      console.log(`  ${label('Screenshot size')} ${sizePart}`);
      if (s.width && s.height) console.log(`  ${label('Screenshot dims')} ${s.width} × ${s.height}`);
      console.log(`  ${label('Screenshot file')} ${success(savedFiles[0])}\n`);
      return;
    }

    console.log(`\n${brand('Loading')} ${bold(url)} ${muted(`once → ${meta.screenshots.length} viewports`)}`);
    if (meta.title) console.log(`  ${label('Web page title')} ${meta.title}`);
    if (meta.finalUrl) console.log(`  ${label('Web page URL')} ${meta.finalUrl}`);
    if (meta.status != null) console.log(`  ${label('Web page status')} ${meta.status}`);
    if (meta.performance) console.log(`  ${label('Web page perf')} ${fmtPerformance(meta.performance)}`);

    for (let i = 0; i < meta.screenshots.length; i++) {
      const s = meta.screenshots[i];
      const dims = `${s.viewport.width}×${s.viewport.height}${s.viewport.deviceScaleFactor > 1 ? ` @${s.viewport.deviceScaleFactor}x` : ''}`;
      console.log(`\n  ${brand('@ ' + dims)}`);
      const sizePart = formatSize(s.screenshotSizeBytes) + (meta.full ? ' (full page)' : '');
      console.log(`    ${label('Screenshot size')} ${sizePart}`);
      if (s.width && s.height) console.log(`    ${label('Screenshot dims')} ${s.width} × ${s.height}`);
      console.log(`    ${label('Screenshot file')} ${success(savedFiles[i])}`);
    }
    console.log('');
  }));
