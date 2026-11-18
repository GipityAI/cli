/**
 * `gipity load <source>` - create a brand-new project from a .gip bundle or
 * a GitHub repository.
 *
 * The counterpart of `gipity save`. Load ALWAYS creates a new project (the
 * server retries slug collisions); it never merges into an existing one. Use
 * `--inspect` to peek inside a source - metadata, contents, deploy phases,
 * and each function's permission surface - without creating anything.
 *
 * A bundle saved with `gipity save --with-data` also carries database rows:
 * the server builds the new app's database from the bundle's migrations and
 * loads them, and the summary lists each table's row count (`--inspect` shows
 * the same counts without loading anything).
 *
 * Sources:
 * - a local .gip file (from `gipity save`) - uploaded as raw zip bytes
 * - `github:owner/repo[/sub/path][@ref]` or a github.com URL - resolved
 *   server-side through the user's GitHub connection (`gipity github connect`);
 *   the CLI sends a JSON `{source}` body, no repo bytes travel through the
 *   client. Both transports feed the same import pipeline and response shapes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { get, post, postBinary, getAccountSlug } from '../api.js';
import { success, muted, warning, bold, info, brand } from '../colors.js';
import { run } from '../helpers/index.js';
import { withSpinner } from '../progress.js';
import { formatBytes } from '../adopt-cwd.js';
import { getProjectsRoot } from '../relay/paths.js';
import { finalizeLocalProject } from '../project-setup.js';

/** Server transport cap for a .gip upload - checked locally first so a too-big
 *  bundle fails in milliseconds instead of after a full upload. */
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

// ── Server response shapes (routes/projects/import.ts on the platform) ─────
interface GipMeta {
  format: string;
  format_version: number;
  name: string;
  description: string | null;
  source_project: string;
  exported_at: string;
  file_count: number;
  data?: GipDataManifest;
}
interface GipDataManifest {
  databases: Array<{ database: string; tables: Array<{ table: string; rows: number }> }>;
  rows: number;
  bytes: number;
}
interface PhaseResult { name: string; status: string; summary: string }
type DataImport =
  | { loaded: true; databases: Array<{ database: string; tables: Array<{ table: string; rows: number }> }>; rows: number; phases: PhaseResult[] }
  | { loaded: false; error: string; phases: PhaseResult[] };
interface ManifestFunctionSummary {
  name: string;
  auth?: string;
  tables?: string[];
  fetch_domains?: string[];
  services?: string[];
}
interface GipManifestSummary {
  found: boolean;
  valid: boolean;
  error?: string;
  phases: Array<{ name: string; type: string }>;
  functions: ManifestFunctionSummary[];
  hasDatabase: boolean;
}
interface InspectData {
  meta: GipMeta | null;
  fileCount: number;
  totalBytes: number;
  topLevel: string[];
  manifest: GipManifestSummary;
  data: GipDataManifest | null;
}
interface ImportData {
  project: { short_guid: string; name: string; slug: string };
  written: number;
  failed?: Array<{ path: string; error: string }>;
  manifest: GipManifestSummary;
  meta: GipMeta | null;
  data?: DataImport;
}

/** A source the server resolves via the user's GitHub connection: the
 *  `github:owner/repo[/sub/path][@ref]` shorthand or a github.com URL. */
function isGithubSource(source: string): boolean {
  return /^github:/i.test(source) || /^https?:\/\/(www\.)?github\.com\//i.test(source);
}

/** Append the recovery path when a GitHub-source call fails because the repo
 *  isn't reachable through the user's connection (not connected, or connected
 *  but this repo wasn't granted). The server's message names the problem; the
 *  hint names the fix. Re-throws always. */
function rethrowWithConnectHint(err: unknown): never {
  const e = err as { code?: string; message?: string };
  const msg = e?.message ?? '';
  if (e?.code === 'NOT_CONNECTED' || /not covered by your GitHub connection|connect github/i.test(msg)) {
    e.message = `${msg}\nRun \`gipity github connect\` to connect GitHub - re-run it any time to grant more repositories.`;
  }
  throw err;
}

