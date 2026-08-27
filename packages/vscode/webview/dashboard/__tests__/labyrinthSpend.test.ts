// The SPEND surface, on the pane the user actually looks at. Kept out of
// labyrinthPane.test.ts so the map's own assertions stay one story.
//
// The failures these exist to catch, in order of how badly they would mislead:
//  1. a partial total printed as a confident complete one,
//  2. a fabricated 0 where nothing was ever measured,
//  3. a delegated stretch's spend charged to the thread that delegated it,
//  4. the map itself moving because usage arrived — Thread must be untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createHash } from 'node:crypto';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const RUNS = [{ sessionId: 'ses_a', title: 'T', folder: 'f', cwd: 'C:/x', updatedAt: '2026-07-27T14:05:00.000Z' }];
const step = (ordinal: number, over: Record<string, unknown> = {}) => ({ ordinal, kind: 'tool', title: `step ${ordinal}`, ...over });

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
const spend = (c: HTMLElement) => flat(c.querySelector('.lab-spend')?.textContent ?? '');
const chips = (c: HTMLElement) => Array.from(c.querySelectorAll('.spend-chip')).map((e) => flat(e.textContent));

/**
 * The canonical run this file measures against: a `build` trunk that delegates
 * to a `general` sub-agent. The SPAWN carries the parent's usage, because a
 * `task` call is the last part of the parent's own message — which is the
 * attribution trap this surface has to get right.
 */
const CANON = [
  step(0, { kind: 'prompt', title: 'audit the repo', startedAt: 1_000 }),
  step(1, {
    kind: 'subagent', tool: 'task', title: 'delegate', agent: 'build',
    startedAt: 1_100, endedAt: 4_000, status: 'completed', background: true, childSessionId: 'ses_kid',
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 0 } }, cost: 0,
  }),
  step(2, { kind: 'reply', title: 'findings', depth: 1, parentOrdinal: 1, agent: 'general', startedAt: 2_000, tokens: { input: 40, output: 9 } }),
  step(3, { kind: 'reply', title: 'done', agent: 'build', startedAt: 5_000, tokens: { input: 7, output: 3 } }),
];
/** The same run as an older engine would send it: no usage fields at all. */
const stripUsage = (steps: Array<Record<string, unknown>>) =>
  steps.map(({ tokens: _t, cost: _c, usageMissing: _u, ...rest }) => rest);

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

