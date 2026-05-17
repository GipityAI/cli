import { Command } from 'commander';
import { post } from '../api.js';
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

export const pageInspectCommand = new Command('page-inspect')
  .description('Inspect a web page')
  .argument('<url>', 'URL to inspect')
  .option('--wait <ms>', 'Wait before capture in ms', '3000')
  .option('--json', 'Output as JSON')
  .option('--no-truncate', 'Show full URLs instead of truncating long ones with middle-ellipsis')
  .option('--all', 'Include render-blocking, large resources, oversized images, and LCP detail')
  .action((url: string, opts) => run('Page inspect', async () => {
    const waitMs = parseInt(opts.wait, 10) || 3000;
    const truncate = opts.truncate !== false;
    const showAll = opts.all === true;

    const res = await post<{ data: DebugBundle }>(
      `/tools/browser/inspect`,
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
    if (showAll && b.lcp) {
      console.log(`    LCP: ${b.lcp.time}ms (${b.lcp.element}${b.lcp.url ? ' ' + shortUrl(b.lcp.url, truncate) : ''})`);
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

    if (showAll) {
      // ── Render Blocking ──
      if (b.renderBlocking?.length > 0) {
        console.log(`\n  ${warning(`Render-blocking (${b.renderBlocking.length}):`)}`);
        for (const r of b.renderBlocking) {
          console.log(`    ${shortUrl(r, truncate)}`);
        }
      }

      // ── Large Resources ──
      if (b.largeResources?.length > 0) {
        console.log(`\n  ${warning(`Large resources >100KB (${b.largeResources.length}):`)}`);
        for (const r of b.largeResources) {
          console.log(`    ${info(formatSize(r.size).padEnd(10))} ${muted(r.type.padEnd(8))} ${shortUrl(r.url, truncate)}`);
        }
      }

      // ── Oversized Images ──
      if (b.oversizedImages?.length > 0) {
        console.log(`\n  ${warning(`Oversized images (${b.oversizedImages.length}):`)}`);
        for (const img of b.oversizedImages) {
          console.log(`    ${img.natural} served, ${img.displayed} displayed - ${shortUrl(img.src, truncate)}`);
        }
      }
    }

    console.log('');
  }));
