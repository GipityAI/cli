// ── Gipity CLI Color System ─────────────────────────────────────────────
// Centralized color definitions matching the Gipity platform palette.
// All command files should import from here — no inline ANSI codes.

type StyleFn = (s: string) => string;

const ESC = '\x1b';

// Detect whether colors should be suppressed
const noColor = !!process.env['NO_COLOR'] || !process.stdout.isTTY;

// Identity function for when colors are disabled
const identity: StyleFn = (s: string) => s;

// ── Low-level builders ──────────────────────────────────────────────────

function makeFg(r: number, g: number, b: number): StyleFn {
  if (noColor) return identity;
  return (s: string) => `${ESC}[38;2;${r};${g};${b}m${s}${ESC}[39m`;
}

function makeBg(r: number, g: number, b: number): StyleFn {
  if (noColor) return identity;
  return (s: string) => `${ESC}[48;2;${r};${g};${b}m${s}${ESC}[49m`;
}

function makeStyle(open: number, close: number): StyleFn {
  if (noColor) return identity;
  return (s: string) => `${ESC}[${open}m${s}${ESC}[${close}m`;
}

// ── Text style helpers ──────────────────────────────────────────────────

export const bold: StyleFn = makeStyle(1, 22);
export const dim: StyleFn = makeStyle(2, 22);
export const italic: StyleFn = makeStyle(3, 23);
export const underline: StyleFn = makeStyle(4, 24);

// ── Gipity platform palette ────────────────────────────────────────────
// Colors sourced from platform/client/src/css/styles.css and
// platform/apps/gipitsm/src/css/tokens.css

export const brand: StyleFn   = makeFg(254, 166, 14);   // Gipity orange #fea60e
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
