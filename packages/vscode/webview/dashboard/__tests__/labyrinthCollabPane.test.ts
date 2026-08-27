// The Labyrinth pane with COLLABS on the board — the user-visible half of the
// collab map. Mirrors labyrinthPane.test.ts's idiom (postMessage spy for the
// outbound wire, MessageEvent for the inbound one, a `step()` factory).
//
// The honesty failures worth catching:
//  - a collab that hides the only route to a member's own run,
//  - lanes labelled with member names that are not the members on them,
//  - a machine baton drawn as if a person had typed it,
//  - a handoff edge to a lane nobody named.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

// Two members of one collab, plus an ordinary run that must be unaffected.
const ROWS = [
  { sessionId: 's_heron', title: 'Plan the arc', folder: 'coder', cwd: 'C:/repos/coder', updatedAt: '2026-08-06T10:00:00.000Z', collabId: 'c1', collabTitle: 'Ship the labyrinth', agentSlug: 'heron' },
  { sessionId: 's_crane', title: 'Build the map', folder: 'coder', cwd: 'C:/repos/coder', updatedAt: '2026-08-06T11:00:00.000Z', collabId: 'c1', collabTitle: 'Ship the labyrinth', agentSlug: 'crane' },
  { sessionId: 'ses_plain', title: 'Fix the crash', folder: 'spark', cwd: 'C:/repos/spark', updatedAt: '2026-08-05T09:00:00.000Z' },
];

const step = (ordinal: number, over: Record<string, unknown> = {}) => ({
  ordinal, kind: 'tool', title: `step ${ordinal}`, depth: 1, startedAt: ordinal * 1000,
  endedAt: ordinal * 1000 + 500, ...over,
});

/** Mount, list the rows, and click the row at `index` in the rendered index. */
async function pick(index: number) {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: ROWS });
  await tick();
  await fireEvent.click(rendered.container.querySelectorAll('.lab-run')[index]!);
  await tick();
  return rendered;
}

/** A loaded collab map: two members, flight mode (the only mode with lanes). */
async function collabMap(over: Record<string, unknown> = {}) {
  const rendered = await pick(0);
  send({
    type: 'runStepsData', sessionId: 'collab:c1', members: ['heron', 'crane'],
    steps: [step(1, { agent: 'heron' }), step(2, { agent: 'crane' })],
    truncated: false, total: 2, ...over,
  });
  await tick();
  await fireEvent.click([...rendered.container.querySelectorAll('.lab-mode')].find((b) => b.textContent === 'Flight')!);
  await tick();
  return rendered;
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('LabyrinthPane — a collab is one entry in the index, not N unrelated roots', () => {
  it('collapses the members into one header row and says how many agents it has', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'historyList', sessions: ROWS });
    await tick();
    // Three listed sessions, but TWO rows: the collab and the ordinary run.
    const rows = container.querySelectorAll('.lab-run');
    expect(rows).toHaveLength(2);
    expect(flat(rows[0]!.textContent)).toContain('Ship the labyrinth');
    expect(flat(rows[0]!.textContent)).toContain('2 agents');
    expect(flat(rows[1]!.textContent)).toContain('Fix the crash');
  });

  it('picking the header asks for the MERGED steps, under a member\'s real cwd', async () => {
    await pick(0);
    expect(posts()).toContainEqual({ type: 'requestCollabSteps', collabId: 'c1', cwd: 'C:/repos/coder' });
    expect(posts().filter((p) => p.type === 'requestRunSteps')).toEqual([]);
  });

  it('an ordinary run is untouched — it still posts requestRunSteps with its own cwd', async () => {
    await pick(1);
    expect(posts()).toContainEqual({ type: 'requestRunSteps', sessionId: 'ses_plain', cwd: 'C:/repos/spark' });
    expect(posts().filter((p) => p.type === 'requestCollabSteps')).toEqual([]);
  });

  it('the members stay individually reachable behind the expander', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'historyList', sessions: ROWS });
    await tick();
    await fireEvent.click(container.querySelector('.lab-expand')!);
    await tick();
    const members = container.querySelectorAll('.lab-member');
    expect(members).toHaveLength(2);
    expect(flat(members[0]!.textContent)).toContain('heron');

    await fireEvent.click(members[1]!);
    await tick();
    // A member's own map is the ORDINARY single-run request, not the collab one.
    expect(posts()).toContainEqual({ type: 'requestRunSteps', sessionId: 's_crane', cwd: 'C:/repos/coder' });
  });

  it('the merged reply is accepted even though its id is not a session id', async () => {
    const { container } = await collabMap();
    // `collab:c1` echoes the selection, so the navigated-away guard lets it in.
    expect(container.querySelectorAll('.marker')).toHaveLength(2);
    expect(container.querySelector('.lab-error')).toBeNull();
  });
});

