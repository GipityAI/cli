// ── Gipity CLI Startup Banner ──────────────────────────────────────────
// Two-panel box showing all AI models, platform tools, and sandbox capabilities.

import { brand, bold, faint, muted } from './colors.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface BannerOptions {
  version: string;
  email?: string;
  cwd?: string;
}

// ── Static content ─────────────────────────────────────────────────────

// ── Feature groups ────────────────────────────────────────────────────

const AI_MODELS = [
  'OpenAI', 'Anthropic', 'Gemini', 'ElevenLabs', 'Black Forest Labs',
];

const GENERATION = [
  'Image', 'Video', 'Music', 'Speech / TTS', 'Sound',
];

const AGENT = [
  'Memory', 'Conversations', 'Plans', 'Schedules', 'Soul',
];

const AUTOMATION = [
  'Workflows', 'Triggers', 'Webhooks', 'Approvals',
];

const INTEGRATIONS = [
  '5,000+ Skills', 'Gmail', 'Calendar', 'Twitter', 'Telegram',
];

const DATA = [
  'Database', 'Records API', 'RBAC', 'Audit Trail', 'Soft Deletes',
];

const SECURITY = [
  'Auth', 'API Keys', 'Secrets', 'Rate Limiting', 'Env Vars',
];

const APP_BUILDING = [
  'API', 'Templates', 'Functions', 'Multiplayer', 'Media Assets', 'SLA',
];

const UTILITIES = [
  'Sandbox', 'Compile', 'File Conversion', 'Doc Gen', 'OCR',
  'Data Processing', 'Data Viz', 'Image Processing', 'PDF Tools',
  'Audio Processing', 'Transcode', 'SVG Tracing', 'QR Codes', 'Archives',
  'Metadata',
];

const INFRASTRUCTURE = [
  'Compute', 'CDN', 'Storage', 'Inference', 'Hosting',
  'Deploy', 'Uploads', 'Rollback',
];

// ── Egg color palette (shared) — gradient built around #FEA60E ───────
const _hi = (s: string) => `\x1b[38;2;255;215;80m${s}\x1b[39m`;  // golden highlight
const _lt = (s: string) => `\x1b[38;2;254;190;45m${s}\x1b[39m`;  // light
const _br = (s: string) => `\x1b[38;2;254;166;14m${s}\x1b[39m`;  // base — #FEA60E
const _md = (s: string) => `\x1b[38;2;218;112;8m${s}\x1b[39m`;   // medium-dark
const _sh = (s: string) => `\x1b[38;2;170;68;4m${s}\x1b[39m`;    // shadow

// Wobbly egg — asymmetric left/right, organic feel (8 rows)
// Widths: 6 → 8 → 10 → 12 → 14 → 12 → 10 → 8  |  Widest at row 5/8 (62%)
function eggWobbly(): string[] {
  return [
    _lt('▗▄') + _br('██') + _md('▄▖'),                        //  6 — narrow top
    _lt('▟') + _hi('█') + _br('████') + _md('█▙'),            //  8 — subtle highlight
    _lt('▐') + _br('██████') + _md('██▌'),                     // 10 — expanding
    _br('▟████████') + _md('██') + _sh('▙'),                   // 12 — smooth curve left, step right
    _br('▐███████') + _md('███') + _sh('██▌'),                 // 14 — widest
    _br('▜██████') + _md('███') + _sh('█▌'),                   // 12 — left tapers, right stays
    _md('▜██████') + _sh('██▛'),                               // 10 — both taper
    _md('▝▀') + _sh('████▀▘'),                                 //  8 — bottom (wider than top)
  ];
}

