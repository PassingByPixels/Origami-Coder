// The task board became a SLIDE-OUT DRAWER. What has to survive that move is
// everything the board already did — CollabPane.test.ts's board suite covers
// that, unchanged, and is the real regression net. What is pinned HERE is what
// only the drawer can get wrong:
//
//   1. THE TAB IS ALWAYS THERE. A drawer with no handle is a feature nobody can
//      find. It has to be on screen while the drawer is shut, which is the
//      state it starts in.
//   2. IT STARTS SHUT, and it FLOATS. The whole reason for the move is that the
//      board stopped taking a band of height out of the transcript, so the
//      drawer must be positioned OVER the stream, not stacked in the column.
//   3. THE DRAWER ITSELF IS NEVER DROPPED. Collapsing is a CSS slide, so the
//      tab and the board's summary line stay mounted and the drawer can always
//      be pulled back out. (The board's ROWS are gated by TaskBoard's own
//      `open`, exactly as they were before the move — an engine-authoritative
//      board redraws from the next poll rather than from a stale local copy.)
//   4. ONE FOLD, TWO HANDLES. The tab and the board's own head both drive the
//      same state — two `open` flags disagreeing is the bug this shape avoids.
//   5. THE LEDGER IS STILL FETCHED ON OPEN, and only then.

import { render, fireEvent, cleanup, screen } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { tick } from 'svelte';
import CollabPane from './CollabPane.svelte';

const ID = 'collab-drawer';

beforeEach(() => {
  (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__ = { id: ID, title: 'Board' };
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
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1', title: 'Wire the store', owner: 'collab-crane', state: 'open',
  createdBy: 'user', result: null, note: null, originSeq: null,
  createdAt: '2026-08-05T10:00:00.000Z', updatedAt: '2026-08-05T10:00:00.000Z', ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  type: 'collabStateData',
  collabId: ID,
  sinceSeq: 0,
  collab: { id: ID, title: 'Board', createdAt: '', loopBreakerCap: null },
  participants: [],
  messages: [],
  agents: [],
  suspended: false,
  ...over,
});

const tab = (c: HTMLElement) => c.querySelector('.ctd-tab') as HTMLButtonElement;
const drawer = (c: HTMLElement) => c.querySelector('.ctd') as HTMLElement;
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('.tb-row'));

describe('CollabTaskDrawer — the handle', () => {
  it('the pull-tab is on screen from the start, while the drawer is still shut', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));

    expect(tab(container)).not.toBeNull();
    expect(drawer(container).className).toContain('collapsed');
    expect(tab(container).getAttribute('aria-expanded')).toBe('false');
    // Shut means the ROWS are not showing — the board's summary still is.
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('.tb-summary')!.textContent).toContain('1 task');
  });

  it('the tab opens it and closes it again, and says which it will do next', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));

    await fireEvent.click(tab(container));
    expect(drawer(container).className).not.toContain('collapsed');
    expect(tab(container).getAttribute('aria-expanded')).toBe('true');
    expect(tab(container).getAttribute('aria-label')).toMatch(/Hide/);
    expect(rows(container)).toHaveLength(1);

    await fireEvent.click(tab(container));
    expect(drawer(container).className).toContain('collapsed');
    expect(tab(container).getAttribute('aria-label')).toMatch(/Show/);
    expect(rows(container)).toHaveLength(0);
  });

  // Two controls, ONE piece of state. If the head kept an `open` of its own the
  // tab could say "open" while the board drew nothing.
  it('the board head drives the same fold as the tab', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));

    await fireEvent.click(container.querySelector('.tb-head') as HTMLButtonElement);
    expect(drawer(container).className).not.toContain('collapsed');
    expect(rows(container)).toHaveLength(1);

    await fireEvent.click(container.querySelector('.tb-head') as HTMLButtonElement);
    expect(drawer(container).className).toContain('collapsed');
  });
});

