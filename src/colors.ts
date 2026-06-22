// ── Gipity CLI Color System ─────────────────────────────────────────────
// Centralized color definitions matching the Gipity platform palette.
// All command files should import from here - no inline ANSI codes.
//
// Color depth is detected once at load. RGB colors automatically downgrade:
//   level 3 → 24-bit truecolor   \x1b[38;2;R;G;Bm
//   level 2 → 256-color          \x1b[38;5;Nm
//   level 1 → 16-color           \x1b[3Xm / \x1b[9Xm
//   level 0 → no color (plain text)
// This avoids the failure mode where a terminal that does not understand the
// 24-bit escape misparses it and renders garbage (e.g. the orange egg coming
// out purple on consoles without truecolor support).

type StyleFn = (s: string) => string;

const ESC = '\x1b';

// ── Color-depth detection ───────────────────────────────────────────────
// 0 = none, 1 = 16-color, 2 = 256-color, 3 = truecolor. Mirrors the common
// supports-color / chalk heuristics, biased toward NOT emitting truecolor
// unless the terminal advertises it, so unknown terminals get a safe 256 or
// 16-color approximation instead of a misparsed 24-bit sequence.
function detectColorLevel(): 0 | 1 | 2 | 3 {
  if (process.env['NO_COLOR']) return 0;

  // FORCE_COLOR overrides detection (matches Node / chalk semantics).
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '3') return 3;
    if (force === '2') return 2;
    // '1', 'true', '' → at least basic color
    if (force === '1' || force === 'true' || force === '') return 1;
  }

  if (!process.stdout.isTTY) return 0;

  const term = (process.env['TERM'] || '').toLowerCase();
  if (term === 'dumb') return 0;

  const colorterm = (process.env['COLORTERM'] || '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;

  const termProgram = process.env['TERM_PROGRAM'] || '';
  if (termProgram === 'iTerm.app' || termProgram === 'vscode') return 3;
  if (termProgram === 'Apple_Terminal') return 2;

  if (/-256(color)?$/.test(term) || term.includes('256')) return 2;

  // Windows Terminal / VS Code set COLORTERM=truecolor (caught above). The
  // classic console host (conhost, the standalone PowerShell window) advertises
  // nothing, but every still-supported Windows build (10 v1703+, 2017) handles
  // 256-color VT sequences reliably - so 256 is the safe floor. Orange then
  // downscales to xterm-214 (a real orange) instead of the bright-yellow the
  // 16-color palette is forced into (it has no orange slot at all).
  if (process.platform === 'win32') return 2;

  if (term) return 1;
  return 0;
}

const COLOR_LEVEL = detectColorLevel();

// Identity function for when colors are disabled
const identity: StyleFn = (s: string) => s;

// ── RGB downgrade helpers ───────────────────────────────────────────────

// RGB → nearest xterm-256 palette index (6x6x6 cube + grayscale ramp).
// Exported for unit tests that pin the documented downscale (orange → 214).
export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return (
    16 +
    36 * Math.round((r / 255) * 5) +
    6 * Math.round((g / 255) * 5) +
    Math.round((b / 255) * 5)
  );
}

// RGB → nearest 16-color SGR foreground code (30-37 / 90-97).
// Exported for unit tests that pin the documented downscale (orange → bright
// yellow, i.e. the palette has no orange slot).
export function rgbTo16(r: number, g: number, b: number): number {
  const value = Math.round((Math.max(r, g, b) / 255) * 3);
  if (value === 0) return 30;
  let code =
    30 +
    ((Math.round(b / 255) << 2) |
      (Math.round(g / 255) << 1) |
      Math.round(r / 255));
  if (value === 3) code += 60; // bright variant
  return code;
}

// ── Low-level builders ──────────────────────────────────────────────────