// The map is the product; the strip is an annotation beside it. If usage data
// can move one marker, every geometry assertion in labyrinthPane.test.ts is
// suddenly conditional on which fields the engine happened to send.
describe('Labyrinth spend — THREAD is byte-identical, with usage or without', () => {
  it('the same run with and without token fields draws the SAME svg, byte for byte', async () => {
    const withUsage = await withRun({ steps: CANON, truncated: false, total: 4 });
    const a = withUsage.container.querySelector('svg.lab-svg')!.outerHTML;
    cleanup();

    const without = await withRun({ steps: stripUsage(CANON), truncated: false, total: 4 });
    const b = without.container.querySelector('svg.lab-svg')!.outerHTML;

    expect(b).toBe(a);
  });

  it('...and that svg is the one Thread drew before any of this landed', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    const svg = container.querySelector('svg.lab-svg')!.outerHTML;
    // THE DRAWN PICTURE, with Svelte's `<!---->` block anchors taken out. They
    // are bookkeeping, not marks: mounting a component inside the <svg> adds a
    // pair of them and moves nothing on screen. Hashing the picture WITHOUT
    // them is the stronger guard — it still catches any real drift, and it
    // stops a future extraction reading as one. 3,847 chars.
    //
    // Verified byte for byte across the 0.4.51 breaks work: the pane at
    // c81996c97a rendered 4,015 chars with 24 anchors, and after the model-break
    // mount landed it rendered 4,029 with 26. Stripped, both are this exact
    // string — the two extra anchors are the whole difference.
    const drawn = svg.replace(/<!---->/g, '');
    expect(drawn.length).toBe(3847);
    expect(createHash('sha256').update(drawn, 'utf8').digest('hex'))
      .toBe('1f29085c52d026a998a9bf347e3c9ed441ba5fdd9c9bb0a29b5be89da5ff1cdd');
    // ...and the raw serialisation is pinned too, so an added mount is still a
    // change somebody has to look at rather than one that slips through.
    expect(svg.length).toBe(4029);
  });

  it('CORRIDOR keeps its density: the strip costs the minimap no markers and no canvas', async () => {
    const steps = Array.from({ length: 336 }, (_, i) => step(i, { tokens: { input: i, output: 1 }, agent: 'build' }));
    const { container } = await withRun({ steps, truncated: false, total: 336 });
    await fireEvent.click(Array.from(container.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Corridor')!);
    await tick();

    expect(container.querySelectorAll('.marker')).toHaveLength(336);
    expect(container.querySelector('.lab-svg')!.getAttribute('viewBox')).toBe('0 0 760 620');
    // ...and the strip really is on screen while that holds.
    expect(container.querySelector('.lab-spend')).not.toBeNull();
  });
});

describe('Labyrinth spend — the run total, split by agent and by branch', () => {
  it('shows what the whole run cost, in the engine\'s own composition', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    // 100+20+5+900 (spawn) + 40+9 (sub-agent) + 7+3 (reply) = 1,084 raw.
    expect(spend(container)).toContain('1,084 raw');
    expect(spend(container)).toContain('147 in');
    expect(spend(container)).toContain('900 cache read');
    expect(spend(container)).toContain('$0');
  });

  it('the delegated branch is its OWN chip, and the trunk is not charged for it', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    const all = chips(container).join(' | ');
    // The sub-agent spent 49; the `build` trunk spent 1,025+10, including the
    // 1,025 `task` call, which it made and the sub-agent did not.
    expect(all).toContain('⤷ delegate 49');
    expect(all).toContain('general 49');
    expect(all).toContain('build 1,035');
  });

  it('a run that delegated nothing shows no branch chip at all', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'prompt', title: 'hi', agent: 'build' }), step(1, { kind: 'reply', title: 'yo', agent: 'build', tokens: { input: 5, output: 5 } })],
      truncated: false, total: 2,
    });
    expect(chips(container).filter((c) => c.includes('⤷'))).toEqual([]);
    expect(container.querySelector('.spend-of')).toBeNull();
    expect(spend(container)).toContain('10 raw');
  });
});

/**
 * THE DOUBLE COUNT. The chip row printed `main` — the TRUNK's rollup — as a
 * flat sibling of the per-agent buckets, which are a SECOND complete partition
 * of the same steps, and of the per-branch chips, a third. Reading the row as a
 * total therefore counted the whole run twice: on the owner's real run `main`
 * equalled `build` + `compaction` to the token.
 */
describe('Labyrinth spend — the chip row is ONE granularity, and it adds up', () => {
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('.spend-rows'));
  const numbers = (el: Element) =>
    Array.from(el.querySelectorAll('.spend-chip b')).map((b) => Number(flat(b.textContent).replace(/[^0-9]/g, '')));

  it('the flat chips sum to the run — no rollup stands beside its own parts', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    // RED before the fix: this row also carried `main 1,035`, so the sum was
    // 2,119 against a run of 1,084.
    expect(numbers(rows(container)[0]!).reduce((a, b) => a + b, 0)).toBe(1_084);
    expect(chips(container).some((c) => c.startsWith('main'))).toBe(false);
  });

  it('the delegated chips are a SUBSET, labelled as one, on their own row', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    expect(rows(container)).toHaveLength(2);
    expect(flat(container.querySelector('.spend-of')!.textContent)).toBe('of which delegated');
    expect(flat(rows(container)[1]!.textContent)).toContain('⤷ delegate 49');
    // ...and the agent bucket it sits inside still carries the same 49, which
    // is exactly why the two rows must not be read as one sum.
    expect(flat(rows(container)[0]!.textContent)).toContain('general 49');
  });
});

