// FLIGHT AS AN ANALYTICS PAGE — the round this file exists for.
//
// The old flight strip grew 150px per step, so a 200-step run was a picture
// nobody could see the shape of: reading it meant scrolling sideways past every
// marker in turn. The replacement fits the whole run into the panel at load and
// zooms IN from there, and it answers "where did the time go" with a bar per
// tool category and a band with one row per delegate.
//
// Every test below asserts the REQUIREMENT, not the arithmetic that happens to
// implement it: is the chart the width of its container, does a delegate's bar
// sit on the delegate's own label row, is a cache loss marked where the run
// really lost its cache. The constants can move; these must not.
//
// THE FIXTURE IS RUN_STEPS' OWN SHAPE. Field names, optionality and the
// depth/parentOrdinal nesting are taken from packages/engine/src/acp/run-steps.ts
// (RunStep) — tool ids from the engine's own `Tool.define` calls — so a test
// passing here is a test against what the engine actually sends, not against
// what this view wished for. Two facts about that engine are load-bearing and
// are asserted rather than assumed: usage rides on the message (so a tool step
// commonly carries none), and a COMPACTION is now a step of its own carrying
// `{ trigger, contextBefore?, summaryTokens? }` — the shape run-steps.ts builds
// from the stored CompactionPart and the summary message that follows it.
//
// jsdom has NO layout engine (vitest.config.mts sets no `css: true`), so nothing
// here reads a computed style. Width is asserted where it is authored — the
// viewBox and the inline width the component writes — and the absence of the
// dead block under the prompts card is an owner's-eye check on a real render.

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import LabyrinthFlightView from '../components/LabyrinthFlightView.svelte';
import { agentRows } from '../components/labyrinthAgentBand';
import { categoryCounts, toolCategory } from '../components/labyrinthCategory';
import { flightChart } from '../components/labyrinthChart';
import { cacheBlindness, cacheLosses, cacheTurns, cacheIsMeasured, lossReasonText, lossFactsText } from '../components/labyrinthCache';
import { mapFade } from '../components/labyrinthHighlight';
import { scrubLabel, scrubStops, snapScrub, stepScrub } from '../components/labyrinthScrub';
import { formatClock } from '../components/labyrinthFormat';
import type { LayoutStep } from '../components/labyrinthLayout';

const T0 = 1_700_000_000_000;
const SONNET = 'anthropic/claude-sonnet-5';
const OPUS = 'anthropic/claude-opus-5';
const at = (ms: number): number => T0 + ms;

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal, kind: 'tool', title: `step ${ordinal}`, ...over,
});
const cache = (input: number, output: number, read: number, write?: number) =>
  ({ input, output, cache: { read, ...(write === undefined ? {} : { write }) } });

/**
 * One captured-shape run: 3 user turns, a foreground-detached sub-agent that
 * spawns a nested one, a background sub-agent that never rejoins, a failed step,
 * a 20-minute idle window, a model switch mid-run, and a cold first prefill.
 *
 * Every cache number is deliberate. Step 1 reads nothing because nothing is
 * cached yet; step 12 reads nothing because the model changed; step 15 reads
 * nothing because 20 minutes is past Anthropic's window. Those are the three
 * causes this view is allowed to state, one instance each.
 */
const RUN: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'rebuild the flight view', startedAt: at(0) }),
  step(1, { tool: 'read', title: 'read labyrinthMap', startedAt: at(1_000), endedAt: at(1_500), agent: 'build', model: SONNET, tokens: cache(5_000, 100, 0, 5_000) }),
  step(2, { tool: 'grep', title: 'grep flightSpans', startedAt: at(2_000), endedAt: at(2_400), agent: 'build', model: SONNET, tokens: cache(200, 80, 5_000, 0) }),
  step(3, { tool: 'edit', title: 'edit LabyrinthMap', startedAt: at(3_000), endedAt: at(3_600), agent: 'build', model: SONNET, tokens: cache(210, 90, 5_200) }),
  step(4, { tool: 'bash', title: 'npm run build', startedAt: at(4_000), endedAt: at(8_000), agent: 'build', model: SONNET, tokens: cache(220, 100, 5_400) }),
  step(5, { kind: 'subagent', tool: 'task', title: 'survey the strip', agent: 'scout', background: true, status: 'completed', childSessionId: 'ses_scout', startedAt: at(9_000), endedAt: at(60_000), model: SONNET, tokens: cache(100, 50, 5_600) }),
  step(6, { kind: 'reply', title: 'scout report', depth: 1, parentOrdinal: 5, startedAt: at(10_000), agent: 'scout', model: SONNET, tokens: cache(120, 400, 3_000) }),
  step(7, { tool: 'read', title: 'scout reads', depth: 1, parentOrdinal: 5, startedAt: at(11_000), agent: 'scout' }),
  step(8, { kind: 'subagent', tool: 'task', title: 'measure the caps', agent: 'nested', status: 'completed', depth: 1, parentOrdinal: 5, startedAt: at(12_000), endedAt: at(30_000), model: SONNET }),
  step(9, { tool: 'grep', title: 'nested greps', depth: 2, parentOrdinal: 8, startedAt: at(13_000), agent: 'nested' }),
  step(10, { kind: 'reply', title: 'here is the survey', startedAt: at(61_000), endedAt: at(61_500), agent: 'build', model: SONNET, tokens: cache(300, 120, 9_000) }),
  step(11, { kind: 'prompt', title: 'now switch model and diff it', startedAt: at(62_000) }),
  step(12, { tool: 'git_diff', title: 'git_diff the lane', startedAt: at(63_000), endedAt: at(63_500), agent: 'build', model: OPUS, tokens: cache(400, 60, 0, 400) }),
  step(13, { kind: 'error', tool: 'webfetch', title: 'webfetch failed', status: 'error', startedAt: at(64_000), agent: 'build' }),
  // --- twenty minutes of nothing at all ---
  step(14, { kind: 'prompt', title: 'back after lunch', startedAt: at(1_264_000) }),
  step(15, { tool: 'read', title: 'read it again', startedAt: at(1_265_000), endedAt: at(1_265_400), agent: 'build', model: OPUS, tokens: cache(8_000, 100, 0, 8_000) }),
  step(16, { kind: 'subagent', tool: 'task', title: 'watch the build', agent: 'watcher', background: true, status: 'running', childSessionId: 'ses_watch', startedAt: at(1_266_000), model: OPUS }),
  step(17, { kind: 'reply', title: 'watcher is up', depth: 1, parentOrdinal: 16, startedAt: at(1_267_000), agent: 'watcher' }),
];

/** A run the clock cannot order — one step with no start is enough. */
const UNTIMED: LayoutStep[] = RUN.map((s, i) => (i === 3 ? { ...s, startedAt: undefined } : s));

const WIDTH = 960;
const NOTHING: ReadonlySet<number> = new Set<number>();
const mount = (steps: readonly LayoutStep[] = RUN, over: Record<string, unknown> = {}) =>
  render(LabyrinthFlightView, {
    props: { steps, selected: null, onSelect: () => {}, dim: NOTHING, width: WIDTH, ...over },
  });
const num = (el: Element | null, attr: string): number => Number(el?.getAttribute(attr));

afterEach(() => cleanup());

