// Pure-data tests for the picker's type glyphs + vendor monograms — no DOM,
// no host wiring. Real bugs this catches: a vendor whose id contains a colon
// or a version suffix mis-keying to the wrong (or no) monogram colour, and a
// section missing its glyph entirely (a blank tier-1 tab).

import { describe, expect, it } from 'vitest';
import { TYPE_GLYPHS, vendorKey, vendorMark } from './modelPickerMarks';
import { SECTION_ORDER } from '../../sidebar/connectionSection';

describe('TYPE_GLYPHS', () => {
  it('has one non-empty glyph per ConnectionSection, in both directions', () => {
    const keys = Object.keys(TYPE_GLYPHS).sort();
    expect(keys).toEqual([...SECTION_ORDER].sort());
    for (const section of SECTION_ORDER) {
      const glyph = TYPE_GLYPHS[section];
      const shapeCount = (glyph.rects?.length ?? 0) + (glyph.paths?.length ?? 0);
      expect(shapeCount).toBeGreaterThan(0);
    }
  });
});

describe('vendorKey', () => {
  it('reads the vendor out of a "Vendor: Model" label', () => {
    expect(vendorKey('Mistral: Pareto')).toBe('mistral');
  });

  it('strips a trailing size/version off a bare model id', () => {
    expect(vendorKey('qwen3-32b')).toBe('qwen');
  });

  it('strips a trailing version after a colon-separated tag', () => {
    expect(vendorKey('llama3.3:70b')).toBe('llama');
  });

  it('is case-insensitive and strips non-alphanumerics', () => {
    expect(vendorKey('OpenAI')).toBe('openai');
  });
});

describe('vendorMark', () => {
  it('returns the table colour + monogram for a known vendor', () => {
    expect(vendorMark('gpt-5-mini')).toEqual({ monogram: 'GP', color: '#10a37f' });
    expect(vendorMark('Anthropic')).toEqual({ monogram: 'AN', color: '#d97757' });
  });

  it('falls back to a deterministic hashed colour for an unknown vendor', () => {
    const a = vendorMark('totally-unheard-of-vendor-42b');
    const b = vendorMark('totally-unheard-of-vendor-42b');
    // Same key -> same mark, every time — a per-render random colour would
    // make the same source tab flicker between colours across re-renders.
    expect(a).toEqual(b);
    expect(a.color).toMatch(/^hsl\(\d+ 45% 42%\)$/);
    expect(a.monogram).toBe('TO');
  });

  it('falls back to "?" when the name yields no usable key', () => {
    expect(vendorMark('').monogram).toBe('?');
  });
});
