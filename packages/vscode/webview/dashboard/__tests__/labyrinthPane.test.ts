// LabyrinthPane — reviewing a PAST run as a map. The failures worth catching
// here are all failures of HONESTY rather than of rendering:
//  - a truncated run drawn as if it were complete (the worst one),
//  - an empty run or a failed load shown as a spinner that never resolves,
//  - an optional field the engine omitted printed as "undefined" or a fake 0.
// So the assertions are about what the user is TOLD, not about markup shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');

function send(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
// `folder` is the display basename; `cwd` is the run's OWN full directory.
// The two runs deliberately sit in DIFFERENT directories — the history list
// widens beyond the active workspace when the scoped query is empty, so the
// pane must send back the cwd belonging to the row that was clicked.
const RUNS = [
  { sessionId: 'ses_a', title: 'Assess the labyrinth repo', folder: 'origami-coder', cwd: 'C:/repos/origami-coder', updatedAt: '2026-07-27T14:05:00.000Z' },
  { sessionId: 'ses_b', title: 'Fix the dry-run crash', folder: 'spark', cwd: 'C:/repos/spark', updatedAt: '2026-07-27T13:42:00.000Z' },
];
const step = (ordinal: number, over: Record<string, unknown> = {}) => ({
  ordinal, kind: 'tool', title: `step ${ordinal}`, ...over,
});

/** Mount, list runs, pick the first one, and deliver `data` as its steps. */
async function withRun(data: Record<string, unknown>) {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: RUNS });
  await tick();
  await fireEvent.click(rendered.container.querySelectorAll('.lab-run')[0]!);
  await tick();
  send({ type: 'runStepsData', sessionId: 'ses_a', ...data });
  await tick();
  return rendered;
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('LabyrinthPane — the run index reuses the existing history wire', () => {
  it('asks for past runs with requestHistory on mount — it does not add a second session lister', () => {
    render(LabyrinthPane);
    expect(posts()).toContainEqual({ type: 'requestHistory' });
    expect(posts().filter((p) => String(p.type).toLowerCase().includes('session'))).toEqual([]);
  });

  it('renders each past run and asks for the clicked one’s steps', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'historyList', sessions: RUNS });
    await tick();

    const rows = container.querySelectorAll('.lab-run');
    expect(rows).toHaveLength(2);
    expect(flat(container.textContent)).toContain('Assess the labyrinth repo');
    expect(flat(container.textContent)).toContain('origami-coder');

    await fireEvent.click(rows[1]!);
    await tick();
    // The CLICKED row's directory, not the first row's and not a blank —
    // asking the engine for ses_b under origami-coder's path finds nothing.
    expect(posts()).toContainEqual({ type: 'requestRunSteps', sessionId: 'ses_b', cwd: 'C:/repos/spark' });
    expect((rows[1] as HTMLElement).classList.contains('selected')).toBe(true);
    expect((rows[0] as HTMLElement).classList.contains('selected')).toBe(false);
  });
});

describe('LabyrinthPane — truncation is stated, never silently drawn as the whole run', () => {
  it('says how many of how many when the engine capped the list', async () => {
    const steps = Array.from({ length: 500 }, (_, i) => step(i));
    const { container } = await withRun({ steps, truncated: true, total: 1203 });

    const notice = container.querySelector('.lab-truncated');
    expect(notice).not.toBeNull();
    const text = flat(notice!.textContent);
    expect(text).toContain('500');
    expect(text).toContain('1,203');
    expect(text.toLowerCase()).toContain('truncated');
    // And the markers really are only the prefix that arrived.
    expect(container.querySelectorAll('.marker')).toHaveLength(500);
  });

  it('a COMPLETE run carries no truncation notice (the notice means something)', async () => {
    const { container } = await withRun({ steps: [step(0), step(1)], truncated: false, total: 2 });
    expect(container.querySelector('.lab-truncated')).toBeNull();
    expect(container.querySelectorAll('.marker')).toHaveLength(2);
  });
});

describe('LabyrinthPane — no-selection, empty and failed are three different states', () => {
  it('before any run is picked, it says so — it does not spin', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'historyList', sessions: RUNS });
    await tick();
    expect(flat(container.querySelector('.lab-state')!.textContent)).toContain('Pick a run');
    expect(container.querySelector('.lab-svg')).toBeNull();
  });

  it('a run with ZERO steps resolves to an empty state, not a spinner', async () => {
    const { container } = await withRun({ steps: [], truncated: false, total: 0 });
    const state = flat(container.querySelector('.lab-state')!.textContent);
    expect(state).toContain('no steps');
    expect(state).not.toContain('Reading the run');
    expect(container.querySelector('.lab-svg')).toBeNull();
    expect(container.querySelector('.lab-error')).toBeNull();
  });

  it('a run that FAILS to load reports the engine error, distinct from “empty”', async () => {
    const { container } = await withRun({ steps: [], truncated: false, total: 0, error: 'session not found' });
    const err = container.querySelector('.lab-error');
    expect(err).not.toBeNull();
    expect(flat(err!.textContent)).toContain('session not found');
    expect(flat(container.textContent)).not.toContain('recorded no steps');
  });
});

describe('LabyrinthPane — the inspector shows what the step HAS, and nothing else', () => {
  it('clicking a marker populates the inspector with that step’s real fields', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'prompt', title: 'pull and assess the repo' }),
        step(1, {
          kind: 'tool', tool: 'read', title: 'read src/agent.ts', status: 'completed',
          durationMs: 1500, tokens: { input: 120, output: 40 }, model: 'lmstudio/qwen3', agent: 'build',
          preview: 'export const Agent =',
        }),
      ],
      truncated: false, total: 2,
    });

    await fireEvent.click(container.querySelectorAll('.node')[1]!);
    await tick();

    const ins = flat(container.querySelector('.lab-inspector')!.textContent);
    expect(ins).toContain('read src/agent.ts');
    expect(ins).toContain('completed');
    expect(ins).toContain('1.5s');
    expect(ins).toContain('120 in · 40 out');
    expect(ins).toContain('lmstudio/qwen3');
    expect(ins).toContain('build');
    expect(ins).toContain('export const Agent =');
  });

  it('a step missing every optional field renders neither "undefined" nor a fabricated 0', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'thinking', title: 'weighing the options' })],
      truncated: false, total: 1,
    });

    await fireEvent.click(container.querySelector('.node')!);
    await tick();

    const ins = container.querySelector('.lab-inspector')!;
    const text = flat(ins.textContent);
    expect(text).toContain('weighing the options');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    // The absent measurements must not appear at all — a "Duration 0ms" row
    // would read as "this took no time", which is a claim we cannot make.
    for (const label of ['Duration', 'Tokens', 'Model', 'Agent', 'Status', 'Preview', 'Error']) {
      expect(text).not.toContain(label);
    }
  });

  it('with nothing selected the inspector prompts instead of rendering a blank step', async () => {
    const { container } = await withRun({ steps: [step(0)], truncated: false, total: 1 });
    expect(flat(container.querySelector('.ins-idle')!.textContent)).toContain('Select a step');
  });
});