describe('the chart is FIT TO WIDTH at load, and zoom only ever grows it', () => {
  it('is built at the container width, so at rest one user unit is one pixel', () => {
    const { container } = mount();
    const svg = container.querySelector('svg.fl-chart')!;
    // viewBox and rendered width start EQUAL. That is what fit-to-width means
    // here: no scaling, so the 9px row labels stay 9px and stay legible.
    expect(svg.getAttribute('viewBox')!.split(' ')[2]).toBe(String(WIDTH));
    expect((svg as SVGElement).style.width).toBe(`${WIDTH}px`);
  });

  it('zoom grows the RENDERED width past the viewBox, and reset returns it to fit', async () => {
    const { container, getByTitle, getByText } = mount();
    const svg = () => container.querySelector('svg.fl-chart')! as SVGElement;
    await fireEvent.click(getByTitle('Zoom in'));
    // Bigger ticks and text, not a smaller picture — the viewBox never moves.
    expect(parseFloat(svg().style.width)).toBeGreaterThan(WIDTH);
    expect(svg().getAttribute('viewBox')!.split(' ')[2]).toBe(String(WIDTH));
    await fireEvent.click(getByText('Reset zoom (fit)'));
    expect(svg().style.width).toBe(`${WIDTH}px`);
  });

  it('zooming out never shrinks below fit — there is nothing under the container width to see', async () => {
    const { container, getByTitle } = mount();
    await fireEvent.click(getByTitle('Zoom out'));
    expect((container.querySelector('svg.fl-chart')! as SVGElement).style.width).toBe(`${WIDTH}px`);
  });
});

describe('the SUB-AGENT band gives every delegate a row of its own', () => {
  it('each span sits on EXACTLY its own label’s y — not near it', () => {
    const { container } = mount();
    const spans = Array.from(container.querySelectorAll('.fl-span'));
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      const key = span.getAttribute('data-agent');
      const label = container.querySelector(`.fl-agent-label[data-agent="${key}"]`);
      expect(label, `every span must have a label on its row (${key})`).not.toBeNull();
      // One coordinate, literally — so "the label belongs to that bar" is a
      // checkable equality rather than a look that a tight pitch can break.
      expect(num(label, 'y')).toBe(num(span, 'y1'));
      expect(num(span, 'y2')).toBe(num(span, 'y1'));
    }
  });

  it('a nested delegate is indented under the parent that spawned it, and departs from that parent’s row', () => {
    const rows = agentRows(RUN);
    expect(rows.map((r) => [r.label, r.indent])).toEqual([['scout', 0], ['nested', 1], ['watcher', 0]]);
    const { container } = mount();
    const scout = container.querySelector('.fl-agent-label[data-agent="5"]')!;
    const nested = container.querySelector('.fl-agent-label[data-agent="8"]')!;
    expect(nested.classList.contains('nested')).toBe(true);
    expect(num(nested, 'x')).toBeGreaterThan(num(scout, 'x'));
    // The nested lane's departure leaves its PARENT's row, not the main chart.
    const chart = flightChart({ steps: RUN, rows, width: WIDTH });
    const parentY = chart.spans.find((s) => s.first === 5)!.y;
    expect(chart.spans.find((s) => s.first === 8)!.depart.endsWith(`L ${chart.spans.find((s) => s.first === 8)!.x1} ${chart.spans.find((s) => s.first === 8)!.y}`)).toBe(true);
    expect(chart.spans.find((s) => s.first === 8)!.depart).toContain(String(parentY));
  });

  it('the delegate that never rejoined runs open-ended to the axis, with a ring instead of a return', () => {
    const { container } = mount();
    const open = container.querySelector('.fl-span.open[data-agent="16"]')!;
    expect(open).not.toBeNull();
    expect(container.querySelector('.fl-open-end[data-agent="16"]')).not.toBeNull();
    // A closed delegate rejoins; the open one has no rejoin to draw at all.
    const chart = flightChart({ steps: RUN, rows: agentRows(RUN), width: WIDTH });
    expect(chart.spans.find((s) => s.first === 16)!.rejoin).toBeNull();
    expect(chart.spans.find((s) => s.first === 5)!.rejoin).not.toBeNull();
    // It runs to the axis end, because that is where the run was captured.
    expect(num(open, 'x2')).toBe(WIDTH - chart.padRight);
  });

  // THE GUTTER. The band draws a delegate's name at x=8 (x=22 nested) and its
  // BAR from x1, which can be no smaller than padLeft — so the name has a fixed
  // 120-unit gutter and nothing was budgeting it. Every other label surface in
  // this view is budgeted (labyrinthThreadFit, FLIGHT_CAPTION_CHARS,
  // labyrinthCaptions); this one was not, and `agent` is free text with
  // ' ● live' appended. jsdom has no layout engine, so a name printed over the
  // bars is only catchable as arithmetic — which is exactly how
  // labyrinthThreadFit.test.ts catches the same class.
  it('MUTATION PROOF — a long delegate name is cut to its gutter, never drawn over the bars', () => {
    const LONG: LayoutStep[] = RUN.map((s) =>
      s.ordinal === 16 ? { ...s, agent: 'background-build-watcher-for-the-vscode-package' } : s,
    );
    const { container } = mount(LONG);
    const chart = flightChart({ steps: LONG, rows: agentRows(LONG), width: WIDTH });
    const labels = Array.from(container.querySelectorAll('.fl-agent-label'));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // 6.5 over-estimates the advance of the 10px row label the way
      // THREAD_CHAR_W's 8.4 does at 13px, and is used for the 9.5px nested
      // rows too — erring wide is the safe direction for a collision test.
      const text = (label.textContent ?? '').trim();
      const right = num(label, 'x') + text.length * 6.5;
      expect(right, `"${text}" runs past the gutter into the bars`).toBeLessThanOrEqual(chart.padLeft);
    }
    // …and the full name is still readable: the bar's own tooltip carries it.
    expect(container.querySelector('.fl-span[data-agent="16"] title')!.textContent)
      .toContain('background-build-watcher-for-the-vscode-package');
  });

  it('the gap says how many were delegated and how many never came back', () => {
    const { container } = mount();
    expect(container.querySelector('.fl-gap-label')!.textContent).toBe('SUB-AGENTS — 3 delegated, 1 never rejoined');
  });
});

describe('the category bars are proportional to what the run actually did', () => {
  it('each bar is its count against the busiest category, and the counts are the depth-0 tools', () => {
    // Counted off the fixture by hand: read+grep+read = 3, edit = 1, bash = 1,
    // git_diff = 1, webfetch(failed) = 1, no plan tools, 2 spawns.
    expect(categoryCounts(RUN)).toEqual([
      { category: 'Read & search', count: 3 },
      { category: 'Edit files', count: 1 },
      { category: 'Run command', count: 1 },
      { category: 'Inspect Git', count: 1 },
      { category: 'Web', count: 1 },
      { category: 'Plan', count: 0 },
      { category: 'Delegate', count: 2 },
    ]);
    const { container } = mount();
    const width = (c: string) => (container.querySelector(`.fl-bar-fill[data-category="${c}"]`) as HTMLElement).style.width;
    expect(width('Read & search')).toBe('100%');
    expect(width('Delegate')).toBe(`${(2 / 3) * 100}%`);
    expect(width('Edit files')).toBe(`${(1 / 3) * 100}%`);
    expect(width('Plan')).toBe('0%');
  });

  it('a delegate’s OWN tools are counted in its lane, never doubled into the bars above it', () => {
    // scout ran a read and nested ran a grep; neither may reach Read & search,
    // which is the top-level agent's own time.
    expect(categoryCounts(RUN).find((c) => c.category === 'Read & search')!.count).toBe(3);
    const chart = flightChart({ steps: RUN, rows: agentRows(RUN), width: WIDTH });
    expect(chart.marks.filter((m) => m.band === 'agent').map((m) => m.ordinal).sort((a, b) => a - b)).toEqual([6, 7, 9, 17]);
  });

  it('a tool this build has never heard of is Other, never filed under a neighbour', () => {
    expect(toolCategory({ kind: 'tool', tool: 'some_future_tool' })).toBe('Other');
    expect(toolCategory({ kind: 'tool' })).toBe('Other');
    // ...and a spawn is a Delegate whatever tool made it.
    expect(toolCategory({ kind: 'subagent', tool: 'anything' })).toBe('Delegate');
  });
});

