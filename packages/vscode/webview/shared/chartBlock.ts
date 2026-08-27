// chartBlock.ts — the ```chart fence renderer, shared by BOTH markdown
// pipelines (MessageRow.svelte's renderer.code and collabMarkdown.ts's own
// renderer.code — see the sync note in each). The model emits a fenced code
// block with language `chart` whose body is a small JSON spec; this turns it
// into an inline SVG (bar / line / pie) that reads the current Origami theme.
// An invalid spec returns null so the caller falls back to the normal
// hljs code-block path.
//
// Spec:
//   bar | line: { "type": "bar"|"line", "title"?: string,
//                 "xLabels"?: string[],
//                 "series": [{ "name"?: string, "data": number[] }] }
//   pie:        { "type": "pie", "title"?: string,
//                 "slices": [{ "label": string, "value": number }] }
//
// Security: the spec text is MODEL-CONTROLLED and the result is inserted via
// Svelte {@html}. Every label/title/name is HTML-entity escaped; every
// number is coerced through Number() and any non-finite value invalidates
// the whole spec (no silent guessing); nothing here emits an event-handler
// attribute, a foreignObject, or a URL.

type BarLineSpec = {
  type: 'bar' | 'line';
  title?: string;
  xLabels?: string[];
  series: { name?: string; data: number[] }[];
};

type PieSpec = {
  type: 'pie';
  title?: string;
  slices: { label: string; value: number }[];
};

type ChartSpec = BarLineSpec | PieSpec;

const MAX_SERIES = 6;
const MAX_SLICES = 8;

const W = 480;
const PAD = 8;
const TITLE_H = 20;
const LEGEND_ROW_H = 16;
const AXIS_LABEL_H = 16;
const PLOT_H = 140;
const Y_AXIS_W = 34;