// Symmetric egg — clean left/right mirror, fatter bottom (7 rows)
// Widths: 6 → 8 → 10 → 12 → 14 → 12 → 10  |  Widest at row 5/7 (71%)
// Edge pairs: ▗/▖ cap → ▟/▙ expand → ▐/▌ straight → ▜/▛ contract → ▝/▘ cap
function eggSym(): string[] {
  return [
    _lt('▗▄') + _br('██') + _md('▄▖'),                        //  6 — rounded top cap
    _lt('▟') + _hi('█') + _br('████') + _md('█▙'),            //  8 — expanding, subtle highlight
    _lt('▟') + _br('██████') + _md('██▙'),                    // 10 — expanding
    _br('▟████████') + _md('██▙'),                             // 12 — expanding
    _br('▐███████') + _md('███') + _sh('██▌'),                 // 14 — widest, straight sides
    _br('▜████████') + _sh('██▛'),                             // 12 — contracting
    _md('▝▀') + _sh('██████▀▘'),                               // 10 — rounded bottom cap
  ];
}

// Tall smooth egg — symmetric, extra row at widest, finer gradient (8 rows)
// Widths: 6 → 8 → 10 → 12 → 14 → 14 → 12 → 10  |  Widest at rows 5-6/8
// Edge pairs: ▗/▖ cap → ▟/▙ expand → ▐/▌ straight → ▜/▛ contract → ▝/▘ cap
function eggTall(): string[] {
  // Extra intermediate tones for a smoother gradient
  const _m1 = (s: string) => `\x1b[38;2;238;138;10m${s}\x1b[39m`; // base → medium
  const _dk = (s: string) => `\x1b[38;2;195;88;6m${s}\x1b[39m`;   // medium → shadow

  return [
    _lt('▗▄') + _br('██') + _md('▄▖'),                            //  6 — top cap
    _lt('▟') + _hi('█') + _br('████') + _m1('█▙'),                //  8 — expanding, highlight
    _lt('▟') + _br('██████') + _m1('██▙'),                        // 10 — expanding
    _br('▟████████') + _m1('██▙'),                                 // 12 — expanding
    _br('▐███████') + _m1('███') + _md('██▌'),                    // 14 — widest, straight
    _br('▐██████') + _m1('███') + _md('██') + _dk('█▌'),          // 14 — widest, gradient shifts
    _m1('▜████') + _md('████') + _dk('██▛'),                      // 12 — contracting
    _md('▝▀') + _dk('████') + _sh('██▀▘'),                        // 10 — bottom cap
  ];
}