describe('hovering a category lights exactly that category’s ticks', () => {
  it('the fade set is precisely the complement of the hovered category', () => {
    const fade = mapFade(RUN, { kind: 'category', category: 'Read & search' });
    const mine = RUN.filter((s) => toolCategory(s) === 'Read & search').map((s) => s.ordinal);
    expect(mine).toEqual([1, 2, 7, 9, 15]);
    for (const ordinal of mine) expect(fade.steps.has(ordinal)).toBe(false);
    for (const s of RUN) {
      if (!mine.includes(s.ordinal)) expect(fade.steps.has(s.ordinal), `#${s.ordinal} must fade`).toBe(true);
    }
  });

  it('a bar reports its own category up, and the failed pill reports the failures', async () => {
    const seen: Array<unknown> = [];
    const { container } = mount(RUN, { onHighlight: (t: unknown) => seen.push(t) });
    await fireEvent.mouseEnter(container.querySelector('.fl-bar-row')!);
    expect(seen.at(-1)).toEqual({ kind: 'category', category: 'Read & search' });
    await fireEvent.mouseLeave(container.querySelector('.fl-bar-row')!);
    expect(seen.at(-1)).toBeNull();
    const failed = Array.from(container.querySelectorAll('.stat-cell')).find((c) => c.textContent?.includes('failed'))!;
    await fireEvent.mouseEnter(failed);
    expect(seen.at(-1)).toEqual({ kind: 'errors' });
    expect(mapFade(RUN, { kind: 'errors' }).steps.has(13)).toBe(false);
  });

  it('a faded ordinal is drawn faded, on every band it appears in', () => {
    const { container } = mount(RUN, { dim: new Set([2]) });
    const marks = Array.from(container.querySelectorAll('[data-ordinal="2"]'));
    expect(marks.length).toBeGreaterThan(1);
    for (const m of marks) expect(m.classList.contains('dim')).toBe(true);
    expect(container.querySelector('[data-ordinal="1"]')!.classList.contains('dim')).toBe(false);
  });
});

describe('the LEGACY cache derivation (a step with no engine-recorded `cache` field), which refuses to state a cause it cannot derive', () => {
  it('marks a loss at the cold start and the model switch — the client owns no window table any more, so a bare idle gap derives nothing', () => {
    const losses = cacheLosses(RUN);
    expect(losses.map((l) => [l.ordinal, l.reasons])).toEqual([
      [1, ['cold']],       // first billed prefill of the run
      [12, ['model']],     // sonnet -> opus, 1.5s later
      [15, []],            // 20 minutes idle: the deleted policy table used to call this `ttl`
    ]);
    expect(losses.every((l) => l.cause === undefined)).toBe(true);
    const { container } = mount();
    expect(Array.from(container.querySelectorAll('.fl-loss')).map((n) => Number(n.getAttribute('data-loss'))))
      .toEqual([1, 12, 15]);
  });

  it('a longer idle gap still derives nothing — there is no window left to compare it against', () => {
    // Same run, same models, pulled even further out: whether the gap is 20
    // minutes or 3 hours, the legacy path has no table to judge it by any more.
    const longer = RUN.map((s) => (s.startedAt !== undefined && s.startedAt >= at(1_264_000)
      ? { ...s, startedAt: s.startedAt + 10_000_000, ...(s.endedAt === undefined ? {} : { endedAt: s.endedAt + 10_000_000 }) }
      : s));
    expect(cacheLosses(longer).find((l) => l.ordinal === 15)!.reasons).toEqual([]);
  });

  it('an underivable loss says "unknown", labelled as the viewer\'s own guess', () => {
    const orphan = cacheLosses(RUN.map((s) => (s.ordinal === 15 ? { ...s, model: OPUS } : s)))
      .find((l) => l.ordinal === 15)!;
    const text = lossReasonText({ ...orphan, reasons: [] });
    expect(text).toContain('Derived by the viewer (run recorded before 0.4.160)');
    expect(text).toContain('unknown');
    // It used to say compactions "are not projected into run steps". They are,
    // so the sentence would now be a lie; what it says instead is that the
    // derivation RAN and found none of its causes. It also no longer claims an
    // idle-window check it does not run.
    expect(text).not.toContain('not projected');
    expect(text).toContain('not a context compaction');
    expect(text).not.toMatch(/idle window/);
  });

  it('cache read, write and hit ratio are summed per TURN, not per step', () => {
    const turns = cacheTurns(RUN);
    expect(turns.map((t) => t.ordinal)).toEqual([0, 11, 14]);
    expect(turns[0]!.read).toBe(33_200);
    expect(turns[0]!.write).toBe(5_000);
    expect(Math.round(turns[0]!.ratio! * 100)).toBe(84);
    // The two turns that lost their cache read nothing back, and say 0% — a
    // measured zero, unlike an unmeasured one.
    expect(turns[1]!.ratio).toBe(0);
    expect(turns[2]!.ratio).toBe(0);
  });

  it('a provider that never reported cache gets no losses and no ratio — that is missing measurement, not a cold cache', () => {
    const local = RUN.map((s) => (s.tokens ? { ...s, tokens: { input: s.tokens.input, output: s.tokens.output } } : s));
    expect(cacheIsMeasured(local)).toBe(false);
    expect(cacheLosses(local)).toEqual([]);
    // No ratio AT ALL now. It used to be derived from input alone, which prints
    // 0% — the exact reading ("the cache failed here") this panel exists to
    // refuse for a provider that never measured one.
    expect(cacheTurns(local)[0]!.ratio).toBeUndefined();
    expect(cacheTurns(local)[0]!.blind).toBe(true);
    const { container } = mount(local);
    expect(container.textContent).toContain('reported no cache tokens');
    expect(container.querySelectorAll('.fl-loss')).toHaveLength(0);
  });

  it('carries no hard-coded per-provider policy table any more — that guess is the engine\'s to make now', () => {
    const { container } = mount();
    expect(container.querySelector('.fl-policy')).toBeNull();
    expect(container.textContent).not.toMatch(/never fetched/i);
  });
});

/**
 * A run recorded by the ENGINE (0.4.160+, t-rylq3t): every step carries a
 * `cache` block, hit or miss, and a miss carries exactly one `cause` in the
 * engine's own precedence. The client reads it verbatim — none of these is
 * re-derived, and `reasons` (the legacy field) stays empty throughout.
 */
const ENGINE_LOCAL = 'vllm/GLM-5.3-Flash-EXL3';
const engineHit = (input: number, output: number, read: number) =>
  ({ input, output, cache: { read, write: 0 } });
