import { Command } from 'commander';
import { createHash } from 'crypto';
import { brand, bold, muted, success, warning, error as clrError } from '../colors.js';
import { formatSize } from '../utils.js';
import { run } from '../helpers/index.js';

// `gipity page fetch` - verify deployed non-rendered files (llms.txt, AGENTS.md,
// SKILL.md, robots.txt, agent.json, served JSON, …). `page inspect` only sees
// the rendered DOM, so it can't tell you these exist. The trap this command
// exists to kill: static hosting serves index.html for unknown paths, so a
// missing file comes back as a 200 (HTML), and a bare status check passes on a
// file that was never deployed. We learn the host's catch-all shell with one
// negative probe, then give a real per-file verdict instead of trusting the code.

type Verdict = 'OK' | 'MISSING' | 'WRONG-TYPE';

interface FileResult {
  path: string;
  url: string;
  status: number | null; // null = network error (host unreachable)
  contentType: string | null;
  bytes: number;
  verdict: Verdict;
  detail: string;
}

interface ProbeSig {
  // The host returned a 2xx body for a path that cannot exist → it has a
  // catch-all (SPA-style) fallback, and that body IS the shell.
  served: boolean;
  status: number;
  sha256: string | null;
  isHtml: boolean;
}

interface RawResponse {
  status: number;
  contentType: string | null;
  body: string;
}

/** Expected content category by filename/extension; null = no expectation. */
type Expect = 'text' | 'json' | 'xml' | 'html' | null;

function expectedType(path: string): Expect {
  const p = path.toLowerCase().split('?')[0].split('#')[0];
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.xml')) return 'xml';
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'html';
  if (p.endsWith('.txt') || p.endsWith('.md') || p.endsWith('.markdown')) return 'text';
  return null;
}

function contentTypeMatches(expect: Expect, ct: string | null): boolean {
  if (!expect || !ct) return true; // no expectation, or host sent no type → don't flag
  const c = ct.toLowerCase();
  switch (expect) {
    case 'json': return c.includes('application/json');
    case 'xml': return c.includes('xml');
    case 'html': return c.includes('text/html');
    case 'text': return c.includes('text/plain') || c.includes('text/markdown');
  }
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 300).toLowerCase();
  return /<!doctype html|<html[\s>]/.test(head);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function baseWithSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

/** Resolve a file path against the app base, keeping the app's subpath. */
function resolveUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), baseWithSlash(base)).toString();
}

async function fetchRaw(url: string): Promise<RawResponse | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type'), body };
  } catch {
    return null; // DNS failure, connection refused, etc.
  }
}

/** Hit a guaranteed-absent path to learn whether the host serves a catch-all shell. */
async function probeShell(base: string): Promise<ProbeSig> {
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const r = await fetchRaw(resolveUrl(base, `__gipity_probe_${rand}.notreal`));
  if (!r) return { served: false, status: 0, sha256: null, isHtml: false };
  return {
    served: r.status >= 200 && r.status < 300,
    status: r.status,
    sha256: sha256(r.body),
    isHtml: looksLikeHtml(r.body),
  };
}

function classify(path: string, r: RawResponse | null, shell: ProbeSig): Omit<FileResult, 'path' | 'url'> {
  if (!r) return { status: null, contentType: null, bytes: 0, verdict: 'MISSING', detail: 'fetch failed (host unreachable)' };

  const bytes = Buffer.byteLength(r.body);
  const base = { status: r.status, contentType: r.contentType, bytes };

  // Honest 404/5xx - the file simply isn't there.
  if (r.status >= 400) return { ...base, verdict: 'MISSING', detail: `HTTP ${r.status}` };

  const expect = expectedType(path);

  // 1) Served the catch-all shell verbatim → 200, but the file isn't deployed.
  if (shell.served && shell.sha256 && sha256(r.body) === shell.sha256) {
    return { ...base, verdict: 'MISSING', detail: `HTTP ${r.status} but served the SPA shell (file not deployed)` };
  }
  // 2) Asked for a non-HTML asset but got an HTML body → a per-path shell variant.
  if (expect && expect !== 'html' && looksLikeHtml(r.body)) {
    return { ...base, verdict: 'MISSING', detail: `HTTP ${r.status} but got HTML where ${expect} expected (SPA shell)` };
  }
  // 3) Present and real, but the content-type header disagrees with the extension.
  if (expect && !contentTypeMatches(expect, r.contentType)) {
    return { ...base, verdict: 'WRONG-TYPE', detail: `expected ${expect}, served as ${r.contentType ?? '(none)'}` };
  }
  return { ...base, verdict: 'OK', detail: r.contentType ?? '' };
}

const TAG: Record<Verdict, string> = {
  'OK': success('OK        '),
  'MISSING': clrError('MISSING   '),
  'WRONG-TYPE': warning('WRONG-TYPE'),
};

export const pageFetchCommand = new Command('fetch')
  .description('Verify deployed non-rendered files (llms.txt, AGENTS.md, robots.txt, served JSON...) really exist - catches the static-host trap where a missing file returns 200 with the SPA shell instead of a 404')
  .argument('<url>', 'Deployed app base URL; file paths resolve relative to it')
  .argument('<paths...>', 'One or more file paths to verify, e.g. llms.txt AGENTS.md robots.txt')
  .option('--json', 'Output as JSON')
  .action((url: string, paths: string[], opts: { json?: boolean }) => run('Page fetch', async () => {
    const shell = await probeShell(url);

    const results: FileResult[] = [];
    for (const p of paths) {
      const target = resolveUrl(url, p);
      const c = classify(p, await fetchRaw(target), shell);
      results.push({ path: p, url: target, ...c });
    }
    const failed = results.filter((r) => r.verdict !== 'OK');

    if (opts.json) {
      console.log(JSON.stringify({
        base: baseWithSlash(url),
        shellFallback: shell.served,
        ok: failed.length === 0,
        failed: failed.length,
        files: results,
      }));
      if (failed.length) process.exitCode = 1;
      return;
    }

    console.log(`${brand('Page fetch')} ${bold(baseWithSlash(url))}`);
    if (shell.served) {
      console.log(`${muted('Host serves a catch-all shell for unknown paths - a bare 200 is not proof; verifying bodies.')}`);
    }

    const pad = Math.min(48, Math.max(...results.map((r) => r.path.length)));
    for (const r of results) {
      const size = r.verdict === 'OK' ? muted(formatSize(r.bytes).padStart(9)) : ' '.repeat(9);
      const detail = r.detail && r.verdict !== 'OK' ? muted(`  ${r.detail}`) : '';
      console.log(`${TAG[r.verdict]} ${r.path.padEnd(pad)} ${size}${detail}`);
    }

    console.log(
      failed.length === 0
        ? `\n${success(`✓ all ${results.length} file(s) present with the right content-type`)}`
        : `\n${clrError(`✗ ${failed.length} of ${results.length} file(s) missing or wrong-type`)}`,
    );
    if (failed.length) process.exitCode = 1;
  }));