// ── ANSI helpers ───────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function padR(s: string, width: number): string {
  const gap = width - visLen(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

function center(s: string, width: number): string {
  const gap = width - visLen(s);
  if (gap <= 0) return s;
  const left = Math.floor(gap / 2);
  return ' '.repeat(left) + s + ' '.repeat(gap - left);
}

/** Build a single truncated line with aligned items: "Title:      Item1 · Item2..." */
function truncLine(title: string, items: string[], maxW: number, labelW: number): string {
  const prefixLen = labelW + 2; // "Title: " padded to align all categories
  const padding = ' '.repeat(prefixLen - title.length - 2);
  const prefix = bold(title) + ': ' + padding;
  const budget = maxW - prefixLen;
  if (budget <= 3) return prefix;

  let plain = '';
  let display = '';

  for (let i = 0; i < items.length; i++) {
    const joiner = i === 0 ? '' : ' · ';
    const candidate = joiner + items[i];

    if (plain.length + candidate.length > budget) {
      // Try to fit " · ..."
      if (plain.length + joiner.length + 3 <= budget) {
        display += joiner + '...';
      } else {
        // Trim display to guarantee we stay within budget
        display = display.substring(0, Math.max(0, budget - 3)) + '...';
      }
      return prefix + display;
    }

    plain += candidate;
    display += candidate;
  }

  return prefix + display;
}

// ── Banner renderer ────────────────────────────────────────────────────

const MIN_TWO_PANEL = 68; // below this, right panel is too cramped

export function printBanner(opts: BannerOptions): void {
  const OUTER_W = process.stdout.columns || 80;
  if (OUTER_W >= MIN_TWO_PANEL) {
    printFull(opts, OUTER_W);
  } else {
    printNarrow(opts, OUTER_W);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────

function buildLeftPanel(opts: BannerOptions, panelW: number): string[] {
  const leftLines: string[] = [];
  const nameDisplay = opts.email
    ? opts.email.split('@')[0].replace(/^./, c => c.toUpperCase())
    : null;
  const white = (s: string) => `\x1b[38;2;255;255;255m${s}\x1b[39m`;
  const welcome = nameDisplay
    ? white(bold(`Welcome back ${nameDisplay}!`))
    : white(bold('Welcome to Gipity'));

  leftLines.push('');
  leftLines.push(center(welcome, panelW));
  leftLines.push('');

  for (const line of eggTall()) {
    leftLines.push(center(line, panelW));
  }

  leftLines.push('');
  leftLines.push(center(faint('Cloud agents for builders'), panelW));

  if (opts.cwd) {
    const short = opts.cwd.replace(process.env['HOME'] || '', '~');
    leftLines.push(center(muted(short), panelW));
  }

  return leftLines;
}

function renderBox(opts: BannerOptions, outerW: number, bodyLines: string[]): void {
  const border = faint;
  const titleText = ` Gipity CLI v${opts.version} `;
  const innerW = outerW - 2; // inside ╭ and ╮
  const topLeft = 4;
  const topRight = innerW - topLeft - visLen(titleText);
  const topBorder = border('╭') + border('─'.repeat(topLeft)) + brand(bold(titleText)) + border('─'.repeat(Math.max(0, topRight))) + border('╮');

  const lines: string[] = [];
  lines.push(topBorder);
  for (const row of bodyLines) lines.push(row);
  lines.push(border('╰') + border('─'.repeat(innerW)) + border('╯'));

  console.log('\n' + lines.join('\n') + '\n');
}

// ── Narrow layout (single panel, egg only) ────────────────────────────

function printNarrow(opts: BannerOptions, outerW: number): void {
  const contentW = outerW - 4; // │ SP content SP │
  const leftLines = buildLeftPanel(opts, contentW);

  const border = faint;
  const bodyLines = leftLines.map(l => border('│') + ' ' + padR(l, contentW) + ' ' + border('│'));
  renderBox(opts, outerW, bodyLines);
}

// ── Full two-panel layout ─────────────────────────────────────────────

function printFull(opts: BannerOptions, outerW: number): void {
  const LEFT_W = 31;
  // Row: │ SP LEFT_W SP │ SP RIGHT_W SP │  =  LEFT_W + RIGHT_W + 7
  const RIGHT_W = outerW - LEFT_W - 7;
  const LABEL_W = 14; // longest label: "Infrastructure"

  const leftLines = buildLeftPanel(opts, LEFT_W);

  // -- Right panel lines --
  const rightLines: string[] = [];
  const P = ' '; // right panel left padding
  const contentW = RIGHT_W - 1; // inner content width

  const addSection = (title: string, items: string[]) => {
    rightLines.push(P + truncLine(title, items, contentW, LABEL_W));
  };

  rightLines.push('');
  rightLines.push('');
  addSection('AI Models', AI_MODELS);
  addSection('Generation', GENERATION);
  addSection('Agent', AGENT);
  addSection('Automation', AUTOMATION);
  addSection('Integrations', INTEGRATIONS);
  addSection('Data', DATA);
  addSection('Security', SECURITY);
  addSection('App Building', APP_BUILDING);
  addSection('Utilities', UTILITIES);
  addSection('Infrastructure', INFRASTRUCTURE);

  // -- Equalize lengths --
  const maxLen = Math.max(leftLines.length, rightLines.length);
  while (leftLines.length < maxLen) leftLines.push('');
  while (rightLines.length < maxLen) rightLines.push('');

  // -- Render rows --
  const border = faint;
  const bodyLines: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const left = padR(leftLines[i], LEFT_W);
    const right = padR(rightLines[i], RIGHT_W);
    bodyLines.push(border('│') + ' ' + left + ' ' + border('│') + ' ' + right + ' ' + border('│'));
  }

  renderBox(opts, outerW, bodyLines);
}