const engineMiss = (input: number, output: number) =>
  ({ input, output, cache: { read: 0, write: input } });

const ENGINE_RUN: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'engine-recorded run', startedAt: at(0) }),
  step(1, { tool: 'read', title: 'cold', startedAt: at(1_000), endedAt: at(1_400), model: SONNET,
    tokens: engineMiss(5_000, 100), cache: { cause: 'cold' } }),
  step(2, { tool: 'read', title: 'model switch', startedAt: at(2_000), endedAt: at(2_400), model: OPUS,
    tokens: engineMiss(400, 60), cache: { cause: 'model' } }),
  step(3, { tool: 'read', title: 'right after a compaction', startedAt: at(3_000), endedAt: at(3_400), model: OPUS,
    tokens: engineMiss(4_000, 90), cache: { cause: 'compaction' } }),
  step(4, { tool: 'read', title: 'idle', startedAt: at(4_000), endedAt: at(4_400), model: OPUS,
    tokens: engineMiss(300, 50), cache: { cause: 'idle', idleMs: 7 * 60_000, ttlSeconds: 300 } }),
  step(5, { tool: 'read', title: 'system prompt changed', startedAt: at(5_000), endedAt: at(5_400), model: OPUS,
    tokens: engineMiss(300, 40), cache: { cause: 'system' } }),
  step(6, { tool: 'read', title: 'tool list changed', startedAt: at(6_000), endedAt: at(6_400), model: OPUS,
    tokens: engineMiss(300, 40), cache: { cause: 'tools' } }),
  step(7, { tool: 'read', title: 'a message came back rewritten', startedAt: at(7_000), endedAt: at(7_400), model: OPUS,
    tokens: engineMiss(300, 40),
    cache: { cause: 'history', divergence: { message: 4, role: 'user', offset: 120, source: 'tool-aging' } } }),
  step(8, { tool: 'read', title: 'under the minimum', startedAt: at(8_000), endedAt: at(8_400), model: OPUS,
    tokens: engineMiss(100, 20), cache: { cause: 'small' } }),
  step(9, { tool: 'read', title: 'provider missed, hosted', startedAt: at(9_000), endedAt: at(9_400), model: OPUS,
    tokens: engineMiss(300, 40), cache: { cause: 'provider' } }),
  step(10, { tool: 'read', title: 'provider missed, local', startedAt: at(10_000), endedAt: at(10_400), model: ENGINE_LOCAL,
    tokens: engineMiss(15_000, 40), cache: { cause: 'provider' } }),
];

describe('the ENGINE-recorded cause (0.4.160+) is read verbatim, never re-derived', () => {
  it('every engine cause reaches `cacheLosses` unchanged, with the legacy `reasons` left empty', () => {
    const losses = cacheLosses(ENGINE_RUN);
    expect(losses.map((l) => l.cause)).toEqual([
      'cold', 'model', 'compaction', 'idle', 'system', 'tools', 'history', 'small', 'provider', 'provider',
    ]);
    expect(losses.every((l) => l.reasons.length === 0)).toBe(true);
  });

  it('one sentence per cause, and never the legacy label — the engine said it, not the viewer', () => {
    const [cold, model, compaction, idle, system, tools, history, small, provider, providerLocal] = cacheLosses(ENGINE_RUN);
    expect(lossReasonText(cold!)).toBe('first billed prefill of the run — nothing was cached yet');
    expect(lossReasonText(model!)).toBe(`model changed, ${SONNET} to ${OPUS} — a cache entry does not carry across models`);
    expect(lossReasonText(compaction!)).toContain('the context was compacted just before this step');
    expect(lossReasonText(idle!)).toBe('idle 7m before this step, past the provider’s 5m window');
    expect(lossReasonText(system!)).toBe('the system prompt changed');
    expect(lossReasonText(tools!)).toBe('the tool list changed');
    expect(lossReasonText(history!)).toBe('message 4 (user) was rewritten — tool aging');
    expect(lossReasonText(small!)).toContain('minimum cacheable size');
    expect(lossReasonText(provider!)).not.toContain('local server');
    expect(lossReasonText(providerLocal!)).toContain('local server evicted the prefix');
    for (const loss of cacheLosses(ENGINE_RUN)) expect(lossReasonText(loss)).not.toContain('Derived by the viewer');
  });

  it('the facts line carries idle and divergence, only when the engine sent them', () => {
    const [, , , idle, , , history] = cacheLosses(ENGINE_RUN);
    expect(lossFactsText(idle!)).toBe('idle 7m');
    expect(lossFactsText(history!)).toBe('message 4 (user) diverged — tool aging');
    // `cold` carries no idle/divergence/warmed facts at all.
    const [cold] = cacheLosses(ENGINE_RUN);
    expect(lossFactsText(cold!)).toBeUndefined();
  });

  it('`stopped` names what changed while the engine was parked, never a plain cold start', () => {
    const restored: LayoutStep[] = [
      step(0, { kind: 'prompt', title: 'restored run', startedAt: at(0) }),
      step(1, { tool: 'read', title: 'tools moved during the stop', startedAt: at(1_000), endedAt: at(1_400), model: OPUS,
        tokens: engineMiss(5_000, 100), cache: { cause: 'stopped', stopped: ['tools'], idleMs: 20 * 60_000 } }),
      step(2, { tool: 'read', title: 'system and history moved', startedAt: at(2_000), endedAt: at(2_400), model: OPUS,
        tokens: engineMiss(5_000, 100), cache: { cause: 'stopped', stopped: ['system', 'history'] } }),
      step(3, { tool: 'read', title: 'history alone', startedAt: at(3_000), endedAt: at(3_400), model: OPUS,
        tokens: engineMiss(5_000, 100), cache: { cause: 'stopped', stopped: ['history'] } }),
    ];
    const [tools, both, history] = cacheLosses(restored);
    expect(tools!.cause).toBe('stopped');
    expect(lossReasonText(tools!)).toBe(
      'the tool list changed while the engine was parked (settings, instructions, skills, agents or MCP servers were edited) — the restored request could not reuse the cache',
    );
    expect(lossFactsText(tools!)).toBe('changed while parked: the tool list · idle 20m');
    expect(lossReasonText(both!)).toContain('the system prompt and the earlier messages changed while the engine was parked');
    // A history-only change was not an edit of settings, so no such hint.
    expect(lossReasonText(history!)).toBe(
      'the earlier messages changed while the engine was parked — the restored request could not reuse the cache',
    );
    for (const loss of [tools, both, history]) expect(lossReasonText(loss!)).not.toContain('first billed prefill');
  });

  it('a step with `cache` but no `ttlSeconds` never prints "idle" — a window-less provider reads as `provider`', () => {
    const provider = cacheLosses(ENGINE_RUN).find((l) => l.ordinal === 9)!;
    expect(provider.facts?.ttlSeconds).toBeUndefined();
    expect(lossReasonText(provider)).not.toContain('idle');
  });

  it('a mixed run reads the engine cause where the step has one, and falls back only where it does not', () => {
    const mixed: LayoutStep[] = [
      step(0, { kind: 'prompt', title: 'mixed', startedAt: at(0) }),
      step(1, { tool: 'read', title: 'engine cold', startedAt: at(1_000), endedAt: at(1_400), model: SONNET,
        tokens: engineMiss(5_000, 100), cache: { cause: 'cold' } }),
      step(2, { tool: 'read', title: 'engine hit', startedAt: at(2_000), endedAt: at(2_400), model: SONNET,
        tokens: engineHit(200, 80, 5_000), cache: {} }),
      // No `cache` field at all — a run recorded before 0.4.160, or spliced onto one that was.
      step(3, { tool: 'read', title: 'legacy loss', startedAt: at(3_000), endedAt: at(3_400), model: OPUS,
        tokens: engineMiss(210, 90) }),
    ];
    const losses = cacheLosses(mixed);
    expect(losses.map((l) => [l.ordinal, l.cause, l.reasons])).toEqual([
      [1, 'cold', []],
      [3, undefined, ['model']],
    ]);
    expect(lossReasonText(losses[0]!)).not.toContain('Derived by the viewer');
    expect(lossReasonText(losses[1]!)).toContain('Derived by the viewer (run recorded before 0.4.160)');
  });

  it('the panel prints the engine’s sentence and a facts line, no policy table', () => {
    const { container } = mount(ENGINE_RUN);
    expect(container.querySelector('.fl-policy')).toBeNull();
    const text = container.textContent!;
    expect(text).toContain('the system prompt changed');
    const factsLines = Array.from(container.querySelectorAll('.fl-loss-facts')).map((n) => n.textContent);
    expect(factsLines).toContain('idle 7m');
  });
});

