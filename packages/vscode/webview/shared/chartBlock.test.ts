import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderChartBlock,
  parseSpec,
  foldSeries,
  foldSlices,
  computePieAngles,
  valueToY,
  compactNumber,
  SERIES_COLORS,
} from './chartBlock';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- OKLab math, mirrored from a scratch search script (not imported --
// this is the test's own re-runnable proof, independent of chartBlock.ts). ---
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexToOklab(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const [l_, m_, s_] = [Math.cbrt(l), Math.cbrt(m), Math.cbrt(s)];
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
function mixOklab(
  a: [number, number, number],
  b: [number, number, number],
  pctA: number,
): [number, number, number] {
  const t = pctA / 100;
  return [a[0] * t + b[0] * (1 - t), a[1] * t + b[1] * (1 - t), a[2] * t + b[2] * (1 - t)];
}
function dE100(a: [number, number, number], b: [number, number, number]): number {
  return 100 * Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// Reads the REAL theme.css and extracts one theme's --og-* block by its
// data-theme selector (no nested braces inside these blocks, so the first
// '}' after the opening brace closes them).
function themeBlock(css: string, theme: string): string {
  const idx = css.indexOf(`[data-theme="${theme}"]`);
  if (idx === -1) throw new Error(`theme block not found in theme.css: ${theme}`);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
}
function tokenHex(block: string, name: string): string {
  const m = block.match(new RegExp(`--og-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --og-${name} not found in theme block`);
  return m[1];
}

// Resolves one SERIES_COLORS entry against a theme block. Handles both
// shapes actually used in chartBlock.ts: 'var(--og-X)' and
// 'color-mix(in oklab, var(--og-X) P%, var(--og-Y))'. This walks the REAL
// exported strings, so a ratio or partner-token change in chartBlock.ts is
// picked up automatically -- nothing here is a copy of its current values.
function resolveSlot(expr: string, block: string): [number, number, number] {
  const direct = expr.match(/^var\(--og-([a-z0-9-]+)\)$/);
  if (direct) return hexToOklab(tokenHex(block, direct[1]));
  const mix = expr.match(/^color-mix\(in oklab, var\(--og-([a-z0-9-]+)\) (\d+)%, var\(--og-([a-z0-9-]+)\)\)$/);
  if (!mix) throw new Error(`unrecognised SERIES_COLORS expression: ${expr}`);
  const [, tokA, pct, tokB] = mix;
  return mixOklab(hexToOklab(tokenHex(block, tokA)), hexToOklab(tokenHex(block, tokB)), Number(pct));
}

describe('parseSpec — invalid input degrades to null', () => {
  it('rejects malformed JSON', () => {
    expect(parseSpec('{not json')).toBeNull();
  });

  it('rejects a non-finite value inside a bar series', () => {
    expect(parseSpec('{"type":"bar","series":[{"data":[1,NaN,3]}]}')).toBeNull();
  });

  it('rejects Infinity inside a pie slice value', () => {
    // JSON.parse itself rejects the literal `Infinity`; the string form is
    // what a model could plausibly emit, and it must fail the same way.
    expect(parseSpec('{"type":"pie","slices":[{"label":"a","value":"Infinity"}]}')).toBeNull();
  });

  it('rejects an unknown chart type', () => {
    expect(parseSpec('{"type":"scatter","series":[]}')).toBeNull();
  });

  it('accepts a well-formed bar spec', () => {
    const spec = parseSpec('{"type":"bar","series":[{"name":"A","data":[1,2,3]}]}');
    expect(spec).not.toBeNull();
  });
});

describe('renderChartBlock — invalid specs fall back to null (caller renders a code block)', () => {
  it('returns null for malformed JSON', () => {
    expect(renderChartBlock('{oops')).toBeNull();
  });

  it('returns null when every declared number is non-finite', () => {
    expect(renderChartBlock('{"type":"line","series":[{"data":["not-a-number"]}]}')).toBeNull();
  });

  it('renders an <svg> for a valid bar spec', () => {
    const svg = renderChartBlock('{"type":"bar","series":[{"data":[1,2,3]}]}');
    expect(svg).toMatch(/^<svg /);
  });
});

describe('bar/line geometry — one shared y-axis via valueToY', () => {
  it('scales linearly with the value (proportionality)', () => {
    const min = 0;
    const max = 100;
    const top = 10;
    const height = 140;
    const yAt = (v: number) => valueToY(v, min, max, top, height);
    // Equal value steps must produce equal pixel steps on the shared axis.
    const step1 = yAt(25) - yAt(0);
    const step2 = yAt(75) - yAt(50);
    expect(step1).toBeCloseTo(step2, 5);
    // Larger values sit higher (smaller y) on a top-down SVG canvas.
    expect(yAt(100)).toBeLessThan(yAt(0));
  });

  it('places a negative value below the zero baseline', () => {
    const min = -50;
    const max = 50;
    const top = 10;
    const height = 140;
    const baseline = valueToY(0, min, max, top, height);
    const negative = valueToY(-25, min, max, top, height);
    const positive = valueToY(25, min, max, top, height);
    expect(negative).toBeGreaterThan(baseline);
    expect(positive).toBeLessThan(baseline);
  });
});

describe('pie angles — computePieAngles', () => {
  it('sums adjacent sweeps to exactly 360 degrees', () => {
    const angles = computePieAngles([10, 20, 30, 40]);
    const total = angles.reduce((acc, a) => acc + (a.end - a.start), 0);
    expect(total).toBeCloseTo(360, 6);
  });

  it('starts the first slice at 12 o\'clock (-90deg)', () => {
    const angles = computePieAngles([1, 1]);
    expect(angles[0].start).toBe(-90);
  });

  it('folds beyond 8 slices into one Other slice and still sums to 360', () => {
    const nineSlices = Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, value: 10 }));
    const folded = foldSlices(nineSlices);
    expect(folded.length).toBe(8);
    expect(folded[7].label).toBe('Other');
    expect(folded[7].value).toBe(20); // the last 2 folded slices, 10 each
    const angles = computePieAngles(folded.map((s) => s.value));
    const total = angles.reduce((acc, a) => acc + (a.end - a.start), 0);
    expect(total).toBeCloseTo(360, 6);
  });
});

describe('foldSeries — 6-series cap', () => {
  it('keeps the first 5 series and sums the rest into Other', () => {
    const series = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, data: [1, 1] }));
    const folded = foldSeries(series);
    expect(folded.length).toBe(6);
    expect(folded[5].name).toBe('Other');
    // 3 folded series (s5, s6, s7) contribute 1 each per point.
    expect(folded[5].data).toEqual([3, 3]);
  });

  it('leaves 6 or fewer series untouched', () => {
    const series = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, data: [1] }));
    expect(foldSeries(series)).toEqual(series);
  });
});

