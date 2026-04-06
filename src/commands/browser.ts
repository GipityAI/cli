import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { formatSize } from '../utils.js';

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

export const browserCommand = new Command('browser')
  .description('Inspect a URL: console errors, performance, failed resources')
  .argument('<url>', 'URL to inspect')
  .option('--wait <ms>', 'Wait before capture in ms', '3000')
  .option('--json', 'Output as JSON')
  .action(async (url: string, opts) => {
    try {
      const config = requireConfig();
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
      console.log(`\nInspecting ${b.url || url}`);
      console.log(`  Title: ${b.title || '(none)'}`);
      console.log(`  Elements: ${b.elementCount || 0}`);
      console.log(`  Page weight: ${formatSize(b.totalBytes || 0)}`);

      // ── Timing ──
      console.log(`\n  Timing:`);
      console.log(`    TTFB: ${timing.ttfb}ms`);
      console.log(`    DOM ready: ${timing.domReady}ms`);
      console.log(`    Load: ${timing.load}ms`);
      if (b.lcp) {
        console.log(`    LCP: ${b.lcp.time}ms (${b.lcp.element}${b.lcp.url ? ' ' + shortUrl(b.lcp.url) : ''})`);
      }

      // ── Console ──
      if (b.console?.length > 0) {
        console.log(`\n  Console (${b.console.length}):`);
        for (const line of b.console) {
          console.log(`    ${line}`);
        }
      } else {
        console.log('\n  Console: (clean)');
      }

      // ── Failed Resources ──
      if (b.failedResources?.length > 0) {
        console.log(`\n  Failed resources (${b.failedResources.length}):`);
        for (const r of b.failedResources) {
          console.log(`    ${r}`);
        }
      }

      // ── Render Blocking ──
      if (b.renderBlocking?.length > 0) {
        console.log(`\n  Render-blocking (${b.renderBlocking.length}):`);
        for (const r of b.renderBlocking) {
          console.log(`    ${shortUrl(r)}`);
        }
      }

      // ── Large Resources ──
      if (b.largeResources?.length > 0) {
        console.log(`\n  Large resources >100KB (${b.largeResources.length}):`);
        for (const r of b.largeResources) {
          console.log(`    ${formatSize(r.size).padEnd(10)} ${r.type.padEnd(8)} ${shortUrl(r.url)}`);
        }
      }

      // ── Oversized Images ──
      if (b.oversizedImages?.length > 0) {
        console.log(`\n  Oversized images (${b.oversizedImages.length}):`);
        for (const img of b.oversizedImages) {
          console.log(`    ${img.natural} served, ${img.displayed} displayed — ${shortUrl(img.src)}`);
        }
      }

      console.log('');
    } catch (err: any) {
      console.error(`Browser inspect failed: ${err.message}`);
      process.exit(1);
    }
  });