describe('Labyrinth spend — the headline is the REAL cost, not the raw count', () => {
  // 900 of the CANON run's 1,084 tokens are cache reads, which bill at a tenth.
  it('leads with input equivalents, then the raw total and the hit rate', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    const head = flat(container.querySelector('.spend-head')!.textContent);
    // input 147 + 900 x 0.1 = 237.
    expect(head).toContain('237 real');
    expect(head).toContain('1,084 raw');
    expect(head).toContain('86% cached');
  });

  it('every raw component is still on screen, one aligned cell each', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    const cells = Array.from(container.querySelectorAll('.raw-cell')).map((c) => flat(c.textContent));
    // Value THEN label, as the table row reads (0.4.51 UAT). Same five cells,
    // same order, same numbers — only which half of a cell comes first moved.
    expect(cells).toEqual(['147 in', '32 out', '5 reasoning', '900 cache read', '0 cache write']);
  });

  it('a provider that reported no cache gets no hit rate — never 0%', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'reply', title: 'local', agent: 'build', tokens: { input: 900, output: 90 } })],
      truncated: false, total: 1,
    });
    const head = flat(container.querySelector('.spend-head')!.textContent);
    expect(head).toContain('900 real');
    expect(head).not.toContain('cached');
    expect(head).not.toContain('0%');
  });
});

describe('Labyrinth spend — EVERY provider is counted, and named', () => {
  const MIXED = [
    step(0, { kind: 'prompt', title: 'go', agent: 'build', model: 'openai/gpt-5.6-sol' }),
    step(1, { kind: 'reply', title: 'a', agent: 'build', model: 'openai/gpt-5.6-sol', tokens: { input: 1_000, output: 100, cache: { read: 9_000 } } }),
    step(2, { kind: 'reply', title: 'b', agent: 'build', model: 'xai/grok-4.5', tokens: { input: 200, output: 20, reasoning: 143, cache: { read: 800 } } }),
  ];

  it('the header covers BOTH providers — the second is not silently excluded', async () => {
    const { container } = await withRun({ steps: MIXED, truncated: false, total: 3 });
    const head = flat(container.querySelector('.spend-head')!.textContent);
    // 1,000+100+9,000 + 200+20+143+800 = 11,263 raw.
    expect(head).toContain('11.3k raw');
    // The 143 reasoning tokens belong to the SECOND provider alone: a header
    // that stops at the first prints nothing here.
    expect(flat(container.querySelector('.spend-parts')!.textContent)).toContain('143 reasoning');
  });

  it('names the models that RAN, with their request counts and the switches', async () => {
    const { container } = await withRun({ steps: MIXED, truncated: false, total: 3 });
    const models = Array.from(container.querySelectorAll('.model-chip')).map((c) => flat(c.textContent));
    expect(models[0]).toContain('openai/gpt-5.6-sol ×1');
    expect(models[1]).toContain('xai/grok-4.5 ×1');
    expect(flat(container.querySelector('.model-switch')!.textContent)).toContain('1 switch');
  });

  it('an old payload that never recorded a model prints no models row', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'reply', title: 'x', agent: 'build', tokens: { input: 5, output: 5 } })],
      truncated: false, total: 1,
    });
    expect(container.querySelector('.spend-models')).toBeNull();
  });
});

describe('Labyrinth spend — a delegated chip opens that run', () => {
  it('asks the host for the CHILD session, carrying the parent run\'s directory', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('.spend-chip.open') as HTMLButtonElement);

    // Without the parent's cwd the engine resolves the id against its own
    // process directory and answers with an empty run.
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'requestRunSteps', sessionId: 'ses_kid', cwd: 'C:/x',
    });
  });

  it('a branch whose spawn named no child session is not clickable', async () => {
    const noChild = CANON.map((s) => (s.ordinal === 1 ? { ...s, childSessionId: undefined } : s));
    const { container } = await withRun({ steps: noChild, truncated: false, total: 4 });
    expect(container.querySelector('.spend-chip.open')).toBeNull();
  });
});

