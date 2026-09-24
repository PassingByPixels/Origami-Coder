// composerGrow.test.ts — the clamp math in plain numbers, because jsdom
// (InputBar.test.ts) reports scrollHeight as 0 and can prove nothing here.
// Line height 17, padding 12, minRows 2, maxRows 10 mirrors the composer's
// real 12px font (lineHeight ~= fontSize * 1.4) and its 6px top/bottom padding.

import { describe, expect, it } from 'vitest';
import { growHeight } from './composerGrow';

const LH = 17;
const PAD = 12;
const REST = { minRows: 2, maxRows: 10 } as const;

describe('growHeight', () => {
  it('holds the rest height when content fits in 1-2 lines', () => {
    const restHeight = 2 * LH + PAD;
    expect(growHeight({ scrollHeight: 1 * LH + PAD, lineHeight: LH, padding: PAD, ...REST })).toEqual({ height: restHeight, overflow: 'hidden' });
    expect(growHeight({ scrollHeight: 2 * LH + PAD, lineHeight: LH, padding: PAD, ...REST })).toEqual({ height: restHeight, overflow: 'hidden' });
  });

  it('grows line by line from 3 through 10 lines, staying non-overflowed', () => {
    for (let n = 3; n <= 10; n++) {
      const scrollHeight = n * LH + PAD;
      expect(growHeight({ scrollHeight, lineHeight: LH, padding: PAD, ...REST })).toEqual({ height: scrollHeight, overflow: 'hidden' });
    }
  });

  it('caps at 10 lines and switches to scroll (overflow auto) past it', () => {
    const cap = 10 * LH + PAD;
    expect(growHeight({ scrollHeight: cap, lineHeight: LH, padding: PAD, ...REST })).toEqual({ height: cap, overflow: 'hidden' });
    expect(growHeight({ scrollHeight: 15 * LH + PAD, lineHeight: LH, padding: PAD, ...REST })).toEqual({ height: cap, overflow: 'auto' });
  });

  it('shrinks back toward rest as content is deleted', () => {
    const grown = growHeight({ scrollHeight: 8 * LH + PAD, lineHeight: LH, padding: PAD, ...REST });
    const shrunk = growHeight({ scrollHeight: 3 * LH + PAD, lineHeight: LH, padding: PAD, ...REST });
    const rest = growHeight({ scrollHeight: 0, lineHeight: LH, padding: PAD, ...REST });
    expect(shrunk.height).toBeLessThan(grown.height);
    expect(rest.height).toBe(2 * LH + PAD);
    expect(rest.overflow).toBe('hidden');
  });
});