describe('LabyrinthPane — the three modes are switchable and flight is honest about timing', () => {
  it('switching mode re-lays the SAME steps: thread is vertical, flight is horizontal', async () => {
    const steps = [
      step(0, { startedAt: 1_000_000 }),
      step(1, { startedAt: 1_001_000 }),
      step(2, { startedAt: 1_005_000 }),
    ];
    const { container } = await withRun({ steps, truncated: false, total: 3 });

    const ys = () => Array.from(container.querySelectorAll('.marker')).map((c) => Number(c.getAttribute('cy')));
    const xs = () => Array.from(container.querySelectorAll('.marker')).map((c) => Number(c.getAttribute('cx')));

    expect(new Set(xs()).size).toBe(1);          // thread: one spine
    expect(new Set(ys()).size).toBe(3);

    const flight = Array.from(container.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Flight')!;
    await fireEvent.click(flight);
    await tick();

    expect(new Set(ys()).size).toBe(1);          // flight: one horizontal spine
    const px = xs();
    expect((px[1]! - px[0]!) / (px[2]! - px[0]!)).toBeCloseTo(0.2, 3); // by TIME, not by index
    expect(container.querySelector('.lab-note')).toBeNull();
  });

  it('flight over untimed steps says the spacing shows ORDER, not time', async () => {
    const { container } = await withRun({ steps: [step(0), step(1), step(2)], truncated: false, total: 3 });
    const flight = Array.from(container.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Flight')!;
    await fireEvent.click(flight);
    await tick();

    const note = container.querySelector('.lab-note');
    expect(note).not.toBeNull();
    expect(flat(note!.textContent)).toContain('no usable timestamps');
    expect(container.querySelectorAll('.marker')).toHaveLength(3);
  });

  it('corridor mode snakes: the second row runs backwards across the canvas', async () => {
    const steps = Array.from({ length: 8 }, (_, i) => step(i));
    const { container } = await withRun({ steps, truncated: false, total: 8 });
    const corridor = Array.from(container.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Corridor')!;
    await fireEvent.click(corridor);
    await tick();

    const pts = Array.from(container.querySelectorAll('.marker')).map((c) => ({
      x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')),
    }));
    const rowYs = [...new Set(pts.map((p) => p.y))].sort((a, b) => a - b);
    const row1 = pts.filter((p) => p.y === rowYs[1]).map((p) => p.x);
    expect(row1.length).toBeGreaterThan(1);
    for (let i = 1; i < row1.length; i++) expect(row1[i]!).toBeLessThan(row1[i - 1]!);
  });
});

// Corridor is now the MINIMAP: the whole run at once, no labels, sub-agents as
// inset chambers. These are the claims on the surface the user actually looks
// at — that a big run really is all on screen, that a failure is findable
// without reading, that a delegated stretch is a nested block and not steps
// queued inline, and that a minimap of a PREFIX still says it is a prefix.
describe('LabyrinthPane — corridor draws the whole run as a minimap', () => {
  const toCorridor = async (c: HTMLElement) => {
    const btn = Array.from(c.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Corridor')!;
    await fireEvent.click(btn);
    await tick();
  };
  const boxOf = (c: HTMLElement) => c.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ').map(Number);

  it('a 336-step run puts every marker inside the viewBox — nothing scrolls out of sight', async () => {
    const steps = Array.from({ length: 336 }, (_, i) => step(i));
    const { container } = await withRun({ steps, truncated: false, total: 336 });
    await toCorridor(container);

    const [, , w, h] = boxOf(container) as [number, number, number, number];
    const drawn = markers(container);
    expect(drawn).toHaveLength(336);
    for (const m of drawn) {
      const [cx, cy, r] = ['cx', 'cy', 'r'].map((a) => Number(m.getAttribute(a)));
      expect(cx! - r!).toBeGreaterThanOrEqual(0);
      expect(cx! + r!).toBeLessThanOrEqual(w);
      expect(cy! - r!).toBeGreaterThanOrEqual(0);
      expect(cy! + r!).toBeLessThanOrEqual(h);
    }
    // ...and no per-step CAPTION: dropping the prose is what buys the density.
    // (A one-character kind mark is a different thing — see below.)
    expect(container.querySelectorAll('.lab-canvas .caption')).toHaveLength(0);
  });

  it('clicking a marker selects THAT step into the inspector, exactly as the other modes do', async () => {
    const steps = Array.from({ length: 120 }, (_, i) =>
      step(i, { kind: 'tool', tool: 'read', title: `read file_${i}.ts`, status: 'completed' }));
    const { container } = await withRun({ steps, truncated: false, total: 120 });
    await toCorridor(container);

    await fireEvent.click(container.querySelectorAll('.node')[77]!);
    await tick();
    expect(flat(container.querySelector('.lab-inspector')!.textContent)).toContain('read file_77.ts');
    // The pick is visible on the MAP too, not only in the side panel.
    const picked = markers(container)[77]!;
    expect(Number(picked.getAttribute('r'))).toBeGreaterThan(Number(markers(container)[76]!.getAttribute('r')));
  });

  it('a failure is visibly different from a completed step — findable without reading', async () => {
    const steps = Array.from({ length: 60 }, (_, i) =>
      step(i, i === 41 ? { status: 'error', error: 'exit 1' } : { status: 'completed' }));
    const { container } = await withRun({ steps, truncated: false, total: 60 });
    await toCorridor(container);

    const failed = markers(container)[41]!;
    const ok = markers(container)[40]!;
    expect(Number(failed.getAttribute('r'))).toBeGreaterThan(Number(ok.getAttribute('r')));
    expect(failed.getAttribute('fill')).not.toBe(ok.getAttribute('fill'));
    expect(Array.from(container.querySelectorAll('.node')).filter((n) => n.classList.contains('tone-error')))
      .toHaveLength(1);
  });

  it('a sub-agent renders as an inset CHAMBER, off the main corridor line', async () => {
    const { container } = await withRun({ steps: DELEGATED, truncated: false, total: 6 });
    await toCorridor(container);

    const rooms = container.querySelectorAll('.chamber');
    expect(rooms).toHaveLength(1);
    const nested = Array.from(container.querySelectorAll('.node.in-chamber'));
    expect(nested.map((n) => n.getAttribute('data-ordinal'))).toEqual(['2', '3', '4']);
    // Every nested marker is really inside the drawn room...
    const rect = rooms[0]! as SVGRectElement;
    const [rx, ry, rw, rh] = ['x', 'y', 'width', 'height'].map((a) => Number(rect.getAttribute(a)));
    for (const n of nested) {
      const m = n.querySelector('.marker')!;
      expect(Number(m.getAttribute('cx'))).toBeGreaterThanOrEqual(rx!);
      expect(Number(m.getAttribute('cx'))).toBeLessThanOrEqual(rx! + rw!);
      expect(Number(m.getAttribute('cy'))).toBeGreaterThanOrEqual(ry!);
      expect(Number(m.getAttribute('cy'))).toBeLessThanOrEqual(ry! + rh!);
    }
    // ...and the main-thread steps are NOT in it, so the block means something.
    expect(container.querySelectorAll('.node:not(.in-chamber)')).toHaveLength(3);
  });

  it('a plain run draws no chamber at all', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    await toCorridor(container);
    expect(container.querySelectorAll('.chamber')).toHaveLength(0);
  });

  // The owner's UAT: "we just need abbreviations or icons by main threads so we
  // know whats happening". These are on the surface the user looks at.
  it('each MAIN-THREAD marker carries its kind, and the marks differ by kind', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'prompt', title: 'do the thing' }),
        step(1, { kind: 'tool', tool: 'read', title: 'read agent.ts' }),
        step(2, { kind: 'thinking', title: 'weighing it up' }),
        step(3, { kind: 'reply', title: 'here you go' }),
      ],
      truncated: false, total: 4,
    });
    await toCorridor(container);

    const nodes = Array.from(container.querySelectorAll('.node'));
    const marks = nodes.map((n) => flat(n.querySelector('.mark')?.textContent ?? ''));
    expect(marks.every((m) => m.length === 1), `got ${JSON.stringify(marks)}`).toBe(true);
    expect(new Set(marks).size).toBe(4); // four kinds, four different marks
    // ...and the mark takes its marker's TONE, so kind's letter and kind's
    // colour cannot drift apart — no second colour language.
    expect(nodes[1]!.classList.contains('tone-tool')).toBe(true);
    expect(nodes[1]!.querySelector('.mark')!.getAttribute('font-size')).not.toBeNull();
  });

  it('a CHAMBER cell stays bare — labelling a chamber would spend the density it buys', async () => {
    const { container } = await withRun({ steps: DELEGATED, truncated: false, total: 6 });
    await toCorridor(container);

    const nested = Array.from(container.querySelectorAll('.node.in-chamber'));
    expect(nested.length).toBeGreaterThan(0);
    for (const n of nested) expect(n.querySelector('.mark'), 'a chamber cell must carry no mark').toBeNull();
    // ...while the main-thread steps beside them all do.
    const main = Array.from(container.querySelectorAll('.node:not(.in-chamber)'));
    expect(main.length).toBeGreaterThan(0);
    for (const n of main) expect(n.querySelector('.mark')).not.toBeNull();
  });

  it('a 336-step run still fits WITH its marks — the labels do not cost the fit', async () => {
    const steps = Array.from({ length: 336 }, (_, i) => step(i, { kind: i % 2 ? 'tool' : 'reply' }));
    const { container } = await withRun({ steps, truncated: false, total: 336 });
    await toCorridor(container);

    const [, , w, h] = boxOf(container) as [number, number, number, number];
    const marks = Array.from(container.querySelectorAll('.mark'));
    expect(marks).toHaveLength(336);
    for (const t of marks) {
      const size = Number(t.getAttribute('font-size'));
      expect(size).toBeGreaterThan(0);
      // 0.65 of the size is the over-estimated advance the placement is derived
      // from; ending inside it means ending inside any real monospace advance.
      expect(Number(t.getAttribute('x')) + size * 0.65).toBeLessThanOrEqual(w);
      expect(Number(t.getAttribute('y'))).toBeLessThanOrEqual(h);
    }
  });

  it('a TRUNCATED run still says it is a prefix — a minimap implying completeness is the worst failure', async () => {
    const steps = Array.from({ length: 500 }, (_, i) => step(i));
    const { container } = await withRun({ steps, truncated: true, total: 1203 });
    await toCorridor(container);

    const notice = flat(container.querySelector('.lab-truncated')!.textContent);
    expect(notice).toContain('500');
    expect(notice).toContain('1,203');
    expect(notice).toContain('PREFIX');
    expect(markers(container)).toHaveLength(500);
  });
});