describe('Labyrinth spend — a short total says so, and an absent one prints nothing', () => {
  it('a run with a usage-less message is marked APPROXIMATE and says why', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'reply', title: 'counted', agent: 'build', tokens: { input: 100, output: 10 } }),
        step(1, { kind: 'reply', title: 'unrecorded', agent: 'build', usageMissing: true }),
      ],
      truncated: false, total: 2,
    });

    const text = spend(container);
    // The number is still shown — but as a FLOOR, never as the run's spend.
    expect(text).toContain('≥100 real');
    expect(text).toContain('110 raw');
    expect(text).toContain('APPROXIMATE');
    expect(text).toContain('1 step recorded no usage');
    expect(container.querySelector('.spend-total')!.classList.contains('approx')).toBe(true);
  });

  it('a COMPLETE run carries no approximate marker — the warning has to mean something', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    expect(spend(container)).not.toContain('APPROXIMATE');
    expect(spend(container)).not.toContain('≥');
  });

  it('a TRUNCATED run\'s total is approximate even though every loaded step reported usage', async () => {
    const { container } = await withRun({ steps: CANON, truncated: true, total: 1203 });
    expect(spend(container)).toContain('APPROXIMATE');
    expect(spend(container)).toContain('truncated');
    // ...and the pane's own truncation notice still stands beside it.
    expect(flat(container.querySelector('.lab-truncated')!.textContent)).toContain('1,203');
  });

  it('a run that recorded NO usage says so — it does not print a confident 0', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'prompt', title: 'hi' }), step(1, { kind: 'reply', title: 'yo' })],
      truncated: false, total: 2,
    });
    expect(container.querySelector('.lab-spend')).toBeNull();
    expect(flat(container.textContent)).not.toContain('0 real');
    expect(flat(container.textContent)).not.toContain('undefined');
  });

  it('a genuine ZERO is kept and shown — a free local turn is a measurement', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'reply', title: 'local', agent: 'build', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })],
      truncated: false, total: 1,
    });
    const text = spend(container);
    expect(text).toContain('0 real');
    expect(text).toContain('0 in');
    expect(text).toContain('$0');
    expect(text).not.toContain('APPROXIMATE');
  });
});

describe('Labyrinth spend — the inspector shows the richer shape, and only what is there', () => {
  it('a cached turn shows its cache read rather than hiding it inside input', async () => {
    const { container } = await withRun({ steps: CANON, truncated: false, total: 4 });
    await fireEvent.click(container.querySelectorAll('.node')[1]!);
    await tick();

    const ins = flat(container.querySelector('.lab-inspector')!.textContent);
    expect(ins).toContain('100 in · 20 out · 5 reasoning · 900 cache read · 0 cache write · $0');
  });

  it('a step whose message recorded no usage renders NO tokens row at all', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'reply', title: 'unrecorded', agent: 'build', usageMissing: true })],
      truncated: false, total: 1,
    });
    await fireEvent.click(container.querySelector('.node')!);
    await tick();

    const ins = flat(container.querySelector('.lab-inspector')!.textContent);
    expect(ins).not.toContain('Tokens');
    expect(ins).not.toContain('undefined');
    expect(ins).not.toContain('0 in');
  });
});

describe('Labyrinth spend — OLD BINARY', () => {
  it('a payload carrying only {input,output} still totals, and claims nothing more', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'prompt', title: 'audit' }),
        step(1, { kind: 'subagent', tool: 'task', title: 'delegate', tokens: { input: 100, output: 20 } }),
        step(2, { kind: 'reply', title: 'findings', depth: 1, parentOrdinal: 1, tokens: { input: 40, output: 9 } }),
      ],
      truncated: false, total: 3,
    });

    const text = spend(container);
    expect(text).toContain('169 raw');
    expect(text).toContain('140 in');
    // Nothing the old payload never carried may appear.
    expect(text).not.toContain('reasoning');
    expect(text).not.toContain('cache');
    expect(text).not.toContain('$');
    expect(text).not.toContain('APPROXIMATE');
    expect(text).not.toContain('undefined');
    // ...and with no `agent` field the bucket is named, not silently dropped.
    expect(chips(container).join(' | ')).toContain('unknown 169');

    await fireEvent.click(container.querySelectorAll('.node')[1]!);
    await tick();
    expect(flat(container.querySelector('.lab-inspector')!.textContent)).toContain('100 in · 20 out');
  });
});