/**
 * t-s3p7cg: a loss row's text now matches its KIND — a Claude Code
 * transcript, a request that reported no cache measurement at all, or a
 * genuine pre-0.4.160 engine miss — instead of all three sharing the one
 * "Derived by the viewer … unknown" sentence the owner saw at 21:18 on a
 * Claude Code run two hours after the last engine step.
 */
describe('a loss row\'s text matches its KIND, not one shared guess (t-s3p7cg)', () => {
  it('a Claude Code run never runs the legacy derivation — one fixed line, never "unknown"', () => {
    const losses = cacheLosses(RUN, true);
    expect(losses.length).toBeGreaterThan(0);
    for (const loss of losses) {
      expect(loss.claude).toBe(true);
      expect(loss.reasons).toEqual([]);
      const text = lossReasonText(loss);
      expect(text).toBe('Claude Code session: the transcript records tokens but no cause');
      expect(text).not.toContain('Derived by the viewer');
      expect(text).not.toContain('unknown');
    }
  });

  it('a request with no cache field at all reads "unmeasured", never "unknown" — even on a model that reports elsewhere', () => {
    // Only step 15 loses its `cache` field; step 12 (same OPUS model) still
    // reports a write, so OPUS is NOT run-wide blind — this is a per-request fact.
    const noField = RUN.map((s) => (s.ordinal === 15 ? { ...s, tokens: { input: s.tokens!.input, output: s.tokens!.output } } : s));
    const loss = cacheLosses(noField).find((l) => l.ordinal === 15)!;
    expect(loss.unmeasured).toBe(true);
    expect(loss.claude).toBeUndefined();
    expect(loss.reasons).toEqual([]);
    const text = lossReasonText(loss);
    expect(text).toBe('unmeasured, this provider reports no cache tokens; never unknown');
    expect(text).not.toContain('Derived by the viewer');
  });

  it('an engine run with a genuinely underivable loss still says "unknown", labelled as the viewer\'s own guess', () => {
    // Unchanged behaviour, pinned here alongside its two new siblings: a real
    // pre-0.4.160 engine row (claudeRun false, cache field present) keeps the
    // legacy label and its "unknown" fallback exactly as before.
    const orphan = cacheLosses(RUN.map((s) => (s.ordinal === 15 ? { ...s, model: OPUS } : s)))
      .find((l) => l.ordinal === 15)!;
    const text = lossReasonText({ ...orphan, reasons: [] });
    expect(text).toContain('Derived by the viewer (run recorded before 0.4.160)');
    expect(text).toContain('unknown');
  });

  it('the panel renders the Claude Code text when claudeRun is set, never the legacy label', () => {
    const { container } = mount(RUN, { claudeRun: true });
    expect(container.textContent).toContain('Claude Code session: the transcript records tokens but no cause');
    expect(container.textContent).not.toContain('Derived by the viewer');
  });
});

describe('idle windows are read across EVERY depth, so delegated work is never mistaken for idleness', () => {
  it('shades the twenty minutes nobody worked, and only that', () => {
    const chart = flightChart({ steps: RUN, rows: agentRows(RUN), width: WIDTH });
    expect(chart.idle).toHaveLength(1);
    expect(chart.idle[0]!.label).toBe('idle 20m');
    const { container } = mount();
    expect(container.querySelectorAll('.fl-idle')).toHaveLength(1);
  });

  it('the stretch where only a sub-agent was working is NOT idle', () => {
    // The trunk says nothing between 13s and 61s, but the scout's span runs to
    // 60s. Reading the trunk alone would shade 48 seconds of real work.
    const chart = flightChart({ steps: RUN, rows: agentRows(RUN), width: WIDTH });
    const scoutStretch = chart.idle.filter((w) => w.label !== 'idle 20m');
    expect(scoutStretch).toEqual([]);
  });

  it('one turn LINE per user prompt, and the labels drop rather than smear when two turns share a column', () => {
    const { container } = mount();
    // The LINE is the fact and there is one per prompt, always. Turn 2 lands a
    // minute after turn 1 in a twenty-minute run, so at this width its LABEL
    // would be printed through turn 1's — it is dropped, never smeared.
    expect(container.querySelectorAll('.fl-turn')).toHaveLength(3);
    expect(Array.from(container.querySelectorAll('.fl-turn-label')).map((n) => n.textContent))
      .toEqual(['Turn 1', 'Turn 3']);
    cleanup();

    // ...and the drop is DENSITY, not policy: give the same run a wider panel
    // and the label comes back, because now there is room for it.
    const wide = mount(RUN, { width: 1_400 });
    expect(wide.container.querySelectorAll('.fl-turn')).toHaveLength(3);
    expect(Array.from(wide.container.querySelectorAll('.fl-turn-label')).map((n) => n.textContent))
      .toEqual(['Turn 1', 'Turn 2', 'Turn 3']);
  });
});

describe('a run the clock cannot order says so by drawing no lengths at all', () => {
  it('drops the spans, the idle shading and the axis clock rather than inventing a scale', () => {
    const chart = flightChart({ steps: UNTIMED, rows: agentRows(UNTIMED), width: WIDTH });
    expect(chart.timeBased).toBe(false);
    expect(chart.spans).toEqual([]);
    expect(chart.idle).toEqual([]);
    expect(chart.axis).toEqual([]);
    // ...but the steps are still all there, evenly spaced, in run order.
    const spine = chart.marks.filter((m) => m.band === 'all');
    expect(spine).toHaveLength(UNTIMED.length);
    expect(spine[0]!.x).toBeLessThan(spine[spine.length - 1]!.x);
    const { container } = mount(UNTIMED);
    expect(container.textContent).toContain('Order axis');
  });
});

