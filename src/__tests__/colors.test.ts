import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rgbTo256, rgbTo16 } from '../colors.js';

// These pin the numeric claims the color-fallback strategy rests on. The whole
// rationale for giving brand orange a monochrome (bold) fallback at 16-color is
// that the palette has no orange slot, while 256-color does (xterm-214). If
// either downscale drifts, the comments in colors.ts become wrong silently.

const GIPITY_ORANGE: [number, number, number] = [254, 166, 11]; // #fea60b

describe('rgbTo256', () => {
  it('maps Gipity orange to xterm-214 (a real orange)', () => {
    assert.equal(rgbTo256(...GIPITY_ORANGE), 214);
  });

  it('routes pure grays through the grayscale ramp, not the color cube', () => {
    assert.equal(rgbTo256(0, 0, 0), 16); // near-black floor
    assert.equal(rgbTo256(255, 255, 255), 231); // near-white ceiling
  });
});

describe('rgbTo16', () => {
  it('forces Gipity orange to bright yellow — the palette has no orange', () => {
    assert.equal(rgbTo16(...GIPITY_ORANGE), 93);
  });

  it('keeps semantic colors that map cleanly', () => {
    assert.equal(rgbTo16(0, 0, 0), 30); // black
    assert.equal(rgbTo16(34, 197, 94), 32); // success green → green
    assert.equal(rgbTo16(239, 68, 68), 91); // error red → bright red
  });
});
