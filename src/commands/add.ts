import fs from 'fs';
import path from 'path';
import os from 'os';
import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { sync } from '../sync.js';
import { success, muted, bold } from '../colors.js';
import { run } from '../helpers/index.js';

// Catalog mirrored from platform/packages/shared (TEMPLATES + KITS) -
// the CLI ships as a standalone npm package and can't depend on the private
// shared workspace. Keep these lists in sync when catalog entries change.
//
// Templates install a whole app (blank wiring or a working starter demo).
// Kits are reusable building blocks added into an existing app's src/packages/.
const TEMPLATES = ['web-simple', '3d-engine'];
const STARTERS = ['web-fullstack', 'web-vision-cam', '2d-game', '3d-world', 'api'];
const HIDDEN = [{ key: 'app-itsm', hint: 'IT service management / helpdesk / ticketing' }];
const KITS = [
  { key: 'realtime', hint: 'multiplayer / presence / shared state' },
  { key: 'web-vision-mediapipe', hint: 'browser camera vision - gesture, pose, object detection' },
];

function printCatalog(): void {
  console.log('');
  console.log(`${bold('Templates')}  ${muted('- install a whole app into an empty project')}`);
  console.log(`  ${TEMPLATES.join(', ')}  ${muted('(blank wiring)')}`);
  console.log(`  ${STARTERS.join(', ')}  ${muted('(working demos)')}`);
  console.log('');
  console.log(`${bold('Kits')}  ${muted('- add a reusable building block into an existing app')}`);
  for (const k of KITS) console.log(`  ${k.key}  ${muted('- ' + k.hint)}`);
  console.log('');
  console.log(`${bold('Local path')}  ${muted('- install from a directory on disk (template or kit)')}`);
  console.log(`  ${muted('gipity add ./path/to/template  (or ~/path, /abs/path)')}`);
  console.log(`  ${muted('gipity add ./path/to/kit       (auto-detected via package.json gipity.install)')}`);
  console.log('');
  console.log(muted('Usage: gipity add <name|path> [--title <t>] [--description <d>] [--force]'));
  console.log('');
}

interface AddResponse {
  kind: 'template' | 'kit';
  files: string[];
  title?: string;
  type?: string;
  kit?: string;
  notes?: string[];
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
  .description('Add a template (scaffold an app) or a kit (reusable building block) to the project. Pass ./path/to/dir to install a local template directly.')
  .argument('[name]', 'Template/kit key, OR a local directory path (./, ~/, or /abs). Omit to list the catalog.')
  .option('--title <title>', 'App title - templates only (defaults to project name)')
  .option('--description <desc>', 'App description for meta tags - templates only')
  .option('--force', 'Templates only: overwrite any colliding files')
  .option('--json', 'Output as JSON')
  .action((name: string | undefined, opts) => run('Add', async () => {
    if (!name) {
      printCatalog();
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
      console.log(muted(`Uploading ${files.length} file(s) from ${resolved} (${kind}) ...`));
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

    const res = await post<{ data: AddResponse }>(`/projects/${config.projectGuid}/add`, body);

    // Pull the created/installed files down to local.
    const syncResult = await sync({ interactive: false });
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
    for (const f of data.files) console.log(`  ${f}`);
    if (data.notes?.length) {
      console.log('');
      for (const n of data.notes) console.log(n);
    }
    // After scaffolding an app, point at kits as the next step - they add
    // features (multiplayer, etc.) into the app you just created.
    if (data.kind !== 'kit' && KITS.length > 0) {
      console.log('');
      console.log(muted('Add features with kits (gipity add <kit>):'));
      for (const k of KITS) console.log(muted(`  ${k.key}  - ${k.hint}`));
    }
    if (syncResult.applied > 0) {
      console.log(`\nPulled ${syncResult.applied} files to local.`);
    }
  }));