function readBundle(source: string): { resolved: string; buffer: Buffer } {
  const resolved = path.resolve(
    source.startsWith('~') ? os.homedir() + source.slice(1) : source,
  );
  if (!fs.existsSync(resolved)) {
    throw new Error(`Bundle not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`${resolved} is a directory - pass a .gip file (create one with \`gipity save\`) or a github: source.`);
  }
  if (stat.size > MAX_BUNDLE_BYTES) {
    throw new Error(`Bundle is ${formatBytes(stat.size)} - over the ${formatBytes(MAX_BUNDLE_BYTES)} upload cap. Move large assets to Gipity Storage and re-save.`);
  }
  return { resolved, buffer: fs.readFileSync(resolved) };
}

/** Manifest permission surface, one line per function - what an importing user
 *  needs to see before trusting a bundle. */
function printManifest(m: GipManifestSummary): void {
  if (!m.found) {
    console.log(muted('No gipity.yaml in the source - static app (files deploy only).'));
    return;
  }
  if (!m.valid) {
    console.log(warning(`gipity.yaml is present but invalid: ${m.error ?? 'unparseable'}`));
    return;
  }
  console.log(`Deploy phases: ${m.phases.map(p => `${p.name} (${p.type})`).join(', ') || 'none'}`);
  console.log(`Database:      ${m.hasDatabase ? 'yes' : 'no'}`);
  if (m.functions.length) {
    console.log('');
    console.log(bold('Functions and permissions:'));
    const width = Math.max(...m.functions.map(f => f.name.length));
    for (const f of m.functions) {
      const parts: string[] = [`auth=${f.auth ?? 'public'}`];
      if (f.tables?.length) parts.push(`tables=${f.tables.join(',')}`);
      if (f.fetch_domains?.length) parts.push(`fetch=${f.fetch_domains.join(',')}`);
      if (f.services?.length) parts.push(`services=${f.services.join(',')}`);
      console.log(`  ${f.name.padEnd(width)}  ${muted(parts.join('  '))}`);
    }
  }
}

/** One line per table: `  database.table  N rows`. */
function printTableCounts(databases: Array<{ database: string; tables: Array<{ table: string; rows: number }> }>): void {
  const rows = databases.flatMap(db => db.tables.map(t => ({ name: `${db.database}.${t.table}`, rows: t.rows })));
  const width = Math.max(0, ...rows.map(r => r.name.length));
  for (const r of rows) console.log(`  ${r.name.padEnd(width)}  ${muted(`${r.rows} row(s)`)}`);
}

function printInspect(d: InspectData, source: string): void {
  if (d.meta) {
    console.log(bold(d.meta.name));
    if (d.meta.description) console.log(muted(d.meta.description));
    console.log(`Source:    project ${d.meta.source_project}, exported ${d.meta.exported_at}`);
  } else {
    console.log(bold(isGithubSource(source) ? source : path.basename(source)));
    console.log(muted('No Gipity bundle metadata - imports as a plain file tree.'));
  }
  console.log(`Contents:  ${d.fileCount} file(s), ${formatBytes(d.totalBytes)}`);
  console.log(`Top level: ${d.topLevel.join(', ') || '(empty)'}`);
  console.log('');
  printManifest(d.manifest);
  console.log('');
  if (d.data) {
    const tables = d.data.databases.reduce((n, db) => n + db.tables.length, 0);
    console.log(bold(`Data: ${d.data.rows} row(s) in ${tables} table(s), ${formatBytes(d.data.bytes)}`));
    printTableCounts(d.data.databases);
  } else {
    console.log(muted('Data:      none (code, migrations and seeds only)'));
  }
  console.log('');
  console.log(muted('Load it with `gipity load ' + source + '` - always creates a NEW project.'));
}

export const loadCommand = new Command('load')
  .description('Create a new app from a .gip bundle or a GitHub repo')
  .argument('<source>', 'A .gip file (from `gipity save`), github:owner/repo[/sub/path][@ref], or a github.com URL')
  .option('--name <name>', 'Name for the new project (default: the source\'s saved name)')
  .option('--inspect', 'Peek inside the source - contents, deploy phases, function permissions, saved data - without creating anything')
  .option('--json', 'Output as JSON')
  .addHelpText('after', '\nLoad always creates a NEW project - it never merges into an existing one.'
    + '\nGitHub sources need a one-time `gipity github connect` (re-run it to grant more repos).')
  .action((source: string, opts) => run('Load', async () => {
    const github = isGithubSource(source);
    if (!github && /^https?:\/\//i.test(source)) {
      throw new Error('Only GitHub URLs are supported for now - pass github:owner/repo, a github.com URL, or a local .gip file.');
    }

    // Local .gip bundles upload raw zip bytes; GitHub sources send a tiny JSON
    // body and the server pulls the tree through the user's connection.
    let sourceLabel: string;
    let doInspect: () => Promise<{ data: InspectData }>;
    let doImport: () => Promise<{ data: ImportData; partial: boolean }>;

    if (github) {
      sourceLabel = source;
      doInspect = () =>
        post<{ data: InspectData }>('/projects/inspect', { source }).catch(rethrowWithConnectHint);
      doImport = async () => {
        const body: Record<string, unknown> = { source };
        if (opts.name) body.name = opts.name;
        const res = await post<{ data: ImportData }>('/projects/import', body).catch(rethrowWithConnectHint);
        // The JSON helper hides the 201-vs-207 status; `failed` carries the
        // same signal (the server only sets it on a partial write).
        return { data: res.data, partial: !!res.data.failed?.length };
      };
    } else {
      const { resolved, buffer } = readBundle(source);
      sourceLabel = path.basename(resolved);
      doInspect = async () => (await postBinary<{ data: InspectData }>('/projects/inspect', buffer)).json;
      doImport = async () => {
        const qs = new URLSearchParams();
        if (opts.name) qs.set('name', opts.name);
        const { status, json } = await postBinary<{ data: ImportData }>(
          `/projects/import${qs.size ? `?${qs}` : ''}`, buffer,
        );
        return { data: json.data, partial: status === 207 };
      };
    }

    if (opts.inspect) {
      const res = opts.json
        ? await doInspect()
        : await withSpinner('Inspecting...', doInspect, { done: null });
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }
      printInspect(res.data, source);
      return;
    }

    const { data, partial } = opts.json
      ? await doImport()
      : await withSpinner('Importing...', doImport, { done: null });
    const project = data.project;

    // Materialize a local dir and link it, exactly like `gipity project create`:
    // `.gipity.json` is written directly inside the new dir, then a soft sync
    // pulls the imported files down.
    const dir = path.join(getProjectsRoot(), project.slug);
    fs.mkdirSync(dir, { recursive: true });

    const accountSlug = await getAccountSlug();

    const { applied } = await finalizeLocalProject({
      dir,
      projectGuid: project.short_guid,
      projectSlug: project.slug,
      projectName: project.name,
      accountSlug,
      sync: 'soft',
      interactive: false,
      json: !!opts.json,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        created: project.slug,
        name: project.name,
        guid: project.short_guid,
        dir,
        written: data.written,
        failed: data.failed,
        partial,
        applied,
        ...(data.data ? { data: data.data } : {}),
      }));
      if (data.data && !data.data.loaded) process.exitCode = 1;
      return;
    }

    console.log(success(`Created "${project.name}" (${project.slug}) from ${sourceLabel}`));
    console.log(`Wrote ${data.written} file(s) to the new project.`);
    console.log(`Initialized ${info(dir)}`);
    if (applied > 0) console.log(`Pulled ${applied} file(s) to local.`);

    if (partial || data.failed?.length) {
      console.log('');
      console.warn(warning(`Partial import - ${data.failed?.length ?? 0} file(s) could not be written:`));
      for (const f of data.failed ?? []) console.warn(warning(`  ! ${f.path}: ${f.error}`));
      console.warn(warning('The project was still created and linked; the files above are missing from it.'));
    }

    if (data.data?.loaded) {
      console.log('');
      console.log(success(`Loaded ${data.data.rows} row(s) into the app's database:`));
      printTableCounts(data.data.databases);
    } else if (data.data) {
      console.log('');
      console.warn(warning(`The bundle's rows were not loaded: ${data.data.error}`));
      console.warn(warning('The project was still created and linked, with an empty database. Delete it with `gipity project delete` and load again once the problem is fixed.'));
      process.exitCode = 1;
    }

    console.log('');
    if (data.data?.loaded) {
      // The rows went into prod (where a new app lives); a dev environment starts empty.
      console.log(`${muted('Next:')} cd ${dir} && ${brand('gipity deploy prod')}`);
      console.log(muted('The rows are in the prod database. `gipity env create dev --data` gives you a dev copy with them.'));
    } else {
      console.log(`${muted('Next:')} cd ${dir} && ${brand('gipity deploy dev')}`);
    }
  }));
