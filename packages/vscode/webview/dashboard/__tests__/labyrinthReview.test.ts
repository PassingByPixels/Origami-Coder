// The 0.4.51 review refinements, on the pane the owner actually looks at:
// the spend TABLE, the chip-to-map HIGHLIGHT, the BACK journey out of a
// click-through, and the MODEL BREAKS drawn on all three layouts.
//
// The failures these exist to catch:
//  1. a click-through with no way back — the delegated run becomes a trap, and
//     the step the reader had open is lost even if they find their way,
//  2. a highlight that lights the wrong region, or the whole map (which says
//     nothing) — the binding is asserted, never the paint, because jsdom has
//     no layout and no opacity to read,
//  3. a break claiming a model change the run never made,
//  4. a header row whose cells silently drop or reorder a measurement.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const RUNS = [{ sessionId: 'ses_a', title: 'T', folder: 'f', cwd: 'C:/x', updatedAt: '2026-07-27T14:05:00.000Z' }];
const step = (ordinal: number, over: Record<string, unknown> = {}) => ({ ordinal, kind: 'tool', title: `step ${ordinal}`, ...over });

const GPT = 'openai/gpt-5.6-sol';
const GROK = 'xai/grok-4.5';

/** The reviewed run: a `build` trunk that delegates one stretch to `general`.
 *  Its TRUNK never changes model, so nothing here draws a break — the break
 *  tests use their own run and cannot be satisfied by this one by accident. */
const PARENT = [
  step(0, { kind: 'prompt', title: 'audit the repo', startedAt: 1_000, model: GPT }),
  step(1, {
    kind: 'subagent', tool: 'task', title: 'delegate', agent: 'build', model: GPT,
    startedAt: 1_100, endedAt: 4_000, status: 'completed', background: true, childSessionId: 'ses_kid',
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 0 } }, cost: 0,
  }),
  step(2, { kind: 'reply', title: 'findings', depth: 1, parentOrdinal: 1, agent: 'general', startedAt: 2_000, model: GROK, tokens: { input: 40, output: 9 } }),
  step(3, { kind: 'reply', title: 'PARENT TAIL', agent: 'build', startedAt: 5_000, model: GPT, tokens: { input: 7, output: 3 } }),
];
const CHILD = [step(0, { kind: 'reply', title: 'CHILD ONLY', agent: 'general', tokens: { input: 1, output: 1 } })];

/** A run whose TRUNK really did change hands, once. */
const SWITCHED = [
  step(0, { kind: 'prompt', title: 'go', agent: 'build', model: GPT, startedAt: 1_000, tokens: { input: 10, output: 1 } }),
  step(1, { kind: 'reply', title: 'first half', agent: 'build', model: GPT, startedAt: 2_000, tokens: { input: 10, output: 1 } }),
  step(2, { kind: 'reply', title: 'second half', agent: 'build', model: GROK, startedAt: 3_000, tokens: { input: 10, output: 1 } }),
  step(3, { kind: 'reply', title: 'still there', agent: 'build', model: GROK, startedAt: 4_000, tokens: { input: 10, output: 1 } }),
];

async function withRun(data: Record<string, unknown>) {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: RUNS });
  await tick();
  await fireEvent.click(rendered.container.querySelector('.lab-run')!);
  await tick();
  send({ type: 'runStepsData', sessionId: 'ses_a', ...data });
  await tick();
  return rendered;
}
const posts = () => globalThis.__vscodeApiMock.postMessage;
const ordinalsOf = (c: HTMLElement, sel: string) =>
  Array.from(c.querySelectorAll(sel)).map((e) => e.getAttribute('data-ordinal'));
const setMode = async (c: HTMLElement, label: string) => {
  await fireEvent.click(Array.from(c.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === label)!);
  await tick();
};

beforeEach(() => { posts().mockClear(); });
afterEach(() => cleanup());

// ---------------------------------------------------------------------------

