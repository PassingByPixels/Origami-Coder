// chartCard.test.ts — the `chart` tool's card plus ToolCard's dispatch onto it.
// jsdom proves the seam, not the looks: that a chart tool call becomes a real
// <svg> the user can see, and that a call the engine refused reads red.
//
// The regressions each case exists to catch:
//   1. `chart` falling through to GenericCard, which renders the spec as a
//      <pre> of JSON — the tool then "works" and draws nothing;
//   2. a chart landing collapsed behind an expand arrow, which is the silent
//      failure again wearing a green check;
//   3. a REFUSED call carrying the green check, because the engine completes it
//      (the correction has to reach the model) and only the payload says so;
//   4. a half-streamed spec painting red before the call has finished;
//   5. another tool's JSON output being drawn as a chart because the gate
//      slipped from the tool name to the shape of the result.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChartCard from './ChartCard.svelte';
import ToolCard from '../ToolCard.svelte';
import { renderChartBlock } from '../../../shared/chartBlock';
import { applyToolCall, applyToolResult } from '../../panes/chatToolMsg';

const BAR = JSON.stringify({ type: 'bar', title: 'Revenue', xLabels: ['Q1', 'Q2'], series: [{ name: 'Sales', data: [3, 5] }] });
const LINE = JSON.stringify({ type: 'line', xLabels: ['Jan', 'Feb'], series: [{ name: 'Users', data: [10, 14] }] });
const PIE = JSON.stringify({ type: 'pie', slices: [{ label: 'Chrome', value: 62 }, { label: 'Firefox', value: 12 }] });

// What the engine really returns when the model names the wrong field — the
// corrective text, verbatim from tool/chart.ts.
const REFUSAL =
  'Refused: bar needs a non-empty "series" list. Call chart again with arguments shaped like {"type":"bar","xLabels":["Q1","Q2"],"series":[{"name":"Sales","data":[3,5]}]}';

function chartCall(result: string, status = 'completed') {
  return { title: 'chart bar: Revenue', kind: 'other', toolName: 'chart', status, result };
}

describe('ChartCard — the spec becomes a picture', () => {
  it.each([
    ['bar', BAR],
    ['line', LINE],
    ['pie', PIE],
  ])('draws a %s spec as an inline <svg>', (_type, spec) => {
    const { container } = render(ChartCard, { result: spec, status: 'completed' });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.ch-error')).toBeNull();
  });

  it('shows the engine’s correction instead of an empty card when nothing drew', () => {
    const { container } = render(ChartCard, { result: REFUSAL, status: 'completed' });
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.ch-fail')?.textContent).toBe('no chart');
    // The refusal names the field AND a valid call; blanking it would leave the
    // user (and the model, on the next turn) with nothing to act on.
    expect(container.querySelector('.ch-error')?.textContent).toContain('series');
  });

  it('waits rather than painting red while a spec is still arriving', () => {
    // A partial result is not a failed one. Judging the payload before the call
    // completes would flash a red "no chart" on every streamed frame.
    const { container } = render(ChartCard, { result: '{"type":"bar","seri', status: 'in_progress' });
    expect(screen.getByText('drawing…')).toBeInTheDocument();
    expect(container.querySelector('.ch-error')).toBeNull();
  });
});