describe('the header is the run’s SHAPE, and never a second spend readout', () => {
  it('counts steps, turns, span, delegates and failures — and prints no tokens or cost', () => {
    const { container } = mount();
    const head = container.querySelector('.fl-head')!.textContent!.replace(/\s+/g, ' ');
    expect(head).toContain('18 steps');
    expect(head).toContain('3 turns');
    expect(head).toContain('3 delegated');
    expect(head).toContain('1 failed');
    // Run spend is LabyrinthUsageStrip's, one component above this view. Two
    // places printing one number is how they end up disagreeing.
    expect(head).not.toMatch(/token|\$|cached/i);
  });

  it('renders through the spend strip’s own cell component, not a header style of its own', () => {
    const { container } = mount();
    // `.stat-cell` is LabyrinthStatPills.svelte's — the same element the run
    // spend strip's raw row is built from.
    expect(container.querySelectorAll('.fl-head .stat-cell').length).toBeGreaterThan(3);
  });

  it('a run with no failures gets no failed cell at all — never a 0 that reads as measured', () => {
    const clean = RUN.filter((s) => s.kind !== 'error');
    const { container } = mount(clean);
    expect(container.querySelector('.fl-head')!.textContent).not.toContain('failed');
  });
});

describe('clicking anything on the page opens that step', () => {
  it('a tick, a prompt card and a cache-loss row all select their own step', async () => {
    const picked: number[] = [];
    const { container } = mount(RUN, { onSelect: (s: LayoutStep) => picked.push(s.ordinal) });
    await fireEvent.click(container.querySelector('[data-ordinal="4"]')!);
    await fireEvent.click(container.querySelectorAll('.fl-prompt')[1]!);
    await fireEvent.click(container.querySelector('.fl-loss-btn[data-loss="15"]')!);
    expect(picked).toEqual([4, 11, 15]);
  });

  it('the footer names the picked step instead of the prompt to pick one', () => {
    const { container } = mount(RUN, { selected: 12 });
    const foot = container.querySelector('.fl-foot')!.textContent!.replace(/\s+/g, ' ');
    expect(foot).toContain('#12');
    expect(foot).toContain('git_diff');
    expect(mount(RUN).container.querySelector('.fl-foot')!.textContent).toContain('Click a tick');
  });
});

/**
 * A COMPACTION, as the engine now projects it. The step shape is run-steps.ts's
 * own: kind `compaction`, the owning message's instant, and a `compaction`
 * block whose `trigger` always arrives while the two numbers arrive only when
 * the store held them.
 *
 * The numbers are the run's own: 152,400 was the last billed prompt before the
 * compaction, and the fresh 4,000-token prefill on step 4 is what it cost.
 */
const COMPACTED: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'a long job', startedAt: at(0) }),
  step(1, { tool: 'read', title: 'read it', startedAt: at(1_000), endedAt: at(1_400), model: SONNET, tokens: cache(15_000, 100, 0, 15_000) }),
  step(2, { tool: 'grep', title: 'grep it', startedAt: at(2_000), endedAt: at(2_400), model: SONNET, tokens: cache(400, 120, 152_400) }),
  step(3, {
    kind: 'compaction', title: 'Context compacted', startedAt: at(3_000), model: SONNET,
    compaction: { trigger: 'auto', contextBefore: 152_400, summaryTokens: 3_100 },
  }),
  step(4, { tool: 'edit', title: 'edit it', startedAt: at(4_000), endedAt: at(4_400), model: SONNET, tokens: cache(4_000, 90, 0, 4_000) }),
  step(5, { tool: 'read', title: 'read again', startedAt: at(5_000), endedAt: at(5_400), model: SONNET, tokens: cache(300, 80, 4_000) }),
  step(6, { tool: 'bash', title: 'build', startedAt: at(6_000), endedAt: at(6_400), model: SONNET, tokens: cache(500, 40, 0, 500) }),
];

describe('a compaction is drawn as the EVENT it is, and named as a cause', () => {
  it('lands on the spine as a diamond, not as a bar on a category row', () => {
    const chart = flightChart({ steps: COMPACTED, rows: agentRows(COMPACTED), width: WIDTH });
    const marks = chart.marks.filter((m) => m.ordinal === 3);
    // ONE mark, on the run's own outline. A diamond because it has no duration:
    // drawn like a tool step it would be a one-pixel tick nobody could hit.
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ band: 'all', diamond: true });
    const { container } = mount(COMPACTED);
    expect(container.querySelector('path[data-ordinal="3"]')).not.toBeNull();
  });

  it('changes no category count — a compaction is not tool time', () => {
    // The sharpest form of the requirement: the bars are IDENTICAL to the same
    // run with the compaction taken out.
    expect(categoryCounts(COMPACTED))
      .toEqual(categoryCounts(COMPACTED.filter((s) => s.kind !== 'compaction')));
    expect(toolCategory(COMPACTED[3]!)).toBe('Other');
  });

  /** The BANNER's own text. Read from its element rather than the whole page:
   *  the loss list below also says the word "summary", in a sentence about why
   *  the prefill went cold. */
  const banner = (steps: readonly LayoutStep[]): string =>
    (mount(steps).container.querySelector('.fl-compacted')?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('says so in the cards, with the context it threw away', () => {
    // The clock is LOCAL, so the sentence is pinned and the time is shaped.
    expect(banner(COMPACTED)).toMatch(/^Context compacted once at \d\d:\d\d:\d\d · 152\.4k of context before it · 3,100 summary$/);
  });

  it('a run that never compacted gets NO banner — never an empty one', () => {
    expect(mount(RUN).container.querySelector('.fl-compacted')).toBeNull();
  });

  it('the fresh prefill right after it is a loss with reason `compaction`', () => {
    const losses = cacheLosses(COMPACTED);
    const after = losses.find((l) => l.ordinal === 4)!;
    expect(after.reasons).toEqual(['compaction']);
    expect(lossReasonText(after)).toContain('compacted');
    // The FIRST prefill of the run is still cold, not compaction: nothing was
    // compacted before it.
    expect(losses.find((l) => l.ordinal === 1)!.reasons).toEqual(['cold']);
  });

  it('blames ONE compaction once — the next unexplained loss stays unknown', () => {
    // Step 6 reads nothing back either, on the same model, one second later.
    // Attributing that to the same compaction would invent a second event.
    expect(cacheLosses(COMPACTED).find((l) => l.ordinal === 6)!.reasons).toEqual([]);
  });

  it('two compactions each answer for their OWN loss, and the banner counts them', () => {
    // A second compaction, and a second fresh prefill after it. One event may
    // only ever explain one loss, so BOTH must be named — and the banner drops
    // the token tail, because with two compactions "it" has no referent.
    const twice: LayoutStep[] = [
      ...COMPACTED,
      step(7, {
        kind: 'compaction', title: 'Context compacted', startedAt: at(7_000), model: SONNET,
        compaction: { trigger: 'overflow', contextBefore: 90_000 },
      }),
      step(8, { tool: 'read', title: 'after the second', startedAt: at(8_000), endedAt: at(8_400), model: SONNET, tokens: cache(6_000, 60, 0, 6_000) }),
    ];
    expect(cacheLosses(twice).filter((l) => l.reasons.includes('compaction')).map((l) => l.ordinal))
      .toEqual([4, 8]);
    expect(banner(twice)).toMatch(/^Context compacted 2 times at \d\d:\d\d:\d\d, \d\d:\d\d:\d\d$/);
  });

  it('the numbers are OPTIONAL — an unrecorded one prints nothing, never a 0', () => {
    const bare = COMPACTED.map((s) => (s.ordinal === 3 ? { ...s, compaction: { trigger: 'manual' as const } } : s));
    // The whole tail is gone, not zeroed: `0 of context before it` would be a
    // measurement nobody made.
    expect(banner(bare)).toMatch(/^Context compacted once at \d\d:\d\d:\d\d$/);
  });
});

