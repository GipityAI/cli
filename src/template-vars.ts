/**
 * Resolve `{{PLACEHOLDER}}` tokens in local template files at `gipity init`
 * time. Mirrors what `installTemplate` does server-side for `gipity add` —
 * keeping the two flows in sync so a template installed via the dev/CLI
 * path doesn't ship literal `{{PROJECT_GUID}}` strings to production.
 *
 * The placeholders + values match `installFromDisk` in
 * `platform/server/src/services/template.ts`. When you add or rename a key
 * there, mirror it here (and add a test).
 */
import { promises as fs, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { isSyncIgnored } from './setup.js';

export interface TemplateVars {
  /** Project's short_guid — the canonical identifier used in all API URLs. */
  projectGuid: string;
  /** Project display name, e.g. "Caption Test 05". */
  projectName: string;
  /** Optional buyer-facing description, used for <meta> tags. */
  description?: string;
  /** Account + project slugs — when both are present, {{HEAD_BLOCK}} gains the
   *  canonical URL, og:url, and absolute og:image the social crawlers need
   *  (https://app.gipity.ai/{accountSlug}/{projectSlug}/). */
  accountSlug?: string;
  projectSlug?: string;
}

/** File extensions we substitute in. Binaries (images, audio, fonts) are
 *  skipped. Anything outside this set is left untouched on disk. */
const SUBSTITUTABLE_EXTS = new Set([
  '.html', '.htm',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.css',
  '.json',
  '.yaml', '.yml',
  '.md',
  '.txt',
  '.xml',
  '.svg',
]);

/** Every placeholder the substitution recognises. Files that don't reference
 *  any of these stay untouched. Files that reference one we don't know
 *  trigger the test in `__tests__/template-vars.test.ts` so the gap surfaces
 *  loudly instead of shipping `{{X}}` literally. */
export const KNOWN_PLACEHOLDERS = [
  '{{TITLE}}',
  '{{JS_TITLE}}',
  '{{PROJECT_GUID}}',
  '{{DATABASE}}',
  '{{HEAD_BLOCK}}',
  '{{DESCRIPTION_META}}',
  '{{OG_DESCRIPTION}}',
  '{{JSON_LD_BLOCK}}',
  '{{ANALYTICS_SCRIPT}}',
] as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Accent palette + hash, mirrored from the server's `services/app-brand.ts`
 *  so the {{HEAD_BLOCK}} theme-color this path emits matches what a server
 *  install of the same project would emit. Append-only; keep in sync. */
const ACCENT_PALETTE = [
  '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1',
  '#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#84cc16', '#eab308',
];

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Blend the accent into near-black — theme-color tint (mirrors app-brand.ts). */
function darkTint(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const base = 0x101014;
  const ch = (shift: number): string => {
    const a = (n >> shift) & 0xff;
    const b = (base >> shift) & 0xff;
    return Math.round(b + (a - b) * 0.14).toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** The shared head every template's index.html carries as {{HEAD_BLOCK}}.
 *  Mirrors `buildHeadBlock` in platform `services/app-brand.ts` — same tags,
 *  same order, same indent; keep the two in sync. */
function buildHeadBlock(v: TemplateVars): string {
  const t = escapeHtml(v.projectName);
  const d = v.description ? escapeHtml(v.description) : '';
  const url = v.accountSlug && v.projectSlug
    ? `https://app.gipity.ai/${v.accountSlug}/${v.projectSlug}/`
    : undefined;
  const themeColor = darkTint(ACCENT_PALETTE[hashString(v.projectGuid || v.projectName) % ACCENT_PALETTE.length]);
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: v.projectName,
    ...(v.description ? { description: v.description } : {}),
    ...(url ? { url } : {}),
  }, null, 2).replace(/<\//g, '<\\/');

  const lines: string[] = [
    `<title>${t}</title>`,
    ...(d ? [`<meta name="description" content="${d}">`] : []),
    ...(url ? [`<link rel="canonical" href="${url}">`] : []),
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:type" content="website">`,
    ...(d ? [`<meta property="og:description" content="${d}">`] : []),
    ...(url ? [
      `<meta property="og:url" content="${url}">`,
      `<meta property="og:image" content="${url}images/og-image.png">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
    ] : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    ...(d ? [`<meta name="twitter:description" content="${d}">`] : []),
    ...(url ? [`<meta name="twitter:image" content="${url}images/og-image.png">`] : []),
    `<meta name="theme-color" content="${themeColor}">`,
    `<link rel="icon" type="image/png" sizes="192x192" href="./images/favicon-192.png">`,
    `<link rel="icon" type="image/png" sizes="512x512" href="./images/favicon-512.png">`,
    `<link rel="icon" type="image/x-icon" href="./images/favicon.ico">`,
    `<link rel="apple-touch-icon" href="./images/apple-touch-icon.png">`,
    `<link rel="manifest" href="./manifest.webmanifest">`,
    `<script type="application/ld+json">\n${jsonLd}\n  </script>`,
  ];
  return lines.map(l => `\n  ${l}`).join('');
}

/** Build the substitution map. Pure — easy to unit-test. */
export function buildTemplateVars(v: TemplateVars): Record<string, string> {
  const safeTitle = escapeHtml(v.projectName);
  const safeDesc = v.description ? escapeHtml(v.description) : '';
  const slug = v.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'my_app';
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: v.projectName,
    ...(v.description ? { description: v.description } : {}),
  }, null, 2).replace(/<\//g, '<\\/');

  return {
    '{{TITLE}}': safeTitle,
    '{{JS_TITLE}}': jsEscape(v.projectName),
    '{{PROJECT_GUID}}': v.projectGuid,
    '{{DATABASE}}': slug,
    '{{HEAD_BLOCK}}': buildHeadBlock(v),
    // Legacy per-tag placeholders — current templates carry only {{HEAD_BLOCK}},
    // but older local template copies may still reference these.
    '{{DESCRIPTION_META}}': v.description ? `\n  <meta name="description" content="${safeDesc}">` : '',
    '{{OG_DESCRIPTION}}': v.description ? `\n  <meta property="og:description" content="${safeDesc}">` : '',
    '{{JSON_LD_BLOCK}}': `<script type="application/ld+json">\n${jsonLd}\n  </script>`,
    // `crossorigin="anonymous"` so SDK errors surface with a real message/stack
    // (CORS mode) instead of a sanitized message-less "Script error". The CDN
    // returns Access-Control-Allow-Origin:*, so it works on any app domain.
    '{{ANALYTICS_SCRIPT}}': `<script defer crossorigin="anonymous" src="https://media.gipity.ai/client/v1/gipity.js" data-app="${v.projectGuid}"></script>`,
  };
}

/** Pure string substitution — exported so the test can exercise it without
 *  touching the filesystem. */
export function substituteString(content: string, vars: Record<string, string>): string {
  let out = content;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(key, value);
  }
  return out;
}

export interface SubstituteDirResult {
  /** Files that contained at least one known placeholder and were rewritten. */
  changed: string[];
  /** Files that still contain a `{{...}}` pattern after substitution — these
   *  reference a placeholder we don't know about. Caller should warn. */
  unresolved: { path: string; tokens: string[] }[];
}

/** Yield text-file relative paths under `root`, respecting isSyncIgnored.
 *  Inline because we want a simpler walker than sync.ts's (no baseline, no
 *  hashing) — just rel-paths we'll read+rewrite. */
function* walkTextFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (isSyncIgnored(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          if (!statSync(full).isFile()) continue;
        } catch { continue; }
        yield relative(root, full).replace(/\\/g, '/');
      }
    }
  }
}

/** Walk `dir` (respecting the project's sync-ignore rules), substitute every
 *  known placeholder in text files, and write the result back. Files without
 *  placeholders are not touched. Files with unknown placeholders are logged. */
export async function substituteDir(dir: string, vars: TemplateVars): Promise<SubstituteDirResult> {
  const lookup = buildTemplateVars(vars);
  const knownKeys = new Set(Object.keys(lookup));
  const changed: string[] = [];
  const unresolved: { path: string; tokens: string[] }[] = [];

  for (const rel of walkTextFiles(dir)) {
    const ext = extname(rel).toLowerCase();
    if (!SUBSTITUTABLE_EXTS.has(ext)) continue;
    const abs = join(dir, rel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    // Quick check before doing replacement work — most files don't have any.
    if (!content.includes('{{')) continue;

    const next = substituteString(content, lookup);
    if (next !== content) {
      await fs.writeFile(abs, next, 'utf-8');
      changed.push(rel);
    }

    // Flag any remaining `{{X}}` patterns whose key we don't know about —
    // this is the test signal that the placeholder set is out of date.
    const leftover = next.match(/\{\{[A-Z_]+\}\}/g);
    if (leftover) {
      const unknown = Array.from(new Set(leftover)).filter(k => !knownKeys.has(k));
      if (unknown.length) unresolved.push({ path: rel, tokens: unknown });
    }
  }

  return { changed, unresolved };
}