// `lowColorFallback` controls the 16-color (level 1) tier. The ANSI 16-color
// palette has no orange and only crude approximations of off-palette hues, so a
// color that can't be represented reads as a bug (brand orange → bright yellow).
// Off-palette brand colors pass a monochrome fallback (e.g. `bold`) to convey
// emphasis without a wrong hue; semantic colors that map cleanly (red, green,
// blue) omit it and keep their nearest-16 approximation.
export function makeFg(
  r: number,
  g: number,
  b: number,
  lowColorFallback?: StyleFn,
): StyleFn {
  if (COLOR_LEVEL === 0) return identity;
  if (COLOR_LEVEL === 3) {
    return (s: string) => `${ESC}[38;2;${r};${g};${b}m${s}${ESC}[39m`;
  }
  if (COLOR_LEVEL === 2) {
    const n = rgbTo256(r, g, b);
    return (s: string) => `${ESC}[38;5;${n}m${s}${ESC}[39m`;
  }
  if (lowColorFallback) return lowColorFallback;
  const code = rgbTo16(r, g, b);
  return (s: string) => `${ESC}[${code}m${s}${ESC}[39m`;
}

export function makeBg(r: number, g: number, b: number): StyleFn {
  if (COLOR_LEVEL === 0) return identity;
  if (COLOR_LEVEL === 3) {
    return (s: string) => `${ESC}[48;2;${r};${g};${b}m${s}${ESC}[49m`;
  }
  if (COLOR_LEVEL === 2) {
    const n = rgbTo256(r, g, b);
    return (s: string) => `${ESC}[48;5;${n}m${s}${ESC}[49m`;
  }
  const code = rgbTo16(r, g, b) + 10; // fg 30-97 → bg 40-107
  return (s: string) => `${ESC}[${code}m${s}${ESC}[49m`;
}

function makeStyle(open: number, close: number): StyleFn {
  if (COLOR_LEVEL === 0) return identity;
  return (s: string) => `${ESC}[${open}m${s}${ESC}[${close}m`;
}

// Convenience alias for callers that just want an RGB foreground (e.g. banner).
export const fg = makeFg;

// The detected level, exported for callers that want to branch on it.
export const colorLevel = COLOR_LEVEL;

// ── Text style helpers ──────────────────────────────────────────────────

export const bold: StyleFn = makeStyle(1, 22);
export const dim: StyleFn = makeStyle(2, 22);
export const italic: StyleFn = makeStyle(3, 23);
export const underline: StyleFn = makeStyle(4, 24);

// ── Gipity platform palette ────────────────────────────────────────────
// Colors sourced from platform/client/src/css/styles.css and
// platform/apps/gipitsm/src/css/tokens.css

export const brand: StyleFn   = makeFg(254, 166, 14, bold); // Gipity orange #fea60e (→ bold on 16-color; no orange in palette)
export const error: StyleFn   = makeFg(239, 68, 68);    // #ef4444
export const warning: StyleFn = makeFg(245, 158, 11);   // #f59e0b
export const success: StyleFn = makeFg(34, 197, 94);    // #22c55e
export const info: StyleFn    = makeFg(59, 130, 246);   // #3b82f6
export const muted: StyleFn   = makeFg(168, 162, 158);  // #a8a29e
export const faint: StyleFn   = makeFg(111, 111, 120);  // #6f6f78

// ── Accent colors ──────────────────────────────────────────────────────

export const accent: StyleFn  = makeFg(178, 186, 250);  // Light blue-purple
export const cyan: StyleFn    = makeFg(9, 146, 179);    // Teal

// ── Background variants ────────────────────────────────────────────────

export const bgBrand: StyleFn   = makeBg(242, 101, 34);
export const bgError: StyleFn   = makeBg(239, 68, 68);
export const bgSuccess: StyleFn = makeBg(34, 197, 94);

// ── Convenience combinators ────────────────────────────────────────────

export const brandBold: StyleFn   = (s: string) => brand(bold(s));
export const errorBold: StyleFn   = (s: string) => error(bold(s));
export const successBold: StyleFn = (s: string) => success(bold(s));
export const infoBold: StyleFn    = (s: string) => info(bold(s));