// The UAT complaint these cover: every step drew as the same small circle in
// one centre column. A step's THREAD now decides its side of the spine, an
// off-spine marker is joined back to the line, its kind carries a glyph, and
// the selection is visible on the MAP and not only in the inspector.
const LANED = [
  step(0, { kind: 'prompt', title: 'do the thing' }),
  step(1, { kind: 'tool', tool: 'read', title: 'read agent.ts', status: 'completed' }),
  step(2, { kind: 'subagent', tool: 'task', title: 'delegate the audit' }),
  step(3, { kind: 'reply', title: 'here is what I found' }),
];
const markers = (c: HTMLElement) => Array.from(c.querySelectorAll('.marker'));
const toMode = async (c: HTMLElement, label: string) => {
  await fireEvent.click(Array.from(c.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === label)!);
  await tick();
};
const xOf = (c: HTMLElement, i: number) => Number(markers(c)[i]!.getAttribute('cx'));

describe('LabyrinthPane — threads are lanes, and a jutting step branches off the spine', () => {
  it('a tool sits right of the prompt, a subagent left, and the two main steps share the spine', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    expect(xOf(container, 1)).toBeGreaterThan(xOf(container, 0)); // tool -> right
    expect(xOf(container, 2)).toBeLessThan(xOf(container, 0));    // subagent -> left
    expect(xOf(container, 3)).toBe(xOf(container, 0));            // prompt + reply on one spine
  });

  it('a jutting TOOL is joined back to the spine, and the on-spine steps are not', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    const nodes = Array.from(container.querySelectorAll('.node'));
    // Only the tool needs a lateral connector: a delegated step sits on its
    // branch's own rail, which the map frame draws through it.
    expect(nodes.filter((n) => n.querySelector('.branch'))).toHaveLength(1);
    expect(nodes[0]!.querySelector('.branch')).toBeNull();
    expect(nodes[3]!.querySelector('.branch')).toBeNull();
    // And the connector really runs from the spine TO that marker — a line
    // that stopped short would leave the step floating, unattached to the run.
    const d = nodes[1]!.querySelector('.branch')!.getAttribute('d')!;
    const [fromX, , toX] = d.match(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/)!.slice(1);
    expect(Number(fromX)).toBe(xOf(container, 0));
    expect(Number(toX)).toBe(xOf(container, 1));
  });

  it('each kind draws its OWN glyph, and a failed tool keeps the tool shape while changing tone', async () => {
    const { container } = await withRun({
      steps: [...LANED, step(4, { kind: 'tool', tool: 'bash', title: 'npm test', status: 'error' })],
      truncated: false, total: 5,
    });
    const glyphs = Array.from(container.querySelectorAll('[data-glyph]')).map((g) => g.getAttribute('data-glyph'));
    expect(glyphs).toEqual(['prompt', 'tool', 'subagent', 'reply', 'tool']);
    const nodes = Array.from(container.querySelectorAll('.node'));
    expect(nodes[4]!.classList.contains('tone-error')).toBe(true);
    expect(nodes[1]!.classList.contains('tone-tool')).toBe(true);
  });

  it('all three modes render centred in the panel rather than pinned to its left edge', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    for (const label of ['Thread', 'Corridor', 'Flight']) {
      const btn = Array.from(container.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === label)!;
      await fireEvent.click(btn);
      await tick();
      expect(container.querySelector('.lab-svg')!.getAttribute('preserveAspectRatio')).toMatch(/^xMid/);
    }
  });
});

// THE ROUND-2 DEFECT, on the surface the user actually looks at. A sub-agent's
// own steps arrive as ordinary prompt/thinking/reply kinds carrying depth, and
// the kind-first lane rule dropped every one of them back on the trunk — so a
// delegated stretch read as work the main agent did.
const DELEGATED = [
  step(0, { kind: 'prompt', title: 'audit the repo' }),
  step(1, { kind: 'subagent', tool: 'task', title: 'delegate the audit', agent: 'scout' }),
  step(2, { kind: 'prompt', title: 'audit brief', depth: 1, parentOrdinal: 1 }),
  step(3, { kind: 'thinking', title: 'Thinking', depth: 1, parentOrdinal: 1 }),
  step(4, { kind: 'reply', title: 'audit findings', depth: 1, parentOrdinal: 1 }),
  step(5, { kind: 'reply', title: 'here is what it found' }),
];

describe('LabyrinthPane — a delegated stretch renders as a branch off the trunk', () => {
  it('the sub-agent’s OWN prompt/thinking/reply sit off the spine, on its branch', async () => {
    const { container } = await withRun({ steps: DELEGATED, truncated: false, total: 6 });
    const spine = xOf(container, 0);
    expect(xOf(container, 5)).toBe(spine); // the main agent is still on the trunk
    for (const i of [2, 3, 4]) {
      expect(xOf(container, i), `step ${i} is back on the spine`).not.toBe(spine);
      expect(xOf(container, i)).toBe(xOf(container, 1)); // ...and on the SPAWN's column
    }
  });

  it('the branch visibly LEAVES the trunk and REJOINS it', async () => {
    const { container } = await withRun({ steps: DELEGATED, truncated: false, total: 6 });
    const rails = container.querySelectorAll('.branch-rail');
    expect(rails).toHaveLength(1);
    const depart = rails[0]!.querySelector('.branch-depart')!.getAttribute('d')!;
    const merge = rails[0]!.querySelector('.branch-merge')!.getAttribute('d')!;
    const spine = xOf(container, 0);
    const col = xOf(container, 2);

    // Departs FROM the trunk, arrives ON the column...
    expect(Number(depart.match(/M ([\d.-]+)/)![1])).toBe(spine);
    expect(Number(depart.match(/L ([\d.-]+)/)![1])).toBe(col);
    // ...and merges the other way. Without this the thread reads as abandoned.
    expect(Number(merge.match(/M ([\d.-]+)/)![1])).toBe(col);
    expect(Number(merge.match(/L ([\d.-]+)/)![1])).toBe(spine);
    expect(rails[0]!.querySelector('.branch-spine')).not.toBeNull();
  });

  it('a plain run with no delegation draws no branch rails at all', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    expect(container.querySelectorAll('.branch-rail')).toHaveLength(1); // the lone subagent
    const plain = await withRun({ steps: [step(0, { kind: 'prompt' }), step(1, { kind: 'reply' })], truncated: false, total: 2 });
    expect(plain.container.querySelectorAll('.branch-rail')).toHaveLength(0);
  });

  it('a depth-1 step with NO parentOrdinal still lands off the spine', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'prompt' }), step(1, { kind: 'reply', depth: 1 }), step(2, { kind: 'reply' })],
      truncated: false, total: 3,
    });
    expect(xOf(container, 1)).not.toBe(xOf(container, 0));
    expect(xOf(container, 2)).toBe(xOf(container, 0));
    expect(container.querySelectorAll('.branch-rail')).toHaveLength(1);
  });
});