describe('escaping — model-controlled labels are entity-escaped everywhere they land', () => {
  const hostileLabel = '<script>alert("x")</script>';

  it('escapes a hostile series name in a multi-series render (legend + tooltip)', () => {
    const svg = renderChartBlock(
      JSON.stringify({
        type: 'bar',
        series: [
          { name: hostileLabel, data: [1, 2] },
          { name: 'safe', data: [3, 4] },
        ],
      }),
    )!;
    expect(svg).not.toBeNull();
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('"x"');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&quot;x&quot;');
  });

  it('escapes a hostile pie slice label in both the tooltip and the legend', () => {
    const svg = renderChartBlock(
      JSON.stringify({
        type: 'pie',
        slices: [
          { label: hostileLabel, value: 1 },
          { label: 'safe', value: 2 },
        ],
      }),
    )!;
    expect(svg).not.toContain('<script>');
    // Appears twice: once in the <title> tooltip, once in the legend <text>.
    expect(svg.split('&lt;script&gt;').length - 1).toBe(2);
  });

  it('escapes a hostile chart title', () => {
    const svg = renderChartBlock(
      JSON.stringify({ type: 'bar', title: hostileLabel, series: [{ data: [1] }] }),
    )!;
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('legend — appears only at 2+ series/slices', () => {
  // The legend swatch is the only mark that renders `rx="1"` (a slightly
  // rounded square); native per-mark <title> tooltips render regardless of
  // series count, so presence/absence of the swatch is what distinguishes
  // "has a legend" from "name only shows up in a hover tooltip".
  it('renders no legend swatch for a single series (name only lives in the tooltip)', () => {
    const svg = renderChartBlock('{"type":"bar","series":[{"name":"Solo","data":[1,2,3]}]}')!;
    expect(svg).toContain('Solo'); // the tooltip
    expect(svg).not.toContain('rx="1"'); // no legend swatch
  });

  it('renders a legend swatch for two series', () => {
    const svg = renderChartBlock(
      '{"type":"bar","series":[{"name":"Alpha","data":[1,2]},{"name":"Beta","data":[3,4]}]}',
    )!;
    expect(svg).toContain('Alpha');
    expect(svg).toContain('Beta');
    expect(svg).toContain('rx="1"');
  });

  it('renders no legend swatch for a single pie slice', () => {
    const svg = renderChartBlock('{"type":"pie","slices":[{"label":"Only","value":5}]}')!;
    expect(svg).toContain('Only');
    expect(svg).not.toContain('rx="1"');
  });

  it('renders a legend swatch for two pie slices', () => {
    const svg = renderChartBlock(
      '{"type":"pie","slices":[{"label":"A","value":1},{"label":"B","value":2}]}',
    )!;
    expect(svg).toContain('rx="1"');
  });
});

describe('SERIES_COLORS — theme-reactive series palette (structure)', () => {
  it('has 6 entries', () => {
    expect(SERIES_COLORS.length).toBe(6);
  });

  it('never hardcodes a literal hex colour (every slot stays theme-reactive)', () => {
    for (const c of SERIES_COLORS) expect(c).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('presents --og-chat and --og-accent-2 as color-mix derivations (slots 3 and 5)', () => {
    expect(SERIES_COLORS[2]).toContain('color-mix');
    expect(SERIES_COLORS[2]).toContain('--og-chat');
    expect(SERIES_COLORS[4]).toContain('color-mix');
    expect(SERIES_COLORS[4]).toContain('--og-accent-2');
  });
});

describe('SERIES_COLORS - resolved-colour distinctness, all 15 pairs, per theme', () => {
  // Behavioural, not syntactic: reads the real theme.css, resolves every
  // SERIES_COLORS slot's ACTUAL colour per theme (including the color-mix
  // slots via the OKLab math above), and checks every one of the 15
  // pairwise combinations -- a legend shows all series at once, so a
  // collision anywhere in the set is visible, not just between neighbours.
  // A new duplicate token, a changed ratio, or a theme.css edit that moves
  // two tokens together will drop a pair's dE and fail this test.
  const css = readFileSync(path.join(here, 'theme.css'), 'utf8');
  const HARD_GATE = 8;

  for (const theme of ['meadow', 'harbour', 'ember', 'midnight', 'custom']) {
    it(`clears dE100 >= ${HARD_GATE} on every pair in ${theme}`, () => {
      const block = themeBlock(css, theme);
      const slots = SERIES_COLORS.map((expr) => resolveSlot(expr, block));
      const failing: { pair: [number, number]; d: number }[] = [];
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const d = dE100(slots[i], slots[j]);
          if (d < HARD_GATE) failing.push({ pair: [i, j], d });
        }
      }
      expect(failing).toEqual([]);
    });
  }
});

describe('compactNumber', () => {
  it('formats thousands and millions compactly, and keeps sign', () => {
    expect(compactNumber(1200)).toBe('1.2k');
    expect(compactNumber(-1200)).toBe('-1.2k');
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(2_500_000)).toBe('2.5m');
  });
});

describe('misspelled keys are refused, not silently dropped', () => {
  // The fence path bypasses the engine tool's normalisation entirely, so a
  // model that writes `x_labels` in a ```chart fence used to get a chart with
  // no axis labels and no warning — the wrong-picture-reads-as-right failure
  // this feature exists to end. These assert the REFUSAL, which routes the
  // fence to its visible hint.
  const misspelled: [string, string][] = [
    ['snake_case top-level key', '{"type":"bar","x_labels":["Q1","Q2"],"series":[{"data":[3,5]}]}'],
    ['run-together top-level key', '{"type":"bar","xlabels":["Q1","Q2"],"series":[{"data":[3,5]}]}'],
    ['kebab top-level key', '{"type":"bar","x-labels":["Q1","Q2"],"series":[{"data":[3,5]}]}'],
    ['unknown top-level key', '{"type":"bar","colours":["red"],"series":[{"data":[3,5]}]}'],
    ['misspelled series key', '{"type":"bar","series":[{"nam":"S","data":[3,5]}]}'],
    ['unknown slice key', '{"type":"pie","slices":[{"label":"A","value":1,"colour":"red"}]}'],
  ];
  for (const [what, spec] of misspelled) {
    it(`refuses a ${what} instead of drawing an incomplete chart`, () => {
      expect(parseSpec(spec)).toBeNull();
      expect(renderChartBlock(spec)).toBeNull();
    });
  }

  it('still draws every valid spec, with optional fields present and absent', () => {
    const valid = [
      '{"type":"bar","title":"T","xLabels":["a"],"series":[{"name":"S","data":[1]}]}',
      '{"type":"bar","series":[{"data":[1,2]}]}',
      '{"type":"line","title":"T","series":[{"name":"S","data":[1,2]}]}',
      '{"type":"pie","title":"T","slices":[{"label":"A","value":1}]}',
      '{"type":"pie","slices":[{"label":"A","value":1},{"label":"B","value":2}]}',
    ];
    for (const spec of valid) {
      expect(renderChartBlock(spec), spec).toContain('<svg');
    }
  });
});
