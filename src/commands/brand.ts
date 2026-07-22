/**
 * `gipity brand` - view or change the app's generated visual identity:
 * favicons, the iOS Home Screen icon, the PWA manifest, and the 1200x630
 * social share card (og-image) that X/iMessage/Slack show when the app's
 * URL is shared.
 *
 * The default identity is deterministic (accent color from the project guid,
 * glyph from the title's first character, small Gipity egg badge). `brand set`
 * overrides pieces of it - most usefully the glyph (an emoji reads far more
 * "this is my app" than a letter) and the accent color - then regenerates
 * every asset server-side in one shot. Deploy afterwards to publish.
 */
import { Command } from 'commander';
import { get, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { bold, muted, success } from '../colors.js';
import { run } from '../helpers/index.js';

interface BrandData {
  branding: Record<string, string>;
  resolved: { accent: string; themeColor: string; glyph: string; isEmoji: boolean };
  files?: string[];
  assets?: string[];
}

function printBrand(d: BrandData): void {
  console.log(`${bold('Glyph:')}  ${d.resolved.glyph}${d.resolved.isEmoji ? muted(' (emoji)') : ''}`);
  console.log(`${bold('Accent:')} ${d.resolved.accent}${d.branding.primary_color ? '' : muted(' (derived from project)')}`);
  if (d.branding.app_name) console.log(`${bold('Name:')}   ${d.branding.app_name}`);
  if (d.branding.tagline) console.log(`${bold('Tagline:')} ${d.branding.tagline}`);
}

const DEPLOY_HINT = 'Deploy to publish the new assets: gipity deploy dev';

export const brandCommand = new Command('brand')
  .description("The app's generated icons + share card (favicons, iOS icon, og-image)")
  .addHelpText('after', `
Examples:
  gipity brand                                Show the current brand
  gipity brand set --emoji 🦍                 Emoji icon + share card, regenerate all assets
  gipity brand set --glyph R --color "#3b82f6"  Letter glyph on a blue accent
  gipity brand set --tagline "Bananas at 60fps"  Subtitle on the share card
  gipity brand apply                          Re-render assets from the stored brand
  gipity brand apply --fix-head               Migrate an older app: assets + splice the
                                              share/SEO tags into src/index.html

Assets are generated server-side into src/images/ (+ src/manifest.webmanifest)
and are versioned like any other file - rollback restores previous ones.`);

brandCommand
  .command('show', { isDefault: true })
  .description('Show the stored brand and the resolved render spec')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Brand', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const res = await get<{ data: BrandData }>(`/projects/${config.projectGuid}/brand`);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    printBrand(res.data);
    console.log(muted(`\nAssets: ${(res.data.assets ?? []).join(', ')}`));
    console.log(muted(`Change it: gipity brand set --emoji 🎨 | --glyph A | --color "#RRGGBB" | --tagline "..."`));
  }));

brandCommand
  .command('set')
  .description('Change brand fields and regenerate all assets')
  .option('--emoji <emoji>', 'Emoji glyph for the icon + share card (e.g. 🦍)')
  .option('--glyph <char>', 'Letter/digit glyph (alias of --emoji, any single character)')
  .option('--color <hex>', 'Accent color, #RRGGBB')
  .option('--name <name>', 'Display name override (og/share title stays the page title)')
  .option('--tagline <text>', 'One-line subtitle on the share card (max 120 chars)')
  .option('--fix-head', 'Also splice the share/SEO head block into src/index.html (for apps installed before templates shipped it)')
  .option('--no-regenerate', 'Store the fields without re-rendering assets')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Brand', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const body: Record<string, unknown> = {};
    const glyph = opts.emoji ?? opts.glyph;
    if (glyph) body.icon_glyph = glyph;
    if (opts.color) body.primary_color = opts.color;
    if (opts.name) body.app_name = opts.name;
    if (opts.tagline) body.tagline = opts.tagline;
    if (opts.regenerate === false) body.regenerate = false;
    if (opts.fixHead) body.fix_head = true;
    if (!glyph && !opts.color && !opts.name && !opts.tagline) {
      console.error('Nothing to set - pass --emoji, --glyph, --color, --name, or --tagline. (gipity brand set --help; use gipity brand apply to just re-render)');
      process.exitCode = 1;
      return;
    }
    const res = await post<{ data: BrandData }>(`/projects/${config.projectGuid}/brand`, body);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    printBrand(res.data);
    reportFiles(res.data.files ?? []);
  }));

brandCommand
  .command('apply')
  .description('Re-render all brand assets from the stored brand (no field changes)')
  .option('--fix-head', 'Also splice the share/SEO head block into src/index.html (for apps installed before templates shipped it)')
  .option('--project <guid-or-slug>', 'Target a specific project instead of cwd / Home')
  .option('--json', 'Output raw JSON')
  .action((opts) => run('Brand', async () => {
    const { config } = await resolveProjectContext({ projectOverride: opts.project });
    const body: Record<string, unknown> = opts.fixHead ? { fix_head: true } : {};
    const res = await post<{ data: BrandData }>(`/projects/${config.projectGuid}/brand`, body);
    if (opts.json) { console.log(JSON.stringify(res.data)); return; }
    reportFiles(res.data.files ?? []);
  }));

function reportFiles(files: string[]): void {
  if (!files.length) {
    console.log(muted('\nStored (assets not regenerated - run gipity brand apply).'));
    return;
  }
  console.log(success(`\n✓ Regenerated ${files.length} asset${files.length === 1 ? '' : 's'}.`));
  if (files.includes('src/index.html')) {
    console.log(success('✓ src/index.html head updated (page title/description preserved).'));
  }
  console.log(muted(`  ${DEPLOY_HINT}`));
}
