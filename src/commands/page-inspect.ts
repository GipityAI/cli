import { Command } from 'commander';
import { post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { formatSize } from '../utils.js';
import { brand, bold, error as clrError, warning, muted, info } from '../colors.js';
import { run } from '../helpers/index.js';

interface DebugBundle {
  url: string;
  title: string;
  console: string[];
  failedResources: string[];
  timing: { ttfb: number; domReady: number; load: number };
  elementCount: number;
  totalBytes: number;
  largeResources: { url: string; size: number; type: string }[];
  renderBlocking: string[];
  oversizedImages: { src: string; natural: string; displayed: string }[];
  lcp: { time: number; element: string; url: string | null; size: number } | null;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.length > 60 ? url.slice(-60) : url;
  }
}

export const pageInspectCommand = new Command('page-inspect')
  .description('Inspect a URL: console errors, performance, failed resources')
  .argument('<url>', 'URL to inspect')
  .option('--wait <ms>', 'Wait before capture in ms', '3000')
  .option('--json', 'Output as JSON')
  .action((url: string, opts) => run('Page inspect', async () => {
    const { config } = await resolveProjectContext();
    const waitMs = parseInt(opts.wait, 10) || 3000;

    const res = await post<{ data: DebugBundle }>(
      `/projects/${config.projectGuid}/browser/inspect`,
      { url, waitMs },
    );

    const b = res.data;

    if (opts.json) {
      console.log(JSON.stringify(b));
      return;
    }

    const timing = b.timing || { ttfb: 0, domReady: 0, load: 0 };

    // ── Page Info ──
    console.log(`\n${brand('Inspecting')} ${bold(b.url || url)}`);
    console.log(`  ${muted('Title:')} ${b.title || '(none)'}`);
    console.log(`  ${muted('Elements:')} ${b.elementCount || 0}`);
    console.log(`  ${muted('Page weight:')} ${info(formatSize(b.totalBytes || 0))}`);

    // ── Timing ──
    console.log(`\n  ${bold('Timing:')}`);
    console.log(`    ${muted('TTFB:')} ${timing.ttfb}ms`);
    console.log(`    ${muted('DOM ready:')} ${timing.domReady}ms`);
    console.log(`    ${muted('Load:')} ${timing.load}ms`);
    if (b.lcp) {
      console.log(`    LCP: ${b.lcp.time}ms (${b.lcp.element}${b.lcp.url ? ' ' + shortUrl(b.lcp.url) : ''})`);
    }

    // ── Console ──
    if (b.console?.length > 0) {
      console.log(`\n  ${bold('Console')} ${muted(`(${b.console.length})`)}:`);
      for (const line of b.console) {
        console.log(`    ${warning(line)}`);
      }
    } else {
      console.log(`\n  ${bold('Console:')} ${muted('(clean)')}`);
    }

    // ── Failed Resources ──
    if (b.failedResources?.length > 0) {
      console.log(`\n  ${clrError(`Failed resources (${b.failedResources.length}):`)}`);
      for (const r of b.failedResources) {
        console.log(`    ${clrError(r)}`);
      }
    }

    // ── Render Blocking ──
    if (b.renderBlocking?.length > 0) {
      console.log(`\n  ${warning(`Render-blocking (${b.renderBlocking.length}):`)}`);
      for (const r of b.renderBlocking) {
        console.log(`    ${shortUrl(r)}`);
      }
    }

    // ── Large Resources ──
    if (b.largeResources?.length > 0) {
      console.log(`\n  ${warning(`Large resources >100KB (${b.largeResources.length}):`)}`);
      for (const r of b.largeResources) {
        console.log(`    ${info(formatSize(r.size).padEnd(10))} ${muted(r.type.padEnd(8))} ${shortUrl(r.url)}`);
      }
    }

    // ── Oversized Images ──
    if (b.oversizedImages?.length > 0) {
      console.log(`\n  ${warning(`Oversized images (${b.oversizedImages.length}):`)}`);
      for (const img of b.oversizedImages) {
        console.log(`    ${img.natural} served, ${img.displayed} displayed — ${shortUrl(img.src)}`);
      }
    }

    console.log('');
  }));
