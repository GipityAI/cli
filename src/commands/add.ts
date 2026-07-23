import fs from 'fs';
import path from 'path';
import os from 'os';
import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { sync } from '../sync.js';
import { success, muted, bold, warning, error as clrError } from '../colors.js';
import { run } from '../helpers/index.js';
import { createProgressReporter, withSpinner } from '../progress.js';

// Catalog GENERATED from platform/packages/shared (TEMPLATES + KITS cliHint
// fields) into src/catalog.ts by platform/scripts/build-knowledge.ts - the CLI
// ships as a standalone npm package and can't depend on the private shared
// workspace. The hand-mirrored copy that used to live here silently dropped
// every new catalog entry; edit constants.ts + `just build-knowledge` instead.
//
// Templates install a whole app (blank wiring or a working starter demo).
// Kits are reusable building blocks added into an existing app's src/packages/.
import { STARTERS, BLANK, KITS, type CatalogEntry } from '../catalog.js';

// The catalog block, rendered once and reused by the full help output
// (`gipity add` / `gipity add --help`) and the bare listing (`gipity add
// --list`) so they can never drift. Three sections, one entry per line, keys
// column-aligned. No leading/trailing blank lines - callers add surrounding
// whitespace.
function catalogText(): string {
  const width = Math.max(...[...STARTERS, ...BLANK, ...KITS].map(e => e.key.length));
  const row = (e: CatalogEntry) => `  ${e.key.padEnd(width)}  ${muted(e.hint)}`;
  const section = (title: string, blurb: string, entries: CatalogEntry[]) =>
    [`${bold(title)}  ${muted('- ' + blurb)}`, ...entries.map(row)].join('\n');
  return [
    'Names to pass to `gipity add <name>`:',
    section('Templates (working demos)', 'complete apps to run, then extend or replace', STARTERS),
    section('Templates (blank wiring)', 'minimal framework setup - build your app on top', BLANK),
    section('Kits', 'building blocks to add into an app you already scaffolded', KITS),
  ].join('\n\n');
}

/** Pack names onto as few lines as possible. A scaffold prints 16-40 paths;
 *  one per line pushed the success line and the notes past the ~30 lines an
 *  agent keeps when it defensively pipes the install through `tail`. */
function packNames(names: string[], width = 96): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const n of names) {
    if (cur && cur.length + 1 + n.length > width) { lines.push(cur); cur = ''; }
    cur = cur ? `${cur} ${n}` : n;
  }
  if (cur) lines.push(cur);
  return lines;
}

// The files a freshly scaffolded app is meant to be read in order of, most
// orienting first. Every template file carries header comments describing the
// contract it establishes (the injected SDK, apiBase stamping, theme tokens,
// the permissions block), but nothing said WHICH files those are - so agents
// re-opened the whole scaffold to find out. Only paths the install actually
// wrote are printed, so this never points at a file that isn't there.
const ORIENTATION_FILES = [
  'README.md',
  'gipity.yaml',
  'src/index.html',
  'src/js/main.js',
  'src/css/styles.css',
];

interface AddResponse {
  kind: 'template' | 'kit';
  files: string[];
  title?: string;
  type?: string;
  kit?: string;
  notes?: string[];
  /** Present when the install partially failed (server responds HTTP 207): the
   *  files that could not be written, with the per-file error. The rest of the
   *  install still landed. */
  failed?: Array<{ path: string; error: string }>;
}

// ─── Local-path payload mode ────────────────────────────────────────────────
//
// `gipity add ./path/to/template` walks a directory and ships the contents to
// the server as a JSON payload, instead of asking the server to look the name
// up in its bundled catalog. This is the dev loop for template authors: you
// can iterate on `registry/templates/<name>/` and push to a real app without
// having to redeploy the server.
//
// The server-side wire shape this builds matches addSchema.files in
// platform/server/src/routes/projects/add.ts (same field names, same encoding
// discriminator).

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.markdown', '.txt', '.csv', '.xml', '.svg',
  '.py', '.sh', '.bash', '.sql',
  '.env', '.gitignore', '.dockerignore',
]);
// Anything not in TEXT_EXTENSIONS gets base64 - safer than guessing. The
// server-side BINARY_MIME table maps the extension back to a content-type.

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.vite',
  '.gipity',  // local project state dir - never belongs in a template payload
]);
const SKIP_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;  // 25 MB (server caps body at 30 MB)
const MAX_FILES = 500;