describe('CollabTaskDrawer — it floats, and it keeps its contents', () => {
  // The point of the change: the board stopped costing the transcript height.
  it('is an overlay on the pane, not a band stacked in its column', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));

    const overlay = container.querySelector('.ctd-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    // Its own box positions it; the pane is the box it positions against.
    expect(overlay.parentElement!.className).toContain('collab');
    expect(container.querySelector('.collab')).not.toBeNull();
  });

  // Closing SLIDES the panel off; it does not unmount the drawer. If it did,
  // the tab would go with it and there would be no way back in — the exact
  // failure a `{#if}` around the whole thing would produce.
  it('closing slides the panel away and leaves the tab and the summary reachable', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));
    await fireEvent.click(tab(container));
    expect(rows(container)).toHaveLength(1);

    await fireEvent.click(tab(container));
    expect(drawer(container).className).toContain('collapsed');
    // The handle and the board's one-line summary are still there to come back to.
    expect(tab(container)).not.toBeNull();
    expect(container.querySelector('.tb-head')).not.toBeNull();
    expect(container.querySelector('.tb-summary')!.textContent).toContain('1 task');

    // ...and reopening draws the board from the POLLED state, not a local copy:
    // a task that changed while the drawer was shut comes back changed.
    await post(state({ sinceSeq: 0, tasks: [task({ state: 'done' })] }));
    await fireEvent.click(tab(container));
    // The wire state is what moved; the chip prints what it means to a reader.
    expect(container.querySelector('.tb-chip')!.getAttribute('data-state')).toBe('done');
  });

  it('asks for the per-turn ledger when it OPENS, and not before', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: [{ agentSlug: 'collab-crane', cost: 0.25, tokensInput: 12000, tokensOutput: 20000 }] }));
    expect(posts().filter((p) => p.type === 'requestCollabLedger')).toEqual([]);

    await fireEvent.click(tab(container));
    expect(posts().filter((p) => p.type === 'requestCollabLedger')).toHaveLength(1);

    // Closing asks for nothing; reopening asks again (the spend has moved on).
    await fireEvent.click(tab(container));
    expect(posts().filter((p) => p.type === 'requestCollabLedger')).toHaveLength(1);
    await fireEvent.click(tab(container));
    expect(posts().filter((p) => p.type === 'requestCollabLedger')).toHaveLength(2);
  });
});

describe('CollabTaskDrawer — the board still acts on the engine', () => {
  it('Add posts collabTaskAdd from inside the drawer', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [] }));
    await fireEvent.click(tab(container));

    await fireEvent.input(screen.getByLabelText('New task title'), { target: { value: '  Ship the wire  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(posts()).toContainEqual({ type: 'collabTaskAdd', collabId: ID, title: 'Ship the wire' });
  });

  it('Accept and Reopen still post for THAT task, and only a done one offers them', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ id: 't1', state: 'open' }), task({ id: 't3', state: 'done' })] }));
    await fireEvent.click(tab(container));

    const buttonsIn = (row: Element) => Array.from(row.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttonsIn(rows(container)[0])).toEqual([]);
    expect(buttonsIn(rows(container)[1])).toEqual(['Accept', 'Reopen']);

    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(posts()).toContainEqual({ type: 'collabTaskUpdate', collabId: ID, taskId: 't3', action: 'accept' });

    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await fireEvent.input(screen.getByLabelText('Reopen note for Wire the store'), { target: { value: 'still fails' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(posts()).toContainEqual({
      type: 'collabTaskUpdate', collabId: ID, taskId: 't3', action: 'reopen', note: 'still fails',
    });
  });
});

// -- W2: THE LONE PILL (owner screenshot) ------------------------------------
//
// WHAT WAS SEEN. A collab with nothing much on it rendered, mid-right, a small
// floating pill carrying one chevron and nothing else, over an otherwise blank
// pane. Nobody could tell what it was, and the only way to find out was to click
// it.
//
// THE ROOT CAUSE is one CSS split, and it produced two symptoms.
//
//   `.ctd-overlay` is the STATIONARY positioning box; `.ctd` inside it is what
//   slides. The lift (`box-shadow`), the scroll container (`overflow-y: auto` +
//   `max-height`) and the whole 280px x 72% hit area all lived on the
//   stationary box. So when the panel slid away, all three stayed:
//
//     1. a ghost panel - a large soft shadow around a now-transparent box, which
//        is the "blank pane" the pill appeared to be sitting on; and
//     2. a dead column - an invisible, click-and-wheel-swallowing overlay across
//        the right-hand quarter of the transcript, which also ate the very wheel
//        events the new stream follow (report 1.11) reads.
//
//   ...and the tab itself said nothing. A drawer whose handle carries only a
//   chevron is a control that has to be opened before it can be identified.
//
// The geometry fix is CSS and jsdom lays nothing out, so what is PINNED here is
// the half a test can actually see: the handle names the thing it opens, and
// says how much is behind it. The CSS half is stated in CollabTaskDrawer.svelte
// and verified by reading the compiled component, not by this file.
describe('CollabTaskDrawer - the handle says what it is', () => {
  it('names the board on the collapsed tab, instead of a bare chevron', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));

    expect(drawer(container).className).toContain('collapsed');
    expect(tab(container).textContent).toContain('Tasks');
  });

  it('states the open count on the tab, so the room says it is owed something', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ id: 't1', state: 'open' }), task({ id: 't2', state: 'done' })] }));
    expect(tab(container).textContent).toContain('2');
  });

  // A count of nothing is noise. The board is still named, so the handle is
  // still identifiable - it just does not claim work that is not there.
  it('shows no count at all on an empty board', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [] }));
    expect(tab(container).textContent).toContain('Tasks');
    expect(tab(container).textContent).not.toMatch(/\d/);
  });

  it('shows no count on an engine that has no board - there is nothing to count', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(tab(container).textContent).not.toMatch(/\d/);
  });

  // The label is on the HANDLE, so it must survive the drawer being opened -
  // a control that renames itself on click is a second control.
  it('keeps its name once the drawer is open', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task()] }));
    await fireEvent.click(tab(container));
    expect(tab(container).textContent).toContain('Tasks');
  });
});