describe('LabyrinthPane — the map stays inside its panel', () => {
  it('a monstrous tool name is ellipsised, never cut mid-word at the viewBox edge', async () => {
    const { container } = await withRun({
      steps: [step(0, {
        kind: 'tool',
        tool: 'mcp__blender__generate_hyper3d_model_via_images',
        title: 'generate a hyper3d model from the four reference images supplied',
      })],
      truncated: false, total: 1,
    });
    const label = container.querySelector('.caption')!;
    const text = flat(label.textContent);
    expect(text.endsWith('…')).toBe(true);

    // The real check: where the label STARTS plus how wide it can be must stay
    // inside the viewBox, or the SVG viewport clips it with no ellipsis shown.
    const width = Number(container.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ')[2]);
    expect(Number(label.getAttribute('x')) + text.length * 8.4).toBeLessThanOrEqual(width);
    // ...and the full text is still reachable rather than lost to the cut.
    expect(flat(container.querySelector('.node title')!.textContent)).toContain('hyper3d model');
  });

  it('the ordinal+duration is nested to each marker, not parked in a fixed left gutter', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    const metaX = Array.from(container.querySelectorAll('.meta')).map((m) => Number(m.getAttribute('x')));
    const markerX = markers(container).map((m) => Number(m.getAttribute('cx')));
    // It TRACKS its marker — a fixed gutter would give one x for every row.
    expect(new Set(metaX).size).toBeGreaterThan(1);
    metaX.forEach((x, i) => expect(x - markerX[i]!).toBeLessThanOrEqual(40));
    // ...and the reclaimed width went to the label, which starts well right of it.
    const labelX = Number(container.querySelector('.caption')!.getAttribute('x'));
    for (const x of metaX) expect(x).toBeLessThan(labelX);
  });
});

// Background sub-agents detach: the turn ends, the user keeps talking, the
// child reports back later. These assert what the USER is told about that —
// that a branch which had not returned looks unfinished and says so, and that
// a build sending none of the new fields is told nothing extra at all.
describe('LabyrinthPane — a detached sub-agent is drawn as a real span', () => {
  const BACKGROUNDED = [
    step(0, { kind: 'prompt', title: 'write three stories while we talk', startedAt: 1_000 }),
    step(1, { kind: 'subagent', tool: 'task', title: 'war story #1', background: true, status: 'completed', startedAt: 1_100, endedAt: 5_000 }),
    step(2, { kind: 'subagent', tool: 'task', title: 'war story #2', background: true, status: 'running', startedAt: 1_200 }),
    step(3, { kind: 'reply', title: 'they will deliver when ready', startedAt: 1_300 }),
    step(4, { kind: 'prompt', title: 'capitals of europe', startedAt: 2_000 }),
    step(5, { kind: 'reply', title: 'Tirana …', startedAt: 2_500 }),
  ];
  const rails = (c: HTMLElement) => Array.from(c.querySelectorAll('.branch-rail'));

  it('a running sub-agent renders an OPEN branch — no merge, and an open terminus', async () => {
    const { container } = await withRun({ steps: BACKGROUNDED, truncated: false, total: 6 });
    const open = rails(container).filter((g) => g.classList.contains('is-open'));
    expect(open).toHaveLength(1);
    expect(open[0]!.querySelector('.branch-merge'), 'an unreturned branch must not draw a merge').toBeNull();
    expect(open[0]!.querySelector('.branch-open-end')).not.toBeNull();
    // ...and the completed one on the SAME run is visibly different: it merges.
    const closed = rails(container).filter((g) => !g.classList.contains('is-open'));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.querySelector('.branch-merge')).not.toBeNull();
    expect(closed[0]!.querySelector('.branch-open-end')).toBeNull();
  });

  it('the branch trails ALONGSIDE the main-thread steps that ran during it', async () => {
    const { container } = await withRun({ steps: BACKGROUNDED, truncated: false, total: 6 });
    // Both branches ran through the capitals exchange, so both draw a trail.
    expect(rails(container).filter((g) => g.querySelector('.branch-trail'))).toHaveLength(2);
  });

  it('the inspector SAYS a sub-agent had not come back, and how it was spawned', async () => {
    const { container } = await withRun({ steps: BACKGROUNDED, truncated: false, total: 6 });
    const nodes = Array.from(container.querySelectorAll('.node'));
    await fireEvent.click(nodes[2]!); // the running one
    await tick();

    const text = flat(container.querySelector('.lab-inspector')!.textContent).toLowerCase();
    expect(text).toContain('not yet');
    expect(text).toContain('had not reported back');
    expect(text).toContain('background');
    expect(text).not.toContain('undefined');
  });

  it('a background branch is distinguishable from a foreground one, and BOTH from silence', async () => {
    const mode = async (over: Record<string, unknown>) => {
      const { container } = await withRun({
        steps: [step(0, { kind: 'prompt' }), step(1, { kind: 'subagent', tool: 'task', ...over }), step(2, { kind: 'reply' })],
        truncated: false, total: 3,
      });
      const g = container.querySelector('.branch-rail')!;
      const inspector = async () => {
        await fireEvent.click(container.querySelectorAll('.node')[1]!);
        await tick();
        return flat(container.querySelector('.lab-inspector')!.textContent).toLowerCase();
      };
      return { bg: g.classList.contains('is-bg'), fg: g.classList.contains('is-fg'), text: await inspector() };
    };

    const detached = await mode({ background: true });
    expect(detached.bg).toBe(true);
    expect(detached.fg).toBe(false);
    expect(detached.text).toContain('ran alongside the conversation');
    cleanup();

    const blocking = await mode({ background: false });
    expect(blocking.fg).toBe(true);
    expect(blocking.bg).toBe(false);
    expect(blocking.text).toContain('the conversation waited');
    cleanup();

    // ABSENT is a third state. The engine emits `background` only when true, so
    // absent covers an older binary AND a foreground spawn — claiming either
    // would be inventing a fact, so the view claims neither.
    const silent = await mode({});
    expect(silent.bg).toBe(false);
    expect(silent.fg).toBe(false);
    expect(silent.text).not.toContain('blocking');
    expect(silent.text).not.toContain('background');
  });

  it('OLD BINARY: steps with none of the new fields draw exactly the old branch', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'prompt', title: 'audit the repo' }),
        step(1, { kind: 'subagent', tool: 'task', title: 'delegate' }),
        step(2, { kind: 'reply', title: 'findings', depth: 1, parentOrdinal: 1 }),
        step(3, { kind: 'reply', title: 'done' }),
      ],
      truncated: false, total: 4,
    });
    const g = container.querySelector('.branch-rail')!;
    expect(g.classList.contains('is-open')).toBe(false);
    expect(g.classList.contains('is-bg')).toBe(false);
    expect(g.classList.contains('is-fg')).toBe(false);
    expect(g.querySelector('.branch-depart')).not.toBeNull();
    expect(g.querySelector('.branch-spine')).not.toBeNull();
    expect(g.querySelector('.branch-merge')).not.toBeNull();
    expect(g.querySelector('.branch-trail'), 'no in-flight stretch may be invented').toBeNull();
    expect(g.querySelector('.branch-open-end')).toBeNull();

    await fireEvent.click(container.querySelectorAll('.node')[1]!);
    await tick();
    const text = flat(container.querySelector('.lab-inspector')!.textContent).toLowerCase();
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('not yet');
    expect(text).not.toContain('delegation');
  });
});

describe('LabyrinthPane — flight is the DETAIL view', () => {
  const toFlight = async (c: HTMLElement) => {
    const btn = Array.from(c.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Flight')!;
    await fireEvent.click(btn);
    await tick();
  };

  it('renders each step’s detail inline instead of one-at-a-time in the inspector', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'tool', tool: 'read', status: 'completed', durationMs: 1500, startedAt: 1_000_000, tokens: { input: 120, output: 40 }, agent: 'build' }),
        step(1, { kind: 'reply', title: 'done', startedAt: 1_005_000 }),
      ],
      truncated: false, total: 2,
    });
    await toFlight(container);

    const rows = Array.from(container.querySelectorAll('.detail')).map((d) => flat(d.textContent));
    expect(rows).toContain('tool · read');
    expect(rows).toContain('completed');
    expect(rows).toContain('1.5s');
    expect(rows).toContain('120/40 tok');
    expect(rows).toContain('build');
    // The bare step contributes its kind and NOTHING it does not have.
    expect(rows).toContain('reply');
    expect(rows.join(' ')).not.toContain('undefined');
    expect(rows.join(' ')).not.toMatch(/\b0(ms)?\b/);
  });

  it('goes TIME-BASED once the sub-agent steps carry clocks, and shows their overlap as bars', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'prompt', title: 'three stories please', startedAt: 1_000 }),
        step(1, { kind: 'subagent', tool: 'task', title: '#1', background: true, status: 'completed', startedAt: 1_100, endedAt: 5_000 }),
        step(2, { kind: 'reply', title: 'on it', startedAt: 1_200 }),
        step(3, { kind: 'prompt', title: 'capitals of europe', startedAt: 2_000 }),
        step(4, { kind: 'reply', title: 'Tirana …', startedAt: 9_000 }),
      ],
      truncated: false, total: 5,
    });
    await toFlight(container);

    // The gate no longer trips: sub-agent steps used to be timeless and one of
    // them collapsed the whole strip to even spacing.
    expect(container.querySelector('.lab-note')).toBeNull();
    const bars = Array.from(container.querySelectorAll('.flight-span'));
    expect(bars).toHaveLength(1);
    const x1 = Number(bars[0]!.getAttribute('x1'));
    const x2 = Number(bars[0]!.getAttribute('x2'));
    expect(x2).toBeGreaterThan(x1);
  });

  it('still degrades HONESTLY: no clocks, no bars, and it says positions show order', async () => {
    const { container } = await withRun({
      steps: [
        step(0, { kind: 'prompt', title: 'three stories please' }),
        step(1, { kind: 'subagent', tool: 'task', title: '#1', background: true }),
        step(2, { kind: 'reply', title: 'on it' }),
      ],
      truncated: false, total: 3,
    });
    await toFlight(container);

    expect(container.querySelectorAll('.flight-span')).toHaveLength(0);
    const note = flat(container.querySelector('.lab-note')!.textContent).toLowerCase();
    expect(note).toContain('order, not time');
  });

  it('is larger than the other modes and stays centred in the panel', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    const boxOf = () => container.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ').map(Number);
    const threadH = boxOf()[3]!;
    await toFlight(container);
    const svg = container.querySelector('.lab-svg')!;
    expect(boxOf()[3]!).toBeGreaterThan(threadH);
    expect(svg.getAttribute('preserveAspectRatio')).toMatch(/^xMid/);
  });
});