/**
 * A CACHE-BLIND provider — the owner's second defect, reproduced.
 *
 * Seven billed prefills a second apart on a local server that reports cache
 * read 0 AND write 0 on every call (the token-burn survey: 26.9% of turns on
 * lmstudio/sglang do exactly this). The input sizes are the owner's own.
 */
const LOCAL = 'lmstudio/sglang-qw';
const FRESH = [15_100, 15_200, 15_600, 15_700, 16_400, 23_200, 26_000];
const BLIND: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'run it locally', startedAt: at(0) }),
  ...FRESH.map((input, i) => step(i + 1, {
    tool: 'read', title: `read ${i}`, startedAt: at((i + 1) * 1_000), endedAt: at((i + 1) * 1_000 + 400),
    model: LOCAL, tokens: cache(input, 100, 0, 0),
  })),
];

/** The same defect with a caching provider in the run too. */
const MIXED: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'mixed providers', startedAt: at(0) }),
  step(1, { tool: 'read', title: 'cold read', startedAt: at(1_000), endedAt: at(1_400), model: SONNET, tokens: cache(5_000, 100, 0, 5_000) }),
  step(2, { tool: 'grep', title: 'warm grep', startedAt: at(2_000), endedAt: at(2_400), model: SONNET, tokens: cache(200, 80, 5_000) }),
  step(3, { tool: 'read', title: 'local read', startedAt: at(3_000), endedAt: at(3_100), model: LOCAL, tokens: cache(15_100, 90, 0, 0) }),
  step(4, { tool: 'read', title: 'local read', startedAt: at(4_000), endedAt: at(4_100), model: LOCAL, tokens: cache(15_200, 90, 0, 0) }),
  step(5, { tool: 'edit', title: 'warm edit', startedAt: at(5_000), endedAt: at(5_400), model: SONNET, tokens: cache(300, 70, 5_200) }),
];

