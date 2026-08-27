// W5-L2 — a COUNCIL ROUND on screen, driven through the real pane.
//
// What is worth a render here, over and above collabCouncil.test.ts's folding
// rules:
//
//   1. THE SPREAD IS VISIBLE AT A GLANCE, AND NO ANSWER IS BURIED. Every member
//      that spoke has a line; opening one opens that member alone.
//   2. THE COUNT IS THE ENGINE'S. "2 of 3 answered — ibis failed" is drawn from
//      the record row, never counted off the bubbles — a member that failed or
//      was stopped left no bubble, and counting here would delete the exact
//      fact the record exists to state.
//   3. A DISCUSS ROOM IS UNCHANGED. No frame, no fold, one bubble per message.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { tick } from 'svelte';
import CollabPane from './CollabPane.svelte';

const ID = 'collab-round';

beforeEach(() => {
  (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__ = { id: ID, title: 'Council' };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__;
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

let seq = 0;
const msg = (over: Record<string, unknown>) => ({
  seq: ++seq,
  authorKind: 'agent',
  text: '',
  createdAt: new Date(0).toISOString(),
  ...over,
});

const state = (messages: unknown[]) => ({
  type: 'collabStateData',
  collabId: ID,
  sinceSeq: 0,
  collab: { id: ID, title: 'Council', createdAt: '', loopBreakerCap: null, flavor: 'council' },
  participants: [
    { agentSlug: 'crane', displayName: 'Crane the Rewriter', model: null },
    { agentSlug: 'heron', displayName: 'Heron the Sceptic', model: null },
    { agentSlug: 'ibis', displayName: 'Ibis the Measurer', model: null },
  ],
  messages,
  agents: [],
  suspended: false,
});

/** A whole round: three independent answers, the record, the reconciliation. */
const ROUND = () => [
  msg({ authorId: 'user', authorKind: 'human', text: 'should we rewrite the parser?' }),
  msg({ authorId: 'crane', kind: 'opinion', text: 'Rewrite it.\nThe grammar is the problem.' }),
  msg({ authorId: 'heron', kind: 'opinion', text: 'Keep it. The cost is in I/O.' }),
  msg({ authorId: 'ibis', kind: 'opinion', text: 'Measure first.' }),
  msg({ authorId: 'collab', kind: 'round', text: 'Council round: 3 of 3 answered.' }),
  msg({ authorId: 'crane', kind: 'synthesis', text: 'We measure, then decide.' }),
];

const rounds = (c: HTMLElement) => Array.from(c.querySelectorAll('.cr'));
const voices = (c: HTMLElement) => Array.from(c.querySelectorAll('.cr-toggle'));

describe('CollabRoundGroup — a round on screen', () => {
  it('draws ONE block for the round, with the question left outside it', async () => {
    const { container } = render(CollabPane);
    await post(state(ROUND()));
    expect(rounds(container)).toHaveLength(1);
    // The human's question is what was asked, and burying it inside the answers
    // would hide it. It stays an ordinary speaker's run.
    const groups = Array.from(container.querySelectorAll('.cs-group'));
    expect(groups.some((g) => g.textContent?.includes('should we rewrite the parser?'))).toBe(true);
  });

  it('gives every member ONE collapsed line, so the spread reads at a glance', async () => {
    const { container } = render(CollabPane);
    await post(state(ROUND()));
    const lines = voices(container);
    expect(lines).toHaveLength(3);
    // The SHORT name the rest of the surface shows, mined from the def's
    // description — not the slug, and not the whole description either.
    expect(lines.map((l) => l.querySelector('.cr-who')?.textContent)).toEqual(['Crane', 'Heron', 'Ibis']);
    // The FIRST line of the answer only. crane's second line is behind the fold.
    expect(lines[0]!.textContent).toContain('Rewrite it.');
    expect(lines[0]!.textContent).not.toContain('The grammar is the problem');
    expect(lines.every((l) => l.getAttribute('aria-expanded') === 'false')).toBe(true);
  });

  it('opens ONE member without unrolling the rest', async () => {
    const { container } = render(CollabPane);
    await post(state(ROUND()));
    await fireEvent.click(voices(container)[0]!);
    await tick();

    const opened = container.querySelectorAll('.cr-full');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.textContent).toContain('The grammar is the problem');
    // heron and ibis are still lines, not essays.
    expect(voices(container)[1]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the ENGINE\'S count, failures named, not one counted off the bubbles', async () => {
    // Two answers on screen, three members in the round. Counting here would
    // read "2 of 2" and silently delete ibis.
    const { container } = render(CollabPane);
    await post(
      state([
        msg({ authorId: 'crane', kind: 'opinion', text: 'Rewrite it.' }),
        msg({ authorId: 'heron', kind: 'opinion', text: 'Keep it.' }),
        msg({ authorId: 'collab', kind: 'round', text: 'Council round: 2 of 3 answered. ibis failed.' }),
      ]),
    );
    const head = container.querySelector('.cr-line') as HTMLElement;
    expect(head.textContent).toContain('2 of 3 answered');
    expect(head.textContent).toContain('ibis failed');
    expect(voices(container)).toHaveLength(2);
  });

  it('marks an OPEN round as open while its answers are still landing', async () => {
    const { container } = render(CollabPane);
    await post(state([msg({ authorId: 'crane', kind: 'opinion', text: 'Rewrite it.' })]));
    const block = rounds(container)[0] as HTMLElement;
    expect(block.classList.contains('open')).toBe(true);
    expect(block.querySelector('.cr-line')?.textContent).toContain('1 answered so far');
    expect(block.querySelector('.cr-synth')).toBeNull();
  });

  it('sets the SYNTHESIS apart, inside the round and never collapsed', async () => {
    const { container } = render(CollabPane);
    await post(state(ROUND()));
    const synth = container.querySelector('.cr-synth') as HTMLElement;
    expect(synth).not.toBeNull();
    // Read without a click, unlike every opinion above it: it is the one
    // contribution that read all of them.
    expect(synth.textContent).toContain('We measure, then decide.');
    expect(synth.textContent).toContain('reconciled the round');
  });

  it('leaves a DISCUSS transcript with no frame and no fold', async () => {
    const { container } = render(CollabPane);
    await post({
      type: 'collabStateData',
      collabId: ID,
      sinceSeq: 0,
      collab: { id: ID, title: 'Room', createdAt: '', loopBreakerCap: null },
      participants: [{ agentSlug: 'crane', displayName: 'Crane', model: null }],
      messages: [msg({ authorId: 'crane', text: 'on it' })],
      agents: [],
      suspended: false,
    });
    expect(rounds(container)).toHaveLength(0);
    expect(container.textContent).toContain('on it');
  });
});