describe('LabyrinthPane — a collab map says WHO ran on each lane', () => {
  it('labels the lanes with the member slugs instead of SUB-AGENT n', async () => {
    const { container } = await collabMap();
    const tags = [...container.querySelectorAll('.lane-tag')].map((t) => flat(t.textContent));
    expect(tags).toContain('heron');
    expect(tags).toContain('crane');
    expect(tags.some((t) => t.startsWith('SUB-AGENT'))).toBe(false);
  });

  it('the two members really are drawn on DIFFERENT lanes', async () => {
    const { container } = await collabMap();
    const ys = [...container.querySelectorAll('.marker')].map((m) => m.getAttribute('cy'));
    // The defect this whole arc exists to fix: both members on one row.
    expect(new Set(ys).size).toBe(2);
  });

  it('a member that never started keeps its lane, so a label never slides onto the wrong row', async () => {
    const { container } = await collabMap({ members: ['heron', 'ibis', 'crane'] });
    const tags = [...container.querySelectorAll('.lane-tag')].map((t) => flat(t.textContent));
    expect(tags).toEqual(['TOOLS', 'MAIN', 'heron', 'ibis', 'crane']);
  });

  it('an ORDINARY run still says DELEGATION / SUB-AGENT — nothing about it changed', async () => {
    const { container } = await pick(1);
    send({
      type: 'runStepsData', sessionId: 'ses_plain', truncated: false, total: 2,
      steps: [
        { ordinal: 1, kind: 'subagent', title: 'task', startedAt: 1000, endedAt: 2000, status: 'completed' },
        { ordinal: 2, kind: 'tool', title: 'child', depth: 1, parentOrdinal: 1, startedAt: 1200, endedAt: 1400 },
      ],
    });
    await tick();
    await fireEvent.click([...container.querySelectorAll('.lab-mode')].find((b) => b.textContent === 'Flight')!);
    await tick();
    const tags = [...container.querySelectorAll('.lane-tag')].map((t) => flat(t.textContent));
    expect(tags).toContain('DELEGATION');
  });
});

describe('LabyrinthPane — coordination marks tell machine traffic from human traffic', () => {
  it('a Flock tool call is toned apart from ordinary work', async () => {
    const { container } = await collabMap({
      steps: [step(1, { agent: 'heron', tool: 'handoff', collabTool: true }), step(2, { agent: 'crane' })],
    });
    expect(container.querySelectorAll('.node.is-collab')).toHaveLength(1);
  });

  it('a `[Collab: ...]` baton renders DIM — it is the runner talking, not a person', async () => {
    const { container } = await collabMap({
      steps: [
        step(1, { agent: 'heron', kind: 'prompt', title: '[Collab: Ship it] go', baton: true }),
        step(2, { agent: 'crane', kind: 'prompt', title: 'a human asked this' }),
      ],
    });
    const dimmed = container.querySelectorAll('.node.is-baton');
    expect(dimmed).toHaveLength(1);
    // ...and its KIND is untouched: it is still a prompt, just a quiet one.
    expect(dimmed[0]!.classList.contains('tone-prompt')).toBe(true);
  });

  it('an ordinary run carries neither mark', async () => {
    const { container } = await pick(1);
    send({ type: 'runStepsData', sessionId: 'ses_plain', steps: [step(1, { depth: 0 })], truncated: false, total: 1 });
    await tick();
    expect(container.querySelectorAll('.node.is-collab')).toHaveLength(0);
    expect(container.querySelectorAll('.node.is-baton')).toHaveLength(0);
  });
});

describe('LabyrinthPane — a handoff edge is drawn only where the run named its target', () => {
  it('draws the rail when the handoff names a member that then ran', async () => {
    const { container } = await collabMap({
      steps: [
        // Exactly as the engine projects a handoff: the title is the bare tool
        // name, and only the preview names the target, @-prefixed.
        step(1, { agent: 'heron', tool: 'handoff', collabTool: true, title: 'handoff', preview: 'Handed to @crane - your turn ends here.' }),
        step(2, { agent: 'crane', title: 'picks it up' }),
      ],
    });
    const edges = container.querySelectorAll('path.handoff');
    expect(edges).toHaveLength(1);
    expect(flat(edges[0]!.querySelector('title')!.textContent)).toBe('handoff to crane');
  });

  it('draws NOTHING when the handoff names nobody — the mark still shows, the edge does not', async () => {
    const { container } = await collabMap({
      steps: [
        // A REFUSED handoff: same shape, but it quotes the roster BARE, with no
        // `@`. Matching bare slugs here would draw an edge out of a FAILURE.
        step(1, { agent: 'heron', tool: 'handoff', collabTool: true, title: 'handoff', preview: 'There is no "zebra" in this collab - on the roster: crane, heron.' }),
        step(2, { agent: 'crane', title: 'unrelated work' }),
      ],
    });
    expect(container.querySelectorAll('path.handoff')).toHaveLength(0);
    expect(container.querySelectorAll('.node.is-collab')).toHaveLength(1);
  });
});