describe('Labyrinth spend — the header is a TABLE, two rows, value before label', () => {
  it('row one carries raw, cached and real, in that order', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    const cells = Array.from(container.querySelectorAll('.spend-head > *')).map((c) => flat(c.textContent));
    // 100+20+5+900 (spawn) + 40+9 (sub-agent) + 7+3 (reply) = 1,084 raw;
    // input 147 + 900 x 0.1 = 237 real; 900 / (900 + 147) = 86% cached.
    expect(cells).toEqual(['Run spend', '1,084 raw', '86% cached', '237 real', '$0']);
  });

  it('row two carries the raw components, value first, in engine order', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    expect(Array.from(container.querySelectorAll('.raw-cell')).map((c) => flat(c.textContent)))
      .toEqual(['147 in', '32 out', '5 reasoning', '900 cache read', '0 cache write']);
  });

  it('a ZERO reasoning count takes no cell — it is the near-universal case', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'reply', title: 'x', agent: 'build', tokens: { input: 8, output: 2, reasoning: 0, cache: { read: 4, write: 1 } } })],
      truncated: false, total: 1,
    });
    const cells = Array.from(container.querySelectorAll('.raw-cell')).map((c) => flat(c.textContent));
    expect(cells).toEqual(['8 in', '2 out', '4 cache read', '1 cache write']);
    // Every OTHER measured zero is still on screen: an absent count and a
    // counted zero are different facts everywhere but reasoning.
    expect(cells.join(' ')).not.toContain('reasoning');
  });

  it('the indicative figure rides on row one, beside the numbers it is derived from', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    send({ type: 'labyrinthPrices', prices: { [GPT]: { input: 1, output: 2 } } });
    await tick();
    const cells = Array.from(container.querySelectorAll('.spend-head > *')).map((c) => flat(c.textContent));
    // GROK ran and has no price, so the figure is a FLOOR and says so.
    expect(cells.some((c) => c.includes('indicative') && c.startsWith('≥'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('Labyrinth highlight — a spend chip says where on the map its work is', () => {
  const dimmed = (c: HTMLElement) => ordinalsOf(c, '.node.is-dim').sort();

  it('nothing hovered dims nothing — the map is exactly as it was', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    expect(dimmed(container)).toEqual([]);
  });

  it('hovering a DELEGATED chip dims every step that branch did not take', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    await fireEvent.mouseEnter(container.querySelector('.spend-chip.branch')!);
    await tick();
    // The spawn (1) is the branch's head and its own step (2) is on it; the
    // trunk either side of it is what fades.
    expect(dimmed(container)).toEqual(['0', '3']);
  });

  it('leaving the chip clears it — a stale highlight is a map that lies', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    await fireEvent.mouseEnter(container.querySelector('.spend-chip.branch')!);
    await tick();
    await fireEvent.mouseLeave(container.querySelector('.spend-chip.branch')!);
    await tick();
    expect(dimmed(container)).toEqual([]);
  });

  it('hovering an AGENT chip dims the steps that agent did not take', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    const general = Array.from(container.querySelectorAll('.spend-chip'))
      .find((c) => flat(c.textContent).startsWith('general'))!;
    await fireEvent.mouseEnter(general);
    await tick();
    // `general` ran step 2 alone; step 0 carries no agent and buckets as unknown.
    expect(dimmed(container)).toEqual(['0', '1', '3']);
  });

  it('an agent that ran the WHOLE run dims nothing — a fully faded map says nothing', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'reply', title: 'a', agent: 'build', tokens: { input: 1, output: 1 } }),
        step(1, { kind: 'reply', title: 'b', agent: 'build', tokens: { input: 1, output: 1 } })],
      truncated: false, total: 2,
    });
    await fireEvent.mouseEnter(container.querySelector('.spend-chip')!);
    await tick();
    expect(dimmed(container)).toEqual([]);
  });

  it('CORRIDOR fades the same steps, and keeps the hovered branch\'s own chamber lit', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    await setMode(container, 'Corridor');
    expect(container.querySelector('.chamber')).not.toBeNull();
    await fireEvent.mouseEnter(container.querySelector('.spend-chip.branch')!);
    await tick();
    expect(dimmed(container)).toEqual(['0', '3']);
    expect(container.querySelector('.chamber.is-dim')).toBeNull();
  });

  it('...and fades that chamber when the chip is about work done OUTSIDE it', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    await setMode(container, 'Corridor');
    const build = Array.from(container.querySelectorAll('.spend-chip'))
      .find((c) => flat(c.textContent).startsWith('build'))!;
    await fireEvent.mouseEnter(build);
    await tick();
    expect(container.querySelector('.chamber.is-dim')).not.toBeNull();
  });

  it('FLIGHT fades the swimlanes of the branches the chip is not about', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    await setMode(container, 'Flight');
    expect(container.querySelectorAll('.swim-lane')).toHaveLength(1);
    const build = Array.from(container.querySelectorAll('.spend-chip'))
      .find((c) => flat(c.textContent).startsWith('build'))!;
    await fireEvent.mouseEnter(build);
    await tick();
    expect(container.querySelectorAll('.swim-lane.is-dim')).toHaveLength(1);
    // ...and the branch's own chip leaves its lane alone.
    await fireEvent.mouseLeave(build);
    await fireEvent.mouseEnter(container.querySelector('.spend-chip.branch')!);
    await tick();
    expect(container.querySelectorAll('.swim-lane.is-dim')).toHaveLength(0);
  });

  it('THREAD fades the branch RAIL the chip is not about', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    expect(container.querySelectorAll('.branch-rail')).toHaveLength(1);
    const build = Array.from(container.querySelectorAll('.spend-chip'))
      .find((c) => flat(c.textContent).startsWith('build'))!;
    await fireEvent.mouseEnter(build);
    await tick();
    expect(container.querySelectorAll('.branch-rail.is-dim')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('Labyrinth back — a click-through can be walked out of', () => {
  /** Open the parent, pick a step in it, then click into the delegated run. */
  async function intoChild() {
    const rendered = await withRun({ steps: PARENT, truncated: false, total: 4 });
    const { container } = rendered;
    await fireEvent.click(container.querySelectorAll('.node')[3]!); // ordinal 3
    await tick();
    expect(flat(container.querySelector('.lab-inspector')!.textContent)).toContain('PARENT TAIL');
    await fireEvent.click(container.querySelector('.spend-chip.open') as HTMLButtonElement);
    await tick();
    send({ type: 'runStepsData', sessionId: 'ses_kid', steps: CHILD, truncated: false, total: 1 });
    await tick();
    return rendered;
  }

  it('offers NO back control until a click-through has happened', async () => {
    const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
    expect(container.querySelector('.lab-back')).toBeNull();
  });

  it('offers one inside the delegated run', async () => {
    const { container } = await intoChild();
    expect(flat(container.textContent)).toContain('CHILD ONLY');
    expect(container.querySelector('.lab-back')).not.toBeNull();
  });

  it('BACK asks for the parent run again, carrying the directory it came from', async () => {
    const { container } = await intoChild();
    posts().mockClear();
    await fireEvent.click(container.querySelector('.lab-back') as HTMLButtonElement);
    expect(posts()).toHaveBeenCalledWith({ type: 'requestRunSteps', sessionId: 'ses_a', cwd: 'C:/x' });
  });

  it('...and re-opens the step that was selected there, not the root of the run', async () => {
    const { container } = await intoChild();
    await fireEvent.click(container.querySelector('.lab-back') as HTMLButtonElement);
    await tick();
    send({ type: 'runStepsData', sessionId: 'ses_a', steps: PARENT, truncated: false, total: 4 });
    await tick();
    expect(flat(container.querySelector('.lab-inspector')!.textContent)).toContain('PARENT TAIL');
    // ...and the trail is spent: one click-through, one way back.
    expect(container.querySelector('.lab-back')).toBeNull();
  });

  it('ESCAPE is the same journey', async () => {
    const { container } = await intoChild();
    posts().mockClear();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(posts()).toHaveBeenCalledWith({ type: 'requestRunSteps', sessionId: 'ses_a', cwd: 'C:/x' });
  });

  it('ESCAPE outside a click-through does nothing — it cannot jump somewhere never visited', async () => {
    await withRun({ steps: PARENT, truncated: false, total: 4 });
    posts().mockClear();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(posts()).not.toHaveBeenCalled();
  });

  it('picking a run from the INDEX spends the trail — back is not a time machine', async () => {
    const { container } = await intoChild();
    await fireEvent.click(container.querySelector('.lab-run')!);
    await tick();
    expect(container.querySelector('.lab-back')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('Labyrinth breaks — where the run changed model, on every layout', () => {
  const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('.lab-break .break-tag')).map((e) => flat(e.textContent));

  for (const mode of ['Thread', 'Corridor', 'Flight']) {
    it(`${mode} draws one labelled break where the trunk changed hands`, async () => {
      const { container } = await withRun({ steps: SWITCHED, truncated: false, total: 4 });
      await setMode(container, mode);
      expect(container.querySelectorAll('.lab-break')).toHaveLength(1);
      expect(labels(container)).toEqual(['grok-4.5']);
      // Both sides are named where a label cannot fit them.
      expect(flat(container.querySelector('.lab-break title')!.textContent)).toBe(`model changed: ${GPT} -> ${GROK}`);
    });

    it(`${mode} keeps the break INSIDE the viewBox — an SVG viewport clips silently`, async () => {
      const { container } = await withRun({ steps: SWITCHED, truncated: false, total: 4 });
      await setMode(container, mode);
      const [w, h] = container.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ').slice(2).map(Number);
      const d = container.querySelector('.break-rule')!.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const tag = container.querySelector('.break-tag')!;
      for (const [x, y] of [[d[0]!, d[1]!], [d[2]!, d[3]!], [Number(tag.getAttribute('x')), Number(tag.getAttribute('y'))]]) {
        expect(x, `${mode} x`).toBeGreaterThanOrEqual(0);
        expect(x, `${mode} x`).toBeLessThanOrEqual(w!);
        expect(y, `${mode} y`).toBeGreaterThanOrEqual(0);
        expect(y, `${mode} y`).toBeLessThanOrEqual(h!);
      }
    });

    it(`${mode} draws NO break for a run that never changed model`, async () => {
      const { container } = await withRun({ steps: PARENT, truncated: false, total: 4 });
      await setMode(container, mode);
      expect(container.querySelectorAll('.lab-break')).toHaveLength(0);
    });
  }

  it('an old payload with no model at all draws no break in any layout', async () => {
    const bare = SWITCHED.map(({ model: _m, ...rest }) => rest);
    const { container } = await withRun({ steps: bare, truncated: false, total: 4 });
    for (const mode of ['Thread', 'Corridor', 'Flight']) {
      await setMode(container, mode);
      expect(container.querySelectorAll('.lab-break')).toHaveLength(0);
    }
  });
});