describe('ToolCard dispatch — chart', () => {
  it.each([
    ['bar', BAR],
    ['line', LINE],
    ['pie', PIE],
  ])('renders a %s chart tool call as an <svg>, with no click needed', (_type, spec) => {
    const { container } = render(ToolCard, chartCall(spec));
    expect(container.querySelector('.ch-card'), 'chart must not fall through to GenericCard').not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('does not draw another tool’s output, however chart-shaped it is', () => {
    const { container } = render(ToolCard, {
      title: 'read spec.json', kind: 'read', toolName: 'read', status: 'completed', result: BAR,
    });
    expect(container.querySelector('.ch-card')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

// The whole wire path, not just the card: the transcript's merge rules decide
// what the card is handed. A chart's result is the spec itself, so the generic
// per-card character budget cuts a big one mid-JSON and the picture is simply
// gone — the same silent failure, arriving through the transcript instead of
// the model.
describe('wire → card — a big spec survives the merge whole', () => {
  it('draws a year of daily points, which is well past the generic result budget', () => {
    const days = Array.from({ length: 365 }, (_, i) => `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`);
    const spec = JSON.stringify({
      type: 'line', title: 'Commits per day', xLabels: days,
      series: [{ name: 'commits', data: days.map((_, i) => i % 17) }],
    });
    expect(spec.length).toBeGreaterThan(2000);

    const called = applyToolCall([], { toolCallId: 'c1', title: 'chart line', toolName: 'chart', kind: 'other' }, 1);
    const merged = applyToolResult(called, { toolCallId: 'c1', content: spec, status: 'completed' }, 2);

    const { container } = render(ToolCard, {
      title: merged[0].label, kind: 'other', toolName: 'chart',
      status: 'completed', result: merged[0].toolResult,
    });
    expect(container.querySelector('svg'), 'a cut spec is not a smaller chart, it is no chart').not.toBeNull();
  });
});

// The header icon is the only status a collapsed card shows. The engine
// COMPLETES a refused chart call, so ACP status alone paints it green — and the
// title ("chart bar: refused") is prose, not a verdict.
describe('ToolCard — honest chart status icon', () => {
  it('paints the red cross on a COMPLETED call that drew nothing', () => {
    const { container } = render(ToolCard, { ...chartCall(REFUSAL), title: 'chart bar: refused' });
    expect(container.querySelector('.cross')).not.toBeNull();
    expect(container.querySelector('.check')).toBeNull();
  });

  it('keeps the green check when the spec really drew', () => {
    const { container } = render(ToolCard, chartCall(BAR));
    expect(container.querySelector('.check')).not.toBeNull();
    expect(container.querySelector('.cross')).toBeNull();
  });

  it('still spins on a chart in flight, with no verdict yet', () => {
    const { container } = render(ToolCard, chartCall('', 'in_progress'));
    expect(container.querySelector('.spinner')).not.toBeNull();
    expect(container.querySelector('.cross')).toBeNull();
  });

  it('leaves a non-chart tool’s icon alone, whatever its output looks like', () => {
    const { container } = render(ToolCard, {
      title: 'read notes.txt', kind: 'read', toolName: 'read', status: 'completed', result: 'not a spec',
    });
    expect(container.querySelector('.check')).not.toBeNull();
    expect(container.querySelector('.cross')).toBeNull();
  });
});

// --- The card's HEIGHT, which jsdom has no layout engine to measure ---
//
// The chart card opens by default and landed inside `.tool-result`, a 200px
// scroll box. Every case above still passes when it does: they assert an <svg>
// is in the DOM, and a cropped chart is still an <svg>. The size is readable
// anyway, without layout, because the shipped svg carries its own geometry —
// width="100%" capped at 520px over a 480-wide viewBox, height auto — so its
// drawn height is arithmetic on the REAL renderer's output. Paired with the
// clamp ToolCard actually ships, that is the whole defect, checked.

// path.resolve off import.meta.url, NOT `new URL('../x', import.meta.url)`:
// vite rewrites that form into an ASSET url against the dev server, so it
// resolves to http://localhost:3000/... and fileURLToPath throws before a
// single case runs. architecture.test.ts's idiom is the one that works here.
const TOOLCARD_SRC = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ToolCard.svelte'),
  'utf8',
);

/** The `max-height` ToolCard's own <style> declares for one selector, or
 *  undefined when it declares no rule for it. */
function declaredMaxHeight(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(TOOLCARD_SRC)?.[1];
  return body ? /max-height:\s*([^;]+)/.exec(body)?.[1].trim() : undefined;
}

/** A declared max-height as a number of px. `none` — and an absent rule — is
 *  no ceiling at all. */
function ceilingPx(value: string | undefined): number {
  if (!value || value === 'none') return Infinity;
  const px = /^([\d.]+)px$/.exec(value);
  if (!px) throw new Error(`max-height "${value}" is neither px nor none`);
  return Number(px[1]);
}

/** What the shipped svg really draws at a pane this wide. */
function drawnHeightPx(spec: string, paneWidth: number): number {
  const svg = renderChartBlock(spec);
  if (!svg) throw new Error(`the renderer refused this spec: ${spec}`);
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!box) throw new Error(`no viewBox on the rendered svg: ${svg.slice(0, 120)}`);
  return (Math.min(paneWidth, 520) / Number(box[1])) * Number(box[2]);
}

// The four ordinary shapes a session produces — each one titled, because a
// chart worth drawing is a chart worth naming.
const TWO_SERIES = JSON.stringify({
  type: 'bar', title: 'Revenue', xLabels: ['Q1', 'Q2'],
  series: [{ name: 'Sales', data: [3, 5] }, { name: 'Costs', data: [2, 4] }],
});
const THREE_SERIES = JSON.stringify({
  type: 'line', title: 'Users', xLabels: ['Jan', 'Feb'],
  series: [{ name: 'Free', data: [1, 2] }, { name: 'Paid', data: [3, 4] }, { name: 'Trial', data: [5, 6] }],
});
const FIVE_SLICE = JSON.stringify({
  type: 'pie', title: 'Browsers',
  slices: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Other'].map((label, i) => ({ label, value: 10 + i })),
});
const REAL_CHARTS: Array<[string, string]> = [
  ['titled bar, one series', BAR],
  ['titled bar, two series', TWO_SERIES],
  ['titled line, three series', THREE_SERIES],
  ['titled pie, five slices', FIVE_SLICE],
];
// The width these cases are measured at: the svg's own 520px cap, so the chart
// is at full size. NOT "the width a side panel gives a card" — that was an
// unverified premise and it was wrong. A VS Code side panel is commonly
// 300-400px, and measured off the shipped renderer all four charts below draw
// 120-133px at 300px and 160-177px at 400px, comfortably INSIDE the 200px
// clamp. The clamp only starts to crop above ~453px (titled 2-series bar,
// titled 3-series line), ~462px (titled 5-slice pie) and 500px (the simplest
// titled 1-series bar); at 520px the same four draw 208-230px.
//
// So what the cases below prove is that the clamp crops a chart in a WIDE pane
// — a dragged-out panel, or the card in an editor column — not that every chart
// in every panel arrived cropped.
const PANE = 520;

describe('ToolCard — a chart is shown whole, not through a 200px window', () => {
  it.each(REAL_CHARTS)('%s is taller than the generic result window at full width', (_name, spec) => {
    // The premise, from the real renderer: these are not edge cases, they are
    // what an ordinary call draws. If this ever stops being true the clamp was
    // never the problem — so it is asserted rather than assumed.
    expect(drawnHeightPx(spec, PANE)).toBeGreaterThan(ceilingPx(declaredMaxHeight('.tool-result')));
  });

  // The boundary the comment above states, held against the renderer rather
  // than against a memory of it. If this ever fails, that comment is wrong and
  // the width the clamp bites at has moved.
  it.each(REAL_CHARTS)('%s already fitted the window in a 360px panel', (_name, spec) => {
    expect(drawnHeightPx(spec, 360)).toBeLessThan(ceilingPx(declaredMaxHeight('.tool-result')));
  });

  it.each(REAL_CHARTS)('%s fits inside the ceiling the chart body actually gets', (_name, spec) => {
    // The cascade the chart container really sees: its own rule if ToolCard
    // declares one, otherwise the clamp every other body inherits.
    const ceiling = ceilingPx(declaredMaxHeight('.tool-result.chart') ?? declaredMaxHeight('.tool-result'));
    expect(ceiling, 'the chart body is capped below the height the renderer draws').toBeGreaterThan(
      drawnHeightPx(spec, PANE),
    );
  });

  it('routes the chart body — and only the chart body — into that un-clamped container', async () => {
    const chart = render(ToolCard, chartCall(BAR)).container.querySelector('.tool-result');
    expect(chart, 'the chart card opens itself, so its body is there unclicked').not.toBeNull();
    expect(chart?.classList.contains('chart'), 'a chart body must not inherit the 200px window').toBe(true);

    // The read card has to be OPENED first: every other card opens on click, so
    // a collapsed one has no `.tool-result` at all — and `null?.classList` is
    // `undefined`, which is not `false`. Asserting on the closed card would
    // have proved nothing while looking like it proved the scoping.
    const read = render(ToolCard, {
      title: 'read notes.txt', kind: 'read', toolName: 'read', status: 'completed', result: 'not a spec',
    });
    // Scoped to this render's own container: both cards are mounted into the
    // one document body, so a getByRole('button') finds the chart card's
    // header too and throws on the ambiguity.
    await fireEvent.click(read.container.querySelector('.tool-header') as HTMLElement);
    const readBody = read.container.querySelector('.tool-result');
    expect(readBody, 'the read card must have a body once opened').not.toBeNull();
    expect(readBody?.classList.contains('chart'), 'every other card keeps its scroll box').toBe(false);
  });

  // The escape has to be keyed on a chart HAVING DRAWN, not on the tool being
  // named chart. A refused call carries prose, not a spec — and the un-clamped
  // container also drops `overflow`, so that prose renders unbounded where every
  // other tool's error text sits in the same 200px scroll box. The tool name is
  // known before the result is; only the parse says a picture exists.
  it('leaves a chart that drew NOTHING inside the ordinary scroll box', () => {
    const refused = render(ToolCard, { ...chartCall(REFUSAL), title: 'chart bar: refused' })
      .container.querySelector('.tool-result');
    expect(refused, 'the chart card opens itself, refused or not').not.toBeNull();
    expect(
      refused?.classList.contains('chart'),
      'a refusal is text, not a picture; un-clamping it un-clamps the one card that never needed it',
    ).toBe(false);
  });

  // The in-flight frame is the same case seen earlier: a partial spec is not a
  // drawn chart, and the card must not thrash between clamped and un-clamped on
  // every streamed frame.
  it('does not un-clamp a chart that is still arriving', () => {
    const partial = render(ToolCard, chartCall('{"type":"bar","seri', 'in_progress'))
      .container.querySelector('.tool-result');
    expect(partial?.classList.contains('chart')).toBe(false);
  });
});

// --- The ```chart FENCE's hint, on both markdown seams ---
//
// Not the tool card. It lives in this file because this lane owns the chart's
// presentation and chartFenceHint.test.ts is another lane's; fold it in there
// when the two land.
//
// chartFenceHint.test.ts already pins the two seams to the same MARKUP. What
// drifted was the styling: the collab seam emitted `<span class="chart-hint">`
// and defined no rule for it at all, so the correction that is warning-coloured
// in chat rendered as ordinary body text in a room — a hint that does not read
// as one is the silent failure it was written to end. And on BOTH seams
// `.code-header` is justify-content: space-between, so the hint, arriving as a
// third child, was centred adrift between the lang label and the Copy button
// rather than seated beside the label it explains.
const SEAM_SRC: Array<[string, string]> = [
  ['chat', readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'MessageRow.svelte'), 'utf8')],
  ['collab', readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'chat', 'CollabMessageBubble.svelte'), 'utf8')],
];

/** One `:global(.cls)` rule's declarations, as a map — so the two seams are
 *  compared on what they MEAN, not on how each happens to be formatted (chat
 *  writes the rule over four lines, collab as a one-liner). */
function globalRule(src: string, cls: string): Record<string, string> | undefined {
  const body = new RegExp(`:global\\(\\.${cls}\\)\\s*\\{([^}]*)\\}`).exec(src)?.[1];
  if (body === undefined) return undefined;
  return Object.fromEntries(
    body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
}

describe('the chart-fence hint is styled the same on both markdown seams', () => {
  it.each(SEAM_SRC)('%s gives the hint a rule at all, and makes it read as a warning', (_seam, src) => {
    const hint = globalRule(src, 'chart-hint');
    expect(hint, 'this seam emits .chart-hint but defines no style for it').toBeDefined();
    expect(hint?.color, 'an unstyled hint is just another muted label in the header').toBe('var(--og-warning)');
  });

  it.each(SEAM_SRC)('%s seats the hint beside the lang label, which space-between alone would not', (_seam, src) => {
    // The premise, asserted rather than assumed: the header really does push
    // its children apart, which is what strands a third child in the middle.
    expect(globalRule(src, 'code-header')?.['justify-content']).toBe('space-between');
    expect(globalRule(src, 'chart-hint')?.['margin-right'], 'without this the hint floats mid-header').toBe('auto');
  });

  it('keeps the two rules identical, so neither seam can drift alone', () => {
    const [[, chat], [, collab]] = SEAM_SRC;
    expect(globalRule(collab, 'chart-hint')).toEqual(globalRule(chat, 'chart-hint'));
  });
});