function looksLikePath(name: string): boolean {
  // ./ or ../ or absolute / or ~/ - and any string that already contains a
  // separator (cross-platform: forward or back slash). Bare catalog keys like
  // "web-simple" or "karaoke-captions" hit the server lookup path; anything
  // that walks a filesystem hits payload mode.
  return /^[./~]/.test(name) || name.includes('/') || name.includes('\\');
}

function resolveLocalPath(input: string): string {
  if (input.startsWith('~')) return path.resolve(os.homedir() + input.slice(1));
  return path.resolve(input);
}

interface PayloadFile { path: string; content: string; encoding: 'utf8' | 'base64'; }

/** Sniff whether a local-path payload is a kit or a template, mirroring the
 *  server-side sniff in routes/projects/add.ts. Templates ship `gipity.yaml`
 *  at the root; kits ship `package.json` with a `gipity.install` block. The
 *  CLI sends the result as a `kind` hint so the server doesn't have to
 *  re-do the sniff on the encoded payload. */
function sniffPayloadKind(files: PayloadFile[]): 'template' | 'kit' {
  const pkg = files.find(f => f.path === 'package.json');
  if (!pkg) return 'template';
  if (pkg.encoding !== 'utf8') return 'template';  // base64'd package.json would be weird; default to template
  try {
    const manifest = JSON.parse(pkg.content);
    if (manifest?.gipity?.install) return 'kit';
  } catch { /* fall through */ }
  return 'template';
}

function buildLocalPayload(rootDir: string): { name: string; files: PayloadFile[] } {
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }
  const files: PayloadFile[] = [];
  let totalBytes = 0;

  function walk(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;  // skip symlinks, sockets, etc.
      if (SKIP_FILE_NAMES.has(entry.name)) continue;
      if (files.length >= MAX_FILES) {
        throw new Error(`Too many files (>${MAX_FILES}). Trim the template or raise the server cap.`);
      }
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const ext = path.extname(entry.name).toLowerCase();
      const buf = fs.readFileSync(fullPath);
      const isText = TEXT_EXTENSIONS.has(ext);
      const content = isText ? buf.toString('utf8') : buf.toString('base64');
      const encoding: 'utf8' | 'base64' = isText ? 'utf8' : 'base64';
      totalBytes += content.length;
      if (totalBytes > MAX_PAYLOAD_BYTES) {
        throw new Error(`Payload exceeds ${Math.round(MAX_PAYLOAD_BYTES / 1024 / 1024)} MB cap.`);
      }
      files.push({ path: relPath, content, encoding });
    }
  }
  walk(rootDir, '');

  return { name: path.basename(rootDir), files };
}