// Fixed, non-cycled series colour order — never reassigned per render, so
// the same position always reads the same hue.
//
// theme.css duplicates several --og-* tokens WITHIN a theme (Meadow/Custom:
// --og-accent-2 == --og-warning and --og-chat == --og-success, both
// #d9b15a/#5fa382; Harbour: --og-accent-2 == --og-warning, #d9b15a), and
// Ember's --og-accent (#a85a32) sits only dE 7.06 from its --og-chat
// (#8c4a28). So neither the raw six vivid tokens nor any ordering of them
// can separate every pair in every theme — the SET has to change, not the
// order.
//
// Distinctness bar: a legend shows every series at once, so the real
// requirement is ALL-PAIRS separation (all 15 combinations of the 6 slots)
// with OKLab dE(x100) >= 8 in every theme. This config reaches it with NO
// residuals: --og-chat is always presented as its 65% mix toward --og-text
// (slot 3), which lifts it clear of Ember's nearby --og-accent AND of the
// themes where --og-success shares its hex; slot 5 is a 5% --og-accent-2
// mix (a near-text neutral); slot 6 is plain --og-success. Ratios found by
// an OKLab all-pairs grid search over the live theme.css values.
// Per-theme minimum dE(x100) over all 15 pairs, this config, all in-gamut:
//   meadow/custom: 10.26   harbour: 11.47   ember: 10.45   midnight: 10.93
// chartBlock.test.ts re-runs the same resolve+dE math against the live
// theme.css and asserts the gate on every pair of every theme — that test
// is the re-runnable proof, not this comment. Every mark also carries a
// legend swatch and a native per-mark <title> tooltip, so identity is
// never colour-alone.
export const SERIES_COLORS = [
  'var(--og-accent)',
  'var(--og-warning)',
  'color-mix(in oklab, var(--og-chat) 65%, var(--og-text))',
  'var(--og-error)',
  'color-mix(in oklab, var(--og-accent-2) 5%, var(--og-text))',
  'var(--og-success)',
];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numsOrNull(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const item of v) {
    const n = num(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

export function compactNumber(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${trim(abs)}`;
}

/** A key the spec does not declare is a misspelling, not a decoration. Reading
 *  the known keys and ignoring the rest drew `x_labels` as an unlabelled chart
 *  and `nam` as an unnamed series — a wrong picture that reads as a right one,
 *  with a green check on it. Refusing routes it to the fence hint instead, and
 *  a hint the user can see beats a chart they cannot tell is wrong. */
function onlyKnown(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

export function parseSpec(text: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : undefined;

  if (obj.type === 'bar' || obj.type === 'line') {
    if (!onlyKnown(obj, ['type', 'title', 'xLabels', 'series'])) return null;
    if (!Array.isArray(obj.series) || obj.series.length === 0) return null;
    const series: { name?: string; data: number[] }[] = [];
    for (const entry of obj.series) {
      if (!entry || typeof entry !== 'object') return null;
      const s = entry as Record<string, unknown>;
      if (!onlyKnown(s, ['name', 'data'])) return null;
      const data = numsOrNull(s.data);
      if (data === null || data.length === 0) return null;
      series.push({ name: typeof s.name === 'string' ? s.name : undefined, data });
    }
    let xLabels: string[] | undefined;
    if (obj.xLabels !== undefined) {
      if (!Array.isArray(obj.xLabels) || !obj.xLabels.every((x) => typeof x === 'string')) return null;
      xLabels = obj.xLabels as string[];
    }
    return { type: obj.type, title, xLabels, series };
  }

  if (obj.type === 'pie') {
    if (!onlyKnown(obj, ['type', 'title', 'slices'])) return null;
    if (!Array.isArray(obj.slices) || obj.slices.length === 0) return null;
    const slices: { label: string; value: number }[] = [];
    for (const entry of obj.slices) {
      if (!entry || typeof entry !== 'object') return null;
      const s = entry as Record<string, unknown>;
      if (!onlyKnown(s, ['label', 'value'])) return null;
      const value = num(s.value);
      if (value === null || value < 0) return null;
      slices.push({ label: typeof s.label === 'string' ? s.label : '', value });
    }
    if (slices.every((s) => s.value === 0)) return null;
    return { type: 'pie', title, slices };
  }

  return null;
}

export function foldSeries(series: { name?: string; data: number[] }[]): { name?: string; data: number[] }[] {
  if (series.length <= MAX_SERIES) return series;
  const kept = series.slice(0, MAX_SERIES - 1);
  const rest = series.slice(MAX_SERIES - 1);
  const len = Math.max(...rest.map((s) => s.data.length));
  const data = Array.from({ length: len }, (_, i) => rest.reduce((acc, s) => acc + (s.data[i] ?? 0), 0));
  return [...kept, { name: 'Other', data }];
}

export function foldSlices(slices: { label: string; value: number }[]): { label: string; value: number }[] {
  if (slices.length <= MAX_SLICES) return slices;
  const kept = slices.slice(0, MAX_SLICES - 1);
  const rest = slices.slice(MAX_SLICES - 1);
  const value = rest.reduce((acc, s) => acc + s.value, 0);
  return [...kept, { label: 'Other', value }];
}

// The one geometry primitive both bar and line marks scale through — a
// single shared y-axis, always. Exported so its linearity (proportional
// spacing) and its negative-below-zero placement are directly testable.
export function valueToY(v: number, min: number, max: number, top: number, height: number): number {
  const domain = max - min || 1;
  return top + height - ((v - min) / domain) * height;
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = range / 10 ** exp;
  let niceFrac: number;
  if (round) niceFrac = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * 10 ** exp;
}

function niceTicks(dataMin: number, dataMax: number, count = 4): number[] {
  let min = dataMin;
  let max = dataMax;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = niceNum(niceNum(max - min, false) / (count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// 12 o'clock start, clockwise, in degrees. Exported so the fold-then-sum
// invariant (angles always cover exactly 360°) is directly testable.
export function computePieAngles(values: number[]): { start: number; end: number }[] {
  const total = values.reduce((a, b) => a + b, 0);
  let angle = -90;
  return values.map((v) => {
    const sweep = total > 0 ? (v / total) * 360 : 0;
    const start = angle;
    angle += sweep;
    return { start, end: angle };
  });
}

function barPath(x: number, y: number, w: number, h: number, r: number, roundTop: boolean): string {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  if (roundTop) {
    return `M${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} L${x},${y + h} Z`;
  }
  return `M${x},${y} L${x + w},${y} L${x + w},${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} L${x + rr},${y + h} Q${x},${y + h} ${x},${y + h - rr} Z`;
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startDeg));
  const y1 = cy + r * Math.sin(toRad(startDeg));
  const x2 = cx + r * Math.cos(toRad(endDeg));
  const y2 = cy + r * Math.sin(toRad(endDeg));
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z`;
}

function renderTitle(title: string | undefined): string {
  if (!title) return '';
  return `<text x="${PAD}" y="14" font-size="11" font-weight="600" fill="var(--og-text-secondary)">${esc(title)}</text>`;
}

// Greedy left-to-right wrap. Called once to measure (top=0, markup discarded)
// so the caller can size the SVG's total height before it renders anything,
// then called again at the real offset for the markup itself.
function renderLegend(items: { label: string; color: string }[], top: number): { markup: string; height: number } {
  if (items.length < 2) return { markup: '', height: 0 };
  let x = PAD;
  let y = top + 12;
  let rows = 1;
  const parts: string[] = [];
  for (const item of items) {
    const itemWidth = 8 + 4 + item.label.length * 6 + 12;
    if (x > PAD && x + itemWidth > W - PAD) {
      x = PAD;
      y += LEGEND_ROW_H;
      rows++;
    }
    parts.push(
      `<rect x="${x}" y="${y - 8}" width="8" height="8" rx="1" fill="${item.color}"/>` +
        `<text x="${x + 12}" y="${y}" font-size="11" fill="var(--og-text-secondary)">${esc(item.label)}</text>`,
    );
    x += itemWidth;
  }
  return { markup: `<g>${parts.join('')}</g>`, height: rows * LEGEND_ROW_H + 4 };
}

function renderGrid(ticks: number[], min: number, max: number, top: number, height: number): string {
  return ticks
    .map((t) => {
      const y = valueToY(t, min, max, top, height);
      const zero = t === 0;
      return (
        `<line x1="${Y_AXIS_W}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="var(${zero ? '--og-text-muted' : '--og-border'})" stroke-width="${zero ? 1.5 : 1}"/>` +
        `<text x="${Y_AXIS_W - 4}" y="${y + 3}" font-size="11" fill="var(--og-text-muted)" text-anchor="end">${compactNumber(t)}</text>`
      );
    })
    .join('');
}

function svgWrap(h: number, body: string): string {
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" style="max-width:520px;height:auto;display:block" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function renderBarLine(spec: BarLineSpec): string {
  const series = foldSeries(spec.series);
  const count = Math.max(...series.map((s) => s.data.length));
  const values = series.flatMap((s) => s.data);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];

  const hasTitle = !!spec.title;
  const hasXLabels = !!spec.xLabels && spec.xLabels.length > 0;
  const legendItems =
    series.length >= 2 ? series.map((s, i) => ({ label: s.name || `Series ${i + 1}`, color: SERIES_COLORS[i] })) : [];
  const legendHeight = renderLegend(legendItems, 0).height;

  const plotTop = PAD + (hasTitle ? TITLE_H : 0);
  const legendTop = plotTop + PLOT_H + (hasXLabels ? AXIS_LABEL_H : 4);
  const H = legendTop + legendHeight + PAD;

  const plotLeft = Y_AXIS_W;
  const plotWidth = W - PAD - Y_AXIS_W;
  const slotWidth = plotWidth / count;
  const xCenter = (i: number) => plotLeft + slotWidth * (i + 0.5);

  let marks = '';
  if (spec.type === 'bar') {
    const sideMargin = Math.min(4, slotWidth * 0.1);
    const usable = slotWidth - sideMargin * 2;
    const gap = 2;
    const barW = Math.max(1, (usable - (series.length - 1) * gap) / series.length);
    const baselineY = valueToY(0, min, max, plotTop, PLOT_H);
    for (let i = 0; i < count; i++) {
      const groupLeft = plotLeft + slotWidth * i + sideMargin;
      series.forEach((s, si) => {
        const v = s.data[i];
        if (v === undefined) return;
        const y = valueToY(v, min, max, plotTop, PLOT_H);
        const top = Math.min(y, baselineY);
        const h = Math.max(0.5, Math.abs(y - baselineY));
        const x = groupLeft + si * (barW + gap);
        const label = esc(s.name || `Series ${si + 1}`);
        marks += `<path d="${barPath(x, top, barW, h, 2, v >= 0)}" fill="${SERIES_COLORS[si]}"><title>${label}: ${compactNumber(v)}</title></path>`;
      });
    }
  } else {
    series.forEach((s, si) => {
      const pts = s.data.map((v, i) => [xCenter(i), valueToY(v, min, max, plotTop, PLOT_H)] as const);
      const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
      marks += `<path d="${d}" fill="none" stroke="${SERIES_COLORS[si]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (s.data.length <= 20) {
        const label = esc(s.name || `Series ${si + 1}`);
        pts.forEach(([x, y], i) => {
          marks += `<circle cx="${x}" cy="${y}" r="2.5" fill="${SERIES_COLORS[si]}"><title>${label}: ${compactNumber(s.data[i])}</title></circle>`;
        });
      }
    });
  }

  const xLabelsMarkup = hasXLabels
    ? Array.from({ length: count }, (_, i) => spec.xLabels?.[i])
        .map((label, i) =>
          label
            ? `<text x="${xCenter(i)}" y="${plotTop + PLOT_H + 14}" font-size="11" fill="var(--og-text-muted)" text-anchor="middle">${esc(label)}</text>`
            : '',
        )
        .join('')
    : '';

  const legend = legendItems.length ? renderLegend(legendItems, legendTop).markup : '';
  return svgWrap(
    H,
    renderTitle(spec.title) + renderGrid(ticks, min, max, plotTop, PLOT_H) + marks + xLabelsMarkup + legend,
  );
}

function renderPie(spec: PieSpec): string {
  const slices = foldSlices(spec.slices);
  const angles = computePieAngles(slices.map((s) => s.value));
  const hasTitle = !!spec.title;
  const legendItems =
    slices.length >= 2 ? slices.map((s, i) => ({ label: s.label || `Slice ${i + 1}`, color: SERIES_COLORS[i] })) : [];
  const legendHeight = renderLegend(legendItems, 0).height;

  const r = 68;
  const cx = W / 2;
  const plotTop = PAD + (hasTitle ? TITLE_H : 0);
  const cy = plotTop + r + 4;
  const legendTop = cy + r + 12;
  const H = legendTop + legendHeight + PAD;

  let marks = '';
  if (slices.length === 1) {
    const label = esc(slices[0].label || 'Slice 1');
    marks = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SERIES_COLORS[0]}" stroke="var(--og-bg)" stroke-width="2"><title>${label}: ${compactNumber(slices[0].value)}</title></circle>`;
  } else {
    slices.forEach((s, i) => {
      const { start, end } = angles[i];
      if (end - start <= 0) return;
      const label = esc(s.label || `Slice ${i + 1}`);
      marks += `<path d="${arcPath(cx, cy, r, start, end)}" fill="${SERIES_COLORS[i]}" stroke="var(--og-bg)" stroke-width="2"><title>${label}: ${compactNumber(s.value)}</title></path>`;
    });
  }

  const legend = legendItems.length ? renderLegend(legendItems, legendTop).markup : '';
  return svgWrap(H, renderTitle(spec.title) + marks + legend);
}

export function renderChartBlock(specText: string): string | null {
  const spec = parseSpec(specText);
  if (!spec) return null;
  return spec.type === 'pie' ? renderPie(spec) : renderBarLine(spec);
}