// -- W8: THE HEADER AND THE CHIPS TELLING TWO STORIES (owner screenshot) ------
//
// WHAT WAS SEEN. One task on the board, chip reading OPEN and unassigned, and a
// header above it reading "1 task - 1 in play - 0 awaiting you". Both were drawn
// from the same array. The header lumped `open` in with `claimed` and called the
// pair "in play", so a task NOBODY had picked up was reported as work under way,
// and the owner read the board as agreeing with an agent that claimed to have
// done it.
//
// The engine half of that bug is fixed where it belongs (the agent could not see
// any task id, so its claim was refused and the board never moved). What is
// pinned HERE is the drawer's own half: four states, four different sentences,
// and the claimant named on every row that has one.
describe('CollabTaskDrawer - the board says who has what', () => {
  const summary = (c: HTMLElement) => c.querySelector('.tb-summary')!.textContent;
  const chips = (c: HTMLElement) => Array.from(c.querySelectorAll('.tb-chip')).map((n) => n.textContent);
  const owners = (c: HTMLElement) => Array.from(c.querySelectorAll('.tb-owner')).map((n) => n.textContent);

  it('does not call an UNCLAIMED task "in play" - nobody is working on it', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ state: 'open', owner: null })] }));
    // The exact line from the screenshot, and the exact thing it got wrong.
    expect(summary(container)).not.toContain('in play');
    expect(summary(container)).toBe('1 task · 1 unclaimed');
  });

  it('counts each state on its own, so the header cannot contradict the chips', async () => {
    const { container } = render(CollabPane);
    await post(state({
      tasks: [
        task({ id: 't1', state: 'open', owner: null }),
        task({ id: 't2', state: 'claimed', owner: 'collab-heron' }),
        task({ id: 't3', state: 'done', owner: 'collab-heron' }),
      ],
    }));
    expect(summary(container)).toBe('3 tasks · 1 unclaimed · 1 in play · 1 awaiting you');
  });

  // A board of finished work must not report three zeroes at the reader.
  it('says a fully accepted board is settled rather than counting nothing three times', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ id: 't1', state: 'accepted', owner: 'collab-heron' })] }));
    expect(summary(container)).toBe('1 task · all accepted');
  });

  it('names the CLAIMANT on the row, so "who has it" is answered on the board', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ state: 'claimed', owner: 'collab-heron' })] }));
    await fireEvent.click(tab(container));
    expect(chips(container)).toEqual(['claimed']);
    expect(owners(container)).toEqual(['@collab-heron']);
  });

  it('says an unclaimed task is unclaimed, in the same word the header counts it in', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ state: 'open', owner: null })] }));
    await fireEvent.click(tab(container));
    expect(chips(container)).toEqual(['open']);
    expect(owners(container)).toEqual(['unclaimed']);
  });

  // `done` is NOT finished: it is the engine's awaiting-review state, and the
  // Accept / Reopen buttons beside it are the whole reason it exists. A chip
  // reading "done" says the opposite of what the row is asking for.
  it('reads a completed task as AWAITING REVIEW, with the agent that did it named', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ state: 'done', owner: 'collab-heron' })] }));
    await fireEvent.click(tab(container));
    expect(chips(container)).toEqual(['awaiting review']);
    expect(owners(container)).toEqual(['@collab-heron']);
    // The state machine's own word stays on the element, so the styling and
    // every engine-facing check still key off the wire value.
    expect(container.querySelector('.tb-chip')!.getAttribute('data-state')).toBe('done');
  });

  it('reads an accepted task as closed, still naming who did it', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ state: 'accepted', owner: 'collab-heron' })] }));
    await fireEvent.click(tab(container));
    expect(chips(container)).toEqual(['accepted']);
    expect(owners(container)).toEqual(['@collab-heron']);
  });
});