export const addCommand = new Command('add')
  .description('Add a template or kit')
  .argument('[name]', 'Template/kit key, OR a local directory path (./, ~/, or /abs). Omit for help; use --list for just the catalog.')
  .option('--title <title>', 'App title - templates only (defaults to project name)')
  .option('--description <desc>', 'App description for meta tags - templates only')
  .option('--force', 'Templates only: install into a non-empty project (same-named files get a new version; other files are kept)')
  .option('--list', 'List the template/kit catalog and exit')
  .option('--json', 'Output as JSON')
  .addHelpText('after', () => catalogText() + '\n\n'
    + muted('Local path  gipity add ./dir  (or ~/path, /abs) - template or kit, auto-detected'))
  .action((name: string | undefined, opts, command: Command) => run('Add', async () => {
    // `--list` is a bare catalog dump; no project/config needed.
    if (opts.list) {
      if (opts.json) {
        console.log(JSON.stringify({ templates: { starters: STARTERS, blank: BLANK }, kits: KITS }));
      } else {
        console.log(catalogText());
      }
      return;
    }
    // No name is a usage error, not a help request: error + help on STDERR and
    // a nonzero exit. (It used to outputHelp() to stdout and exit 0, which an
    // agent piping through `tail` reads as a successful add that printed
    // help-shaped output.)
    if (!name) {
      console.error(clrError('Missing template or kit name. Usage: gipity add <name>  (see the catalog below, or `gipity add --list`)'));
      command.outputHelp({ error: true });
      process.exitCode = 1;
      return;
    }
    const config = requireConfig();

    // Local-path payload mode kicks in when `name` looks like a path - bare
    // names still go through the server's bundled catalog like before.
    let body: Record<string, unknown>;
    if (looksLikePath(name)) {
      const resolved = resolveLocalPath(name);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Local template/kit not found: ${resolved}`);
      }
      const { name: labelName, files } = buildLocalPayload(resolved);
      const kind = sniffPayloadKind(files);
      // Progress goes to stderr so `gipity add … --json` keeps stdout pure JSON.
      console.error(muted(`Uploading ${files.length} file(s) from ${resolved} (${kind}) ...`));
      body = {
        name: labelName,
        title: opts.title,
        description: opts.description,
        force: opts.force,
        files,
        kind,
      };
    } else {
      body = {
        name,
        title: opts.title,
        description: opts.description,
        force: opts.force,
      };
    }

    // The server runs the whole install pipeline before responding; animate the
    // wait, then clear the spinner so the installed-files list is the result.
    // The spinner is TTY-only, so piped/agent transcripts would otherwise show
    // a silent multi-second gap (favicon generation on a cold cache can take
    // ~10s, cli#117) - leave one stderr marker so the wait reads as work.
    // Favicons are generated for templates only, so don't claim them on a kit
    // install (kits are quick; the slow first-add path is template scaffolding).
    if (!opts.json && !process.stdout.isTTY) {
      const isKit = KITS.some(k => k.key === name);
      console.error(muted(isKit
        ? 'Installing kit (server-side install pipeline, ~1-2s)...'
        : 'Installing (server writes files + generates favicons, ~5-10s)...'));
    }
    const doAdd = () => post<{ data: AddResponse }>(`/projects/${config.projectGuid}/add`, body);
    const res = opts.json
      ? await doAdd()
      : await withSpinner('Installing...', doAdd, { done: null });

    // Pull the created/installed files down to local.
    const syncResult = await sync({ interactive: false, progress: opts.json ? undefined : createProgressReporter() });
    const data = res.data;

    if (opts.json) {
      console.log(JSON.stringify({ ...data, synced: syncResult.applied }));
      return;
    }

    if (data.kind === 'kit') {
      console.log(success(`Added the "${data.kit}" kit - ${data.files.length} file(s):`));
    } else {
      console.log(success(`Scaffolded "${data.title}" (${data.type}) - ${data.files.length} files:`));
    }
    for (const line of packNames(data.files)) console.log(line);
    // Point at the files that teach this app's conventions, so the next step is
    // one targeted read instead of re-opening the whole scaffold to find them.
    const startHere = data.kind === 'kit'
      ? data.files.filter(f => /(^|\/)README\.md$/.test(f))
      : ORIENTATION_FILES.filter(f => data.files.includes(f));
    if (startHere.length) {
      console.log('');
      console.log(muted(`Start here - their header comments carry the conventions you build inside: ${startHere.join('  ')}`));
    }
    if (data.notes?.length) {
      console.log('');
      for (const n of data.notes) console.log(n);
    }
    // Partial install (server HTTP 207): some files were dropped. Surface them so
    // the user knows the install is incomplete rather than reading a clean success.
    if (data.failed?.length) {
      console.log('');
      console.warn(warning(`${data.failed.length} file(s) failed to install:`));
      for (const f of data.failed) console.warn(warning(`  ! ${f.path}: ${f.error}`));
      console.warn(warning(`Re-run \`gipity add ${data.kit ?? name}${opts.force ? ' --force' : ''}\` to retry the dropped files.`));
    }
    // After scaffolding an app, point at kits as the next step - they add
    // features (multiplayer, etc.) into the app you just created. Keys only:
    // one wrapped line keeps the whole install report short enough to read
    // without truncating, and `gipity add --list` has the per-kit blurbs.
    if (data.kind !== 'kit' && KITS.length > 0) {
      console.log('');
      console.log(muted('Add features with kits (gipity add <kit>, gipity add --list for what each does):'));
      for (const line of packNames(KITS.map(k => k.key))) console.log(muted(`  ${line}`));
    }
    if (syncResult.applied > 0) {
      console.log(`\nPulled ${syncResult.applied} files to local.`);
    }
  }));