// THE OWNER'S SCREENSHOT: the clock row reading "11:57:17:43   11:57:46", two
// timestamps drawn over each other. Asserted on the RENDERED map, because the
// clock is the one label the pure layout does not decide: LabyrinthNode draws
// it at swimClockY whatever lane the marker took, so it is the row where two
// steps a millisecond apart collide however far apart their lanes are.
describe('LabyrinthPane — the flight TIME AXIS is readable at any density', () => {
  const toFlight = async (c: HTMLElement) => {
    await fireEvent.click(Array.from(c.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Flight')!);
    await tick();
  };
  // In flight, `.meta` is the clock row and nothing else.
  const clocks = (c: HTMLElement) => Array.from(c.querySelectorAll('text.meta'));
  // Six tools inside a fifth of a second, then a step ten minutes later.
  const BURST = [
    step(0, { kind: 'prompt', title: 'fix the failing suite', startedAt: 1_000_000 }),
    ...Array.from({ length: 6 }, (_, i) =>
      step(1 + i, { kind: 'tool', tool: `write_${i}`, title: `write ${i}`, startedAt: 1_000_040 + i * 30 })),
    step(7, { kind: 'reply', title: 'all written', startedAt: 1_900_000 }),
  ];

  it('prints no two clock labels through each other, and drops rather than smears', async () => {
    const { container } = await withRun({ steps: BURST, truncated: false, total: 8 });
    await toFlight(container);

    const drawn = clocks(container);
    // It really was a colliding density — otherwise this proves nothing.
    expect(drawn.length, 'a burst this tight cannot print 8 clocks legibly').toBeLessThan(BURST.length);
    expect(drawn.length, 'dropping ALL of them is not a fix either').toBeGreaterThan(0);
    const half = (8 * 7.2) / 2; // half a "HH:MM:SS" label at the 11px clock size
    const xs = drawn.map((t) => Number(t.getAttribute('x')));
    for (const a of xs) {
      for (const b of xs) {
        if (a >= b) continue;
        expect(Math.abs(a - b), `two clocks drawn ${Math.abs(a - b)} apart overlap`).toBeGreaterThanOrEqual(half * 2);
      }
    }
    // ...and every one that DID print is a real clock, not a smear of two.
    for (const t of drawn) expect(flat(t.textContent)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // Nothing is lost by the drop: every step is still a marker on the strip.
    expect(container.querySelectorAll('.marker')).toHaveLength(8);
  });

  it('a strip with room keeps every clock — the drop is density, not policy', async () => {
    const roomy = [
      step(0, { kind: 'prompt', title: 'first', startedAt: 1_000_000 }),
      step(1, { kind: 'reply', title: 'second', startedAt: 1_500_000 }),
      step(2, { kind: 'reply', title: 'third', startedAt: 2_000_000 }),
    ];
    const { container } = await withRun({ steps: roomy, truncated: false, total: 3 });
    await toFlight(container);
    expect(clocks(container)).toHaveLength(3);
  });
});

// Flight is the DETAIL view and the ONLY one positioned by wall clock, so it
// is the only place two sub-agents running in the same minute can be shown
// overlapping. It used to draw every one of them on a single delegation row,
// stacking those bars exactly on top of each other. These assert what is
// actually in the DOM after the swimlane rewrite.
describe('LabyrinthPane — flight is a SWIMLANE board', () => {
  const toFlight = async (c: HTMLElement) => {
    const btn = Array.from(c.querySelectorAll('.lab-mode')).find((b) => b.textContent?.trim() === 'Flight')!;
    await fireEvent.click(btn);
    await tick();
  };
  // #1 returns at 120_200, #2 is still running — their extents overlap.
  const TWO_AGENTS = [
    step(0, { kind: 'prompt', title: 'write two stories while we talk', startedAt: 0 }),
    step(1, { kind: 'subagent', tool: 'task', title: 'story #1', background: true, status: 'completed', startedAt: 200, endedAt: 120_200 }),
    step(2, { kind: 'reply', title: 'story #1 text', depth: 1, parentOrdinal: 1, startedAt: 119_000 }),
    step(3, { kind: 'subagent', tool: 'task', title: 'story #2', background: true, status: 'running', startedAt: 400 }),
    step(4, { kind: 'reply', title: 'two agents writing', startedAt: 800 }),
    step(5, { kind: 'prompt', title: 'capitals of europe', startedAt: 300_000 }),
  ];
  const laneEls = (c: HTMLElement) => Array.from(c.querySelectorAll('.swim-lane'));
  const bar = (g: Element) => ({
    y: Number(g.querySelector('.flight-span')!.getAttribute('y1')),
    x1: Number(g.querySelector('.flight-span')!.getAttribute('x1')),
    x2: Number(g.querySelector('.flight-span')!.getAttribute('x2')),
  });

  it('two concurrent sub-agents render on DIFFERENT rows with overlapping x', async () => {
    const { container } = await withRun({ steps: TWO_AGENTS, truncated: false, total: 6 });
    await toFlight(container);

    const bars = laneEls(container).map(bar);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.y).not.toBe(bars[1]!.y);
    // The overlap is on screen: each begins before the other ends.
    expect(bars[0]!.x1).toBeLessThan(bars[1]!.x2);
    expect(bars[1]!.x1).toBeLessThan(bars[0]!.x2);
    // ...and both lanes sit below the main line the run itself is drawn on.
    const mainY = Number(markers(container)[0]!.getAttribute('cy'));
    for (const b of bars) expect(b.y).toBeGreaterThan(mainY);
  });

  it('a lane DEPARTS and REJOINS the main line — unless the sub-agent never came back', async () => {
    const { container } = await withRun({ steps: TWO_AGENTS, truncated: false, total: 6 });
    await toFlight(container);
    const lanes = laneEls(container);

    // Every lane leaves the main line where it was spawned.
    for (const g of lanes) expect(g.querySelector('.swim-depart')).not.toBeNull();
    const open = lanes.filter((g) => g.classList.contains('is-open'));
    expect(open).toHaveLength(1);
    expect(open[0]!.querySelector('.swim-rejoin'), 'a sub-agent still running must not be drawn rejoining').toBeNull();
    expect(open[0]!.querySelector('.swim-open-end')).not.toBeNull();
    // ...and the one that DID return on the same run is visibly different.
    const closed = lanes.filter((g) => !g.classList.contains('is-open'));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.querySelector('.swim-rejoin')).not.toBeNull();
    expect(closed[0]!.querySelector('.swim-open-end')).toBeNull();
    // The open one runs to the right-hand edge; the closed one stops short.
    expect(bar(open[0]!).x2).toBeGreaterThan(bar(closed[0]!).x2);
  });

  it('the rows are NAMED per lane, and the canvas grows to hold them', async () => {
    const { container } = await withRun({ steps: TWO_AGENTS, truncated: false, total: 6 });
    await toFlight(container);
    const tags = Array.from(container.querySelectorAll('.lane-tag')).map((t) => flat(t.textContent));
    expect(tags).toContain('MAIN');
    expect(tags).toContain('SUB-AGENT 1');
    expect(tags).toContain('SUB-AGENT 2');
    const twoLaneH = Number(container.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ')[3]);
    cleanup();

    // The same run with ONE sub-agent needs no extra row — and says DELEGATION.
    const solo = await withRun({ steps: TWO_AGENTS.filter((_, i) => i !== 3), truncated: false, total: 5 });
    await toFlight(solo.container);
    expect(Number(solo.container.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ')[3]))
      .toBeLessThan(twoLaneH);
    expect(Array.from(solo.container.querySelectorAll('.lane-tag')).map((t) => flat(t.textContent)))
      .toContain('DELEGATION');
  });

  it('the clock row still clears the LOWEST lane instead of being drawn through it', async () => {
    const { container } = await withRun({ steps: TWO_AGENTS, truncated: false, total: 6 });
    await toFlight(container);
    const clocks = Array.from(container.querySelectorAll('.meta')).map((m) => Number(m.getAttribute('y')));
    expect(clocks.length).toBeGreaterThan(0);
    const lowestLane = Math.max(...laneEls(container).map((g) => bar(g).y));
    for (const y of clocks) expect(y).toBeGreaterThan(lowestLane);
    const height = Number(container.querySelector('.lab-svg')!.getAttribute('viewBox')!.split(' ')[3]);
    for (const y of clocks) expect(y).toBeLessThan(height);
  });
});

describe('LabyrinthPane — clicking a step is visible on the MAP, not only in the inspector', () => {
  it('the selected marker fills and grows; every other marker stays unfilled', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    const before = markers(container).map((m) => m.getAttribute('fill'));
    expect(new Set(before).size).toBe(1); // nothing selected: all alike

    await fireEvent.click(container.querySelectorAll('.node')[2]!);
    await tick();

    const after = markers(container);
    const picked = after[2]!;
    expect(picked.getAttribute('fill')).not.toBe(before[2]);
    for (const [i, m] of after.entries()) {
      if (i === 2) continue;
      expect(m.getAttribute('fill')).toBe(before[i]);
      expect(Number(picked.getAttribute('r'))).toBeGreaterThan(Number(m.getAttribute('r')));
    }
  });
});

describe('LabyrinthPane — the thresholds filter shows boundary events only', () => {
  const MIXED = [
    step(0, { kind: 'prompt', title: 'run the suite' }),
    step(1, { kind: 'tool', tool: 'bash', title: 'npm test', status: 'error', error: 'exit 1' }),
    step(2, { kind: 'tool', tool: 'read', title: 'read log', status: 'completed' }),
    step(3, { kind: 'error', title: 'ProviderAuthError', status: 'error' }),
  ];
  const box = (c: HTMLElement) => c.querySelector('.lab-check input') as HTMLInputElement;

  it('ticking it reduces the map to the failures, and unticking restores the whole run', async () => {
    const { container } = await withRun({ steps: MIXED, truncated: false, total: 4 });
    expect(markers(container)).toHaveLength(4);

    await fireEvent.click(box(container));
    await tick();
    expect(markers(container)).toHaveLength(2);
    const titles = Array.from(container.querySelectorAll('.node')).map((n) => n.getAttribute('aria-label'));
    expect(titles).toEqual(['npm test', 'ProviderAuthError']);

    await fireEvent.click(box(container));
    await tick();
    expect(markers(container)).toHaveLength(4);
  });

  it('a threshold is marked even with the filter OFF — turning it on reveals nothing new', async () => {
    const { container } = await withRun({ steps: MIXED, truncated: false, total: 4 });
    const nodes = Array.from(container.querySelectorAll('.node'));
    expect(nodes.filter((n) => n.querySelector('.thresh'))).toHaveLength(2);
    expect(nodes[0]!.querySelector('.thresh')).toBeNull();
    expect(nodes[2]!.querySelector('.thresh')).toBeNull();
  });

  it('a clean run says so instead of rendering an empty canvas', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    await fireEvent.click(box(container));
    await tick();

    expect(container.querySelector('.lab-svg')).toBeNull();
    const state = flat(container.querySelector('.lab-state')!.textContent);
    expect(state.toLowerCase()).toContain('no thresholds in this run');
    expect(state).toContain('4'); // and it says what unticking would bring back
  });
});

// Thread stacked by LIST INDEX, and `run_steps` inlines a child's steps right
// after its spawn — so a main-thread turn taken WHILE a background sub-agent
// was working was drawn under that sub-agent's whole run, reading as "after".
// These assert what the user actually sees on the rendered map.
describe('LabyrinthPane — thread rows follow the clock, not the list', () => {
  // #1 is spawned first and finishes first; the reply and the capitals
  // exchange all began in the first second, i.e. during BOTH sub-agents.
  const MEANWHILE = [
    step(0, { kind: 'prompt', title: 'write two stories while we talk', startedAt: 0 }),
    step(1, { kind: 'subagent', tool: 'task', title: 'story #1', background: true, status: 'completed', startedAt: 200, endedAt: 120_200 }),
    step(2, { kind: 'reply', title: 'story #1 text', depth: 1, parentOrdinal: 1, startedAt: 119_000 }),
    step(3, { kind: 'subagent', tool: 'task', title: 'story #2', background: true, status: 'completed', startedAt: 400, endedAt: 300_400 }),
    step(4, { kind: 'reply', title: 'story #2 text', depth: 1, parentOrdinal: 3, startedAt: 299_000 }),
    step(5, { kind: 'reply', title: 'Two agents writing now', startedAt: 800 }),
    step(6, { kind: 'prompt', title: 'capitals of europe', startedAt: 1_000 }),
  ];
  const yAt = (c: HTMLElement, i: number) => Number(markers(c)[i]!.getAttribute('cy'));

  it('a turn taken mid-branch is drawn ABOVE the delegated steps that started later', async () => {
    const { container } = await withRun({ steps: MEANWHILE, truncated: false, total: 7 });
    for (const turn of [5, 6]) {
      for (const later of [2, 4]) {
        expect(yAt(container, turn), `step ${later} started later but is drawn above turn ${turn}`)
          .toBeLessThan(yAt(container, later));
      }
      // ...and still below the spawns it followed, so the run reads in order.
      expect(yAt(container, turn)).toBeGreaterThan(yAt(container, 3));
    }
    // The two rails overlap in TIME, so they must not be drawn down one x.
    const rails = Array.from(container.querySelectorAll('.branch-rail'));
    expect(rails).toHaveLength(2);
    expect(new Set([1, 3].map((i) => Number(markers(container)[i]!.getAttribute('cx')))).size).toBe(2);
    expect(container.querySelector('.lab-note')).toBeNull(); // nothing to disclaim
  });

  it('one missing timestamp falls back to list order AND says so on screen', async () => {
    const holed = MEANWHILE.map((s, i) => (i === 4 ? { ...s, startedAt: undefined } : s));
    const { container } = await withRun({ steps: holed, truncated: false, total: 7 });

    const note = container.querySelector('.lab-note');
    expect(note, 'a list-ordered thread must admit it is list-ordered').not.toBeNull();
    expect(flat(note!.textContent)).toContain('ORDER, not time');
    // ...and the rows really are the list's again: evenly pitched, in order.
    const ys = markers(container).map((_, i) => yAt(container, i));
    expect(ys).toEqual(ys.map((_, i) => ys[0]! + i * (ys[1]! - ys[0]!)));
  });
});

// EXPORT. Two failure modes, both silent. The map is painted entirely by --og-*
// custom properties that exist only on the webview's :root, and the markers
// write `fill="var(--og-surface)"` as a real attribute — so a raw dump opens in
// a browser as an invisible mess. And the picture ALONE is not the run: corridor
// deliberately prints no labels, so its old .svg export was a grid of anonymous
// circles. The export is now a self-contained HTML page carrying the map AND the
// step ledger. These assert the ARTIFACT, against the real theme.css we ship.
describe('LabyrinthPane — exporting the map', () => {
  /** A title that would break or inject if it were ever written unescaped. */
  const HOSTILE = '<script>alert("pwned")</script> Ben & Jerry\'s "quoted"';
  /** One run with something in every optional field, and one with none. */
  const LEDGER = [
    step(0, { kind: 'prompt', title: 'do the thing', startedAt: 1_000_000 }),
    step(1, {
      kind: 'tool', tool: 'read', title: 'read agent.ts', status: 'completed',
      startedAt: 1_001_000, endedAt: 1_002_500, durationMs: 1500,
      tokens: { input: 120, output: 40 }, model: 'qwen3-coder', agent: 'build',
    }),
    step(2, { kind: 'subagent', tool: 'task', title: 'delegate the audit', startedAt: 1_003_000 }),
    step(3, { kind: 'reply', title: 'here is what I found', depth: 1, parentOrdinal: 2, startedAt: 1_004_000 }),
  ];
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  const rowCells = (doc: Document, row: number) =>
    Array.from(doc.querySelectorAll('tbody tr')[row]!.querySelectorAll('td')).map((td) => flat(td.textContent));
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const THEME = readFileSync(path.join(pkgRoot, 'webview/shared/theme.css'), 'utf8');
  /** The real palette on the document root, exactly as the webview has it. */
  const withTheme = () => {
    const el = document.createElement('style');
    el.textContent = THEME;
    document.head.appendChild(el);
    return () => el.remove();
  };
  const exportBtn = (c: HTMLElement) => c.querySelector('.lab-export') as HTMLButtonElement;
  const exported = () => posts().filter((p) => p.type === 'exportLabyrinth');

  it('offers nothing to export before a run is picked', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'historyList', sessions: RUNS });
    await tick();
    expect(exportBtn(container)).not.toBeNull();
    expect(exportBtn(container).disabled).toBe(true);

    await fireEvent.click(exportBtn(container));
    await tick();
    expect(exported(), 'a disabled export must not post an empty map').toEqual([]);
  });

  it('a run whose steps are all filtered out is not exportable either', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    expect(exportBtn(container).disabled).toBe(false);

    await fireEvent.click(container.querySelector('.lab-check input')!); // thresholds only
    await tick();
    expect(container.querySelector('.lab-svg'), 'precondition: no map is drawn').toBeNull();
    expect(exportBtn(container).disabled).toBe(true);
  });

  it('exports the CURRENT mode, and says which one it was', async () => {
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    await fireEvent.click(exportBtn(container));
    await tick();
    expect(exported()[0]!.mode).toBe('thread');

    await toMode(container, 'Corridor');
    await fireEvent.click(exportBtn(container));
    await tick();
    expect(exported()[1]!.mode).toBe('corridor');
  });

  it('the exported PAGE stands alone — no unresolved var(), real colours in its place, nothing fetched', async () => {
    const drop = withTheme();
    try {
      const { container } = await withRun({
        steps: [...LANED, step(4, { kind: 'tool', tool: 'bash', title: 'npm test', status: 'error' })],
        truncated: false, total: 5,
      });
      await toMode(container, 'Corridor');
      await fireEvent.click(exportBtn(container));
      await tick();

      const html = String(exported()[0]!.html);
      expect(html.slice(0, 15).toLowerCase()).toContain('<!doctype html');
      // THE failure this feature dies of: a var the file cannot see. The
      // markers write `fill="var(--og-surface)"` as a real ATTRIBUTE, so this
      // is not hypothetical — a raw dump ships that string verbatim.
      expect(html, 'an unresolved theme var renders as nothing outside the webview').not.toContain('var(');
      expect(html, 'no reference to a custom property may survive').not.toContain('--og-');
      // ...replaced by concrete colour, and specifically by colour this product
      // actually ships — an export that invented a hue would be a lie about the
      // run. (jsdom does not cascade class-based `color`, so the per-KIND tone
      // is proven in the built bundle rather than here; what is proven here is
      // that every colour reaching the file came from theme.css.)
      const hexes = [...new Set((html.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map((h) => h.toLowerCase()))];
      expect(hexes.length, 'a picture with no colour in it is not an export').toBeGreaterThan(0);
      for (const h of hexes) expect(THEME.toLowerCase(), `${h} is a colour theme.css never defines`).toContain(h);
      expect(hexes).toContain('#16201b'); // --og-surface, off the marker's fill attribute
      // SELF-CONTAINED: a file:// open with no network must look identical.
      // The page DOES carry inline script now (the owner's "click a node and
      // you get the stream's information"), so the rule is no longer "no
      // script" — it is that nothing is FETCHED. An external script is exactly
      // what would make the report die on a file:// open, so it stays banned.
      expect(html).not.toMatch(/<script[^>]*\bsrc\b/i);
      expect(html).not.toContain('<link');
      expect(html).not.toContain('@import');
      expect(html).not.toContain('src=');
      // The map really is embedded, and STILL parses as strict XML — the first
      // cut of this shipped a duplicate xmlns (the serializer emits one, and it
      // was also set by hand), which reads fine as a string and is a FATAL
      // parse error. Nothing short of parsing catches that.
      // Each marker's kind glyph is itself a nested <svg>, so the map's own
      // close tag is the LAST one in the file, not the first.
      const markup = html.slice(html.indexOf('<svg'), html.lastIndexOf('</svg>') + 6);
      const svgDoc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      expect(flat(svgDoc.querySelector('parsererror')?.textContent ?? ''), 'the map must parse as SVG').toBe('');
      expect(svgDoc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
      // Intrinsically sized, so a viewer has something to lay it out at.
      expect(svgDoc.documentElement.getAttribute('width')).toBe('760');
      expect(svgDoc.documentElement.getAttribute('height')).toBe('620');
      // A <title> must stay a live tooltip, not be stamped display:none.
      expect(html).not.toContain('display:none');
      // The panel's own layout must NOT ride along — min-width is the pane's.
      expect(html).not.toContain('min-width');
      // ...and it really is the map that was on screen, markers and all.
      expect(markup.match(/<circle/g) ?? []).toHaveLength(10); // hit + marker per step
      expect(html).toContain('npm test'); // the hover titles survive as SVG tooltips
    } finally {
      drop();
    }
  });

  it('a var the document cannot resolve collapses rather than shipping "var(" into the file', async () => {
    // No theme injected at all — the harshest case. The file must still be
    // free of var(), because a browser draws nothing for one.
    const { container } = await withRun({ steps: LANED, truncated: false, total: 4 });
    await fireEvent.click(exportBtn(container));
    await tick();
    expect(String(exported()[0]!.html)).not.toContain('var(');
  });

  // The owner's complaint the HTML exists for: "the corridor is just circles
  // otherwise". The picture keeps its density; the LEDGER carries the data.
  it('carries a row per exported step, with the fields the picture drops', async () => {
    const { container } = await withRun({ steps: LEDGER, truncated: false, total: 4 });
    await toMode(container, 'Corridor');
    await fireEvent.click(exportBtn(container));
    await tick();

    const doc = parse(String(exported()[0]!.html));
    expect(doc.querySelectorAll('tbody tr'), 'one row per step drawn, no more and no less').toHaveLength(4);
    const heads = Array.from(doc.querySelectorAll('thead th')).map((th) => flat(th.textContent));
    expect(heads).toEqual(['#', 'Kind', 'Tool', 'Title', 'Status', 'Start', 'End', 'Duration', 'Tokens in/out', 'Model', 'Agent', 'Depth', 'Branch of']);

    const tool = rowCells(doc, 1);
    expect(tool.slice(0, 5)).toEqual(['1', 'tool', 'read', 'read agent.ts', 'completed']);
    expect(tool[7]).toBe('1.5s');
    expect(tool[8]).toBe('120 / 40');
    expect(tool[9]).toBe('qwen3-coder');
    expect(tool[10]).toBe('build');
    expect(tool[5], 'a start it HAS must print').toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // A delegated step says where it sits in the tree — the one thing corridor
    // shows as an unlabelled inset chamber.
    expect(rowCells(doc, 3)[11]).toBe('1');
    expect(rowCells(doc, 3)[12]).toBe('#2');
  });

  it('an absent field is an EMPTY cell — never "undefined", never a fabricated 0', async () => {
    const { container } = await withRun({ steps: LEDGER, truncated: false, total: 4 });
    await fireEvent.click(exportBtn(container));
    await tick();

    const html = String(exported()[0]!.html);
    expect(html).not.toContain('undefined');
    const prompt = rowCells(parse(html), 0);
    // tool / status / end / duration / tokens / model / agent / depth / branch
    for (const i of [2, 4, 6, 7, 8, 9, 10, 11, 12]) {
      expect(prompt[i], `column ${i} invented a value the step never had`).toBe('');
    }
    // ...but a REAL zero is not suppressed: ordinal 0 is a step, not an absence.
    expect(prompt[0]).toBe('0');
  });

  it('a TRUNCATED run says so IN THE FILE, exactly as the pane says it on screen', async () => {
    const steps = Array.from({ length: 500 }, (_, i) => step(i));
    const { container } = await withRun({ steps, truncated: true, total: 1203 });
    await fireEvent.click(exportBtn(container));
    await tick();

    const html = String(exported()[0]!.html);
    const warn = flat(parse(html).querySelector('.warn')!.textContent);
    expect(warn, 'a 500-step prefix that reads as the whole run is the worst failure here').toContain('500');
    expect(warn).toContain('1,203');
    expect(warn.toLowerCase()).toContain('truncated');
    expect(warn).toContain('PREFIX');
  });

  it('a COMPLETE run carries no truncation notice — the notice means something', async () => {
    const { container } = await withRun({ steps: LEDGER, truncated: false, total: 4 });
    await fireEvent.click(exportBtn(container));
    await tick();
    expect(parse(String(exported()[0]!.html)).querySelector('.warn')).toBeNull();
  });

  it('names the run it came from — title, folder, when and how many steps', async () => {
    const { container } = await withRun({ steps: LEDGER, truncated: false, total: 4 });
    await fireEvent.click(exportBtn(container));
    await tick();

    const doc = parse(String(exported()[0]!.html));
    expect(flat(doc.querySelector('h1')!.textContent)).toBe('Assess the labyrinth repo');
    const meta = flat(doc.querySelector('.meta')!.textContent);
    expect(meta).toContain('origami-coder'); // the run's folder, from the index row
    expect(meta).toContain('4 steps');
    expect(meta).toContain('2026'); // ...and when it ran, off the same row
  });

  // A run title is arbitrary user text. If it is ever written raw, the export
  // is both corrupt and an injection vector in whatever opens it.
  it('a HOSTILE step title lands as TEXT — it cannot inject or corrupt the document', async () => {
    const { container } = await withRun({
      steps: [step(0, { kind: 'tool', tool: 'bash <&>', title: HOSTILE, status: 'completed' })],
      truncated: false, total: 1,
    });
    await fireEvent.click(exportBtn(container));
    await tick();

    const html = String(exported()[0]!.html);
    expect(html, 'a raw <script> from run content is an injection').not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    const doc = parse(html);
    // The page ships exactly TWO scripts of its own — the JSON step data and
    // the painter that renders it (labyrinthReport.ts). A third would mean run
    // content had closed one of them and opened an executable region of its
    // own, which is the whole failure this test exists for.
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts, 'run content became an executable element').toHaveLength(2);
    expect(scripts[0]!.getAttribute('type')).toBe('application/json');
    expect(scripts[1]!.textContent, 'run content reached the executable block').not.toContain('alert');
    // ...and it survives INTACT: escaping must not mangle the title either.
    expect(rowCells(doc, 0)[3]).toBe(HOSTILE);
    expect(rowCells(doc, 0)[2]).toBe('bash <&>');
    // The table still has exactly the one row — nothing was torn in half.
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});

describe('LabyrinthPane — a late reply for an abandoned run is dropped', () => {
  it('steps for a run the user has navigated away from never overwrite the current one', async () => {
    const { container } = await withRun({ steps: [step(0, { title: 'run A step' })], truncated: false, total: 1 });
    send({ type: 'runStepsData', sessionId: 'ses_b', steps: [step(0), step(1), step(2)], truncated: true, total: 900 });
    await tick();

    expect(container.querySelectorAll('.marker')).toHaveLength(1);
    expect(container.querySelector('.lab-truncated')).toBeNull();
  });
});

// t-q41pe0 — the run-index and inspector columns become draggable so either
// can be slimmed on a small monitor. jsdom has no layout engine
// (getBoundingClientRect is always a zero DOMRect — see chatSections.test.ts's
// own note on the sidebar's Chats/Collabs divider), so what is checkable here
// is the WIRING — a drag/keyboard gesture reaches the clamp and its result is
// posted to the host — not the actual pixel math a real drag would produce;
// that needs a human eyeball. The clamp math itself is unit-tested with plain
// numbers in labyrinthColumns.test.ts.
describe('LabyrinthPane — draggable run-index and inspector columns', () => {
  it('asks the host for persisted column widths on mount', () => {
    render(LabyrinthPane);
    expect(posts()).toContainEqual({ type: 'requestLabyrinthColumns' });
  });

  it('a labyrinthColumns reply applies as an inline width on the run index and the inspector', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'labyrinthColumns', indexWidthPx: 220, inspectWidthPx: 260 });
    await tick();
    expect((container.querySelector('.lab-index') as HTMLElement).style.width).toBe('220px');
    expect((container.querySelector('.lab-inspect') as HTMLElement).style.width).toBe('260px');
  });

  it('a null reply leaves both columns on their default CSS width (no inline override)', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'labyrinthColumns', indexWidthPx: null, inspectWidthPx: null });
    await tick();
    expect((container.querySelector('.lab-index') as HTMLElement).style.width).toBe('');
    expect((container.querySelector('.lab-inspect') as HTMLElement).style.width).toBe('');
  });

  it('a full pointer drag on the LEFT divider posts the settled width for the "index" column', async () => {
    const { container } = render(LabyrinthPane);
    const divider = container.querySelectorAll('.lab-divider')[0] as HTMLElement;

    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 300 });
    await fireEvent.pointerMove(window, { pointerId: 1, clientX: 250 });
    await fireEvent.pointerUp(window, { pointerId: 1 });

    const resize = posts().find((p) => p.type === 'resizeLabyrinthColumn');
    expect(resize).toMatchObject({ column: 'index' });
    expect(typeof (resize as { widthPx: unknown }).widthPx).toBe('number');
  });

  it('a full pointer drag on the RIGHT divider posts the settled width for the "inspect" column', async () => {
    const { container } = render(LabyrinthPane);
    const divider = container.querySelectorAll('.lab-divider')[1] as HTMLElement;

    await fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    await fireEvent.pointerMove(window, { pointerId: 1, clientX: 460 });
    await fireEvent.pointerUp(window, { pointerId: 1 });

    const resize = posts().find((p) => p.type === 'resizeLabyrinthColumn');
    expect(resize).toMatchObject({ column: 'inspect' });
    expect(typeof (resize as { widthPx: unknown }).widthPx).toBe('number');
  });

  it('pointer movement before pointerdown (nothing being dragged) posts nothing', async () => {
    render(LabyrinthPane);
    await fireEvent.pointerMove(window, { pointerId: 1, clientX: 250 });
    await fireEvent.pointerUp(window, { pointerId: 1 });
    expect(posts().filter((p) => p.type === 'resizeLabyrinthColumn')).toEqual([]);
  });

  it('ArrowLeft/ArrowRight on a focused divider also resize and post — a keyboard path, not pointer-only', async () => {
    const { container } = render(LabyrinthPane);
    const divider = container.querySelectorAll('.lab-divider')[0] as HTMLElement;

    await fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(posts().filter((p) => p.type === 'resizeLabyrinthColumn')).toHaveLength(1);

    await fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(posts().filter((p) => p.type === 'resizeLabyrinthColumn')).toHaveLength(2);

    // A key this control does not own is ignored — no phantom resize on every keystroke.
    await fireEvent.keyDown(divider, { key: 'Tab' });
    expect(posts().filter((p) => p.type === 'resizeLabyrinthColumn')).toHaveLength(2);
  });

  it('both dividers are real keyboard targets — role=separator and tabindex=0', () => {
    const { container } = render(LabyrinthPane);
    const dividers = container.querySelectorAll('.lab-divider');
    expect(dividers).toHaveLength(2);
    for (const d of dividers) {
      expect(d.getAttribute('role')).toBe('separator');
      expect(d.getAttribute('tabindex')).toBe('0');
    }
  });

  it('the run-index divider never touches the inspector width, and vice versa', async () => {
    const { container } = render(LabyrinthPane);
    const [indexDivider, inspectDivider] = Array.from(container.querySelectorAll('.lab-divider')) as HTMLElement[];

    await fireEvent.keyDown(indexDivider!, { key: 'ArrowRight' });
    let resize = posts().findLast((p) => p.type === 'resizeLabyrinthColumn');
    expect(resize).toMatchObject({ column: 'index' });
    expect((container.querySelector('.lab-inspect') as HTMLElement).style.width).toBe('');

    await fireEvent.keyDown(inspectDivider!, { key: 'ArrowLeft' });
    resize = posts().findLast((p) => p.type === 'resizeLabyrinthColumn');
    expect(resize).toMatchObject({ column: 'inspect' });
    // The index column keeps the width its OWN divider set, unaffected by the other.
    expect((container.querySelector('.lab-index') as HTMLElement).style.width).not.toBe('');
  });
});