describe('a provider that reports no cache is not a provider that lost one', () => {
  it('the zeros ARE reported, and are still not read as seven losses', () => {
    // The old gate passes: the fields are present, they just say 0. That is
    // exactly why the run drew a loss per step, and why the fix cannot be a
    // wider `cacheIsMeasured`.
    expect(cacheIsMeasured(BLIND)).toBe(true);
    expect(cacheLosses(BLIND)).toEqual([]);
    const blindness = cacheBlindness(BLIND);
    expect(blindness.all).toBe(true);
    expect(blindness.providers).toEqual(['lmstudio']);
  });

  it('the panel names the provider once instead of printing a 0% hit rate', () => {
    const { container } = mount(BLIND);
    const text = container.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('not reported by lmstudio');
    expect(container.querySelectorAll('.fl-loss')).toHaveLength(0);
    expect(container.querySelectorAll('.fl-loss-btn')).toHaveLength(0);
  });

  it('its turn bar is fresh-only and muted, not a measured 0%', () => {
    const turns = cacheTurns(BLIND);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ blind: true, read: 0 });
    expect(turns[0]!.ratio).toBeUndefined();
    const { container } = mount(BLIND);
    expect(container.querySelectorAll('.fl-turn-row.blind')).toHaveLength(1);
    // The fill is what "fresh-only" means on screen: nothing was read back.
    expect((container.querySelector('.fl-turn-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('excuses ONLY the blind provider — the caching one keeps every rule', () => {
    const blindness = cacheBlindness(MIXED);
    expect(blindness.all).toBe(false);
    expect([...blindness.models]).toEqual([LOCAL]);
    // The Anthropic cold start is still a loss; the two local steps are not.
    expect(cacheLosses(MIXED).map((l) => l.ordinal)).toEqual([1]);
  });

  it('one reported read anywhere is enough — the provider is not blind again', () => {
    const measures = MIXED.map((s) => (s.ordinal === 4 ? { ...s, tokens: cache(15_200, 90, 900) } : s));
    expect(cacheBlindness(measures).models.has(LOCAL)).toBe(false);
    // ...and step 3, whose zeros were excused a moment ago, is a real loss
    // again — with the model change that actually explains it.
    expect(cacheLosses(measures).find((l) => l.ordinal === 3)!.reasons).toEqual(['model']);
  });
});

/**
 * THE TIME CURSOR — the owner's report was "trying to click the small lines is
 * too hard", and it is a fair one: a tool tick here is 1.6 user units wide.
 *
 * The tests below assert the REQUIREMENT — drop the cursor anywhere and the
 * NEARER tick opens, drag it and the inspector follows, arrow-key it and it
 * moves one step — not the arithmetic that implements any of them.
 *
 * TWO MECHANICS ARE FORCED BY THE ENVIRONMENT, and both are deliberate:
 *  - jsdom gives every element a zero-size rect, and a clientX means nothing
 *    against a zero-width box. So the chart's rect is stubbed at the width the
 *    component itself renders (chart.width at rest), which is the one number a
 *    real browser would report and the component already writes as its style.
 *  - the events are built as MouseEvent with a `pointer*` type. jsdom has no
 *    PointerEvent constructor, so fireEvent.pointerDown falls back to a plain
 *    Event, which carries no clientX at all — the coordinate this whole feature
 *    turns on would silently be undefined.
 */
describe('the SCRUB LINE puts a step under the pointer without hitting its tick', () => {
  const ROWS = agentRows(RUN);
  const CHART = flightChart({ steps: RUN, rows: ROWS, width: WIDTH });
  /** Where a given step's tick is drawn on the All-activity spine. */
  const tickX = (ordinal: number): number =>
    CHART.marks.find((m) => m.band === 'all' && m.ordinal === ordinal)!.x;

  const withRect = (svg: Element, width: number): void => {
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width, height: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
  };
  const pointer = (el: Element, type: string, clientX: number) =>
    fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));

  const armed = () => {
    const picked: number[] = [];
    const view = mount(RUN, { onSelect: (s: LayoutStep) => picked.push(s.ordinal) });
    const svg = view.container.querySelector('svg.fl-chart')!;
    withRect(svg, WIDTH);
    return { ...view, svg, picked };
  };
  const cursorX = (container: Element): number =>
    Number(container.querySelector('.fl-scrub')!.getAttribute('x1'));

  it('an x BETWEEN two ticks opens the nearer step, not the later one', () => {
    const stops = scrubStops(CHART);
    const a = tickX(2);
    const b = tickX(3);
    expect(b).toBeGreaterThan(a);
    // 40% of the way across is nearer the earlier tick; 60% nearer the later.
    expect(snapScrub(stops, a + (b - a) * 0.4)!.ordinal).toBe(2);
    expect(snapScrub(stops, a + (b - a) * 0.6)!.ordinal).toBe(3);
    // ...and an EXACT tie keeps the earlier one, so a drag arriving from the
    // right does not skip past the step it is arriving at. Stated on exact
    // inputs on purpose: two ticks off a wall clock almost never straddle a
    // float midpoint exactly, so asserting it on RUN would assert nothing.
    expect(snapScrub([{ x: 10, ordinal: 3 }, { x: 20, ordinal: 4 }], 15)!.ordinal).toBe(3);
  });

  it('a delegate span REJOIN is a place the cursor can land, not just the ticks', () => {
    // The scout returns at 60s, long after its last inlined child step. Nothing
    // is drawn there but the rejoin arrow, and it is still a real place.
    const rejoin = CHART.spans.find((s) => s.first === 5)!.x2;
    const stops = scrubStops(CHART);
    expect(stops.some((s) => s.x === rejoin && s.ordinal === 5)).toBe(true);
    expect(snapScrub(stops, rejoin)!.ordinal).toBe(5);
  });

  it('a pointer down ANYWHERE on the chart places the cursor and opens that step', async () => {
    const { container, svg, picked } = armed();
    expect(container.querySelector('.fl-scrub')).toBeNull();
    // A HUNDRED user units clear of any tick — out in the twenty-minute idle
    // window, where the reader has nothing to aim at. Step 13 is still the last
    // thing that happened before there, so step 13 is what opens.
    await pointer(svg, 'pointerdown', tickX(13) + 100);
    expect(picked).toEqual([13]);
    expect(cursorX(container)).toBe(tickX(13));
  });

  it('the cursor opens EXACTLY what clicking that step tick opens', async () => {
    const { container, svg, picked } = armed();
    await fireEvent.click(container.querySelector('[data-ordinal="12"]')!);
    const byClick = [...picked];
    picked.length = 0;
    // 30% of the way on towards the NEXT step, so the pointer is not on step
    // 12's tick at all — and the same step still opens, by the same call.
    await pointer(svg, 'pointerdown', tickX(12) + (tickX(13) - tickX(12)) * 0.3);
    expect(picked).toEqual(byClick);
    expect(picked).toEqual([12]);
  });

  it('dragging walks the inspector along the run, one step per tick crossed', async () => {
    const { svg, picked } = armed();
    await pointer(svg, 'pointerdown', tickX(1));
    await pointer(svg, 'pointermove', tickX(2));
    await pointer(svg, 'pointermove', tickX(3));
    await pointer(svg, 'pointermove', tickX(4));
    expect(picked).toEqual([1, 2, 3, 4]);
    // A move that stays on the same tick must not re-open it: one drag would
    // otherwise fire the inspector once per pixel crossed.
    await pointer(svg, 'pointermove', tickX(4) + 1);
    expect(picked).toEqual([1, 2, 3, 4]);
    // Pointer up ends the drag, and a stray move afterwards moves nothing.
    await fireEvent(svg, new MouseEvent('pointerup', { bubbles: true }));
    await pointer(svg, 'pointermove', tickX(12));
    expect(picked).toEqual([1, 2, 3, 4]);
  });

  it('a move with no button down never moves the cursor', async () => {
    const { container, svg, picked } = armed();
    await pointer(svg, 'pointermove', tickX(4));
    expect(picked).toEqual([]);
    expect(container.querySelector('.fl-scrub')).toBeNull();
  });

  it('ArrowRight steps to the next step, ArrowLeft back, Home and End to the ends', async () => {
    const { container, svg, picked } = armed();
    const stops = scrubStops(CHART);
    await pointer(svg, 'pointerdown', tickX(1));
    await fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(picked).toEqual([1, 2]);
    await fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(picked).toEqual([1, 2, 3]);
    await fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(picked).toEqual([1, 2, 3, 2]);
    await fireEvent.keyDown(svg, { key: 'Home' });
    expect(cursorX(container)).toBe(stops[0]!.x);
    await fireEvent.keyDown(svg, { key: 'End' });
    expect(cursorX(container)).toBe(stops[stops.length - 1]!.x);
  });

  it('an arrow key never lands on a stop that would re-open the step it is on', () => {
    const stops = scrubStops(CHART);
    // Three bands and a span start share one x and one ordinal. A key press that
    // left the inspector where it was would read as a dead key.
    for (const from of stops) {
      const next = stepScrub(stops, from, 'ArrowRight');
      if (next) expect(next.ordinal).not.toBe(from.ordinal);
      const back = stepScrub(stops, from, 'ArrowLeft');
      if (back) expect(back.ordinal).not.toBe(from.ordinal);
    }
    // The ends clamp rather than wrap.
    expect(stepScrub(stops, stops[stops.length - 1]!, 'ArrowRight')).toBeNull();
    expect(stepScrub(stops, stops[0]!, 'ArrowLeft')).toBeNull();
  });

  it('zoom leaves the cursor on the same instant of the run', async () => {
    const { container, svg, picked, getByTitle } = armed();
    await pointer(svg, 'pointerdown', tickX(12));
    const before = cursorX(container);
    await fireEvent.click(getByTitle('Zoom in'));
    // The viewBox never moves under zoom, so a cursor held in user units is
    // still on the same step — no second pass, nothing to recompute.
    expect(cursorX(container)).toBe(before);
    expect(picked).toEqual([12]);
  });

  it('the cursor carries the snapped step own clock, and an ordinal when there is none', async () => {
    const { container, svg } = armed();
    await pointer(svg, 'pointerdown', tickX(12));
    expect(container.querySelector('.fl-scrub-time')!.textContent).toBe(formatClock(RUN[12]!.startedAt));
    // A run the clock cannot order gets NO invented time — the same refusal the
    // axis, the idle windows and the span bars all make.
    expect(scrubLabel({ x: 0, ordinal: 3 }, UNTIMED)).toBe('#3');
  });
});

// THE DEGENERATE RUNS. Every assertion above is written against RUN, which has
// three delegates, two compactions' worth of causes and a 20-minute idle. The
// shapes a user actually opens FIRST are the ones with nothing in them: a run
// captured before its first tool answered, a run that only ever read files, a
// run one step long whose arrow keys have nowhere to go. Each of the three is
// an empty-array or single-element path through code written for the general
// case; none of them was covered. No defect today — these are the guards.
describe('degenerate runs — the shapes with nothing in them', () => {
  it('a run with NO steps renders without throwing', () => {
    const { container } = mount([]);
    expect(container.querySelector('svg.fl-chart')).not.toBeNull();
  });
  it('a run of ONLY tool calls renders and scrubs', () => {
    const ONLY: LayoutStep[] = [
      step(0, { tool: 'read', title: 'a', startedAt: at(0), endedAt: at(10) }),
      step(1, { tool: 'read', title: 'b', startedAt: at(20), endedAt: at(30) }),
    ];
    const { container } = mount(ONLY);
    const chart = flightChart({ steps: ONLY, rows: agentRows(ONLY), width: WIDTH });
    const stops = scrubStops(chart);
    expect(stops.length).toBeGreaterThan(0);
    expect(container.querySelector('.fl-gap-label')!.textContent).toContain('none delegated');
  });
  it('a ONE-step run: arrow keys at both ends do not throw and do not wrap', () => {
    const ONE: LayoutStep[] = [step(0, { tool: 'read', title: 'only', startedAt: at(0), endedAt: at(5) })];
    const chart = flightChart({ steps: ONE, rows: agentRows(ONE), width: WIDTH });
    const stops = scrubStops(chart);
    expect(stepScrub(stops, stops[0] ?? null, 'ArrowRight')).toBeNull();
    expect(stepScrub(stops, stops[0] ?? null, 'ArrowLeft')).toBeNull();
    expect(stepScrub([], null, 'Home')).toBeNull();
    expect(stepScrub([], null, 'End')).toBeNull();
  });
});
