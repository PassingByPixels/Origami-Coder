// The hop bar's PLACEMENT and its emphasis, driven through the real pane so
// the poll is the thing that moves the number.
//
// What is worth pinning here, over and above collabHop.test.ts's wording rules:
//
//   1. WHERE IT IS. The whole point of the move is that the budget's controls
//      sit under the box that spends it. A bar that drifted back above the
//      stream would still pass every text assertion in the leaf's suite.
//   2. THE COUNT IS SERVER TRUTH. It changes when a poll lands and at no other
//      time. A client-side ticker would run the number down between polls and
//      disagree with the engine's own budget — which is the failure the
//      countdown exists to prevent.
//   3. THE CONTROLS STILL WORK after the move: Set cap keeps the three cap
//      values apart, and Stop still posts for this collab.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import CollabPane from './CollabPane.svelte';

const ID = 'collab-hop';

beforeEach(() => {
  (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__ = { id: ID, title: 'Budget' };
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

const state = (over: Record<string, unknown> = {}) => ({
  type: 'collabStateData',
  collabId: ID,
  sinceSeq: 0,
  collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: null },
  participants: [],
  messages: [],
  agents: [],
  suspended: false,
  ...over,
});

const bar = (c: HTMLElement) => c.querySelector('.cap-row') as HTMLElement;
const hop = (c: HTMLElement) => c.querySelector('.hop-text') as HTMLElement | null;

describe('CollabHopBar — it lives BELOW the composer', () => {
  it('is the last thing in the pane, after the composer, not above the stream', async () => {
    const { container } = render(CollabPane);
    await post(state({ hopState: { remaining: 14, cap: 20 } }));

    const pane = container.querySelector('.collab') as HTMLElement;
    const kids = Array.from(pane.children);
    // The bar is the LAST child...
    expect(kids.at(-1)).toBe(bar(container));
    // ...and the composer is the one immediately before it.
    expect(kids.at(-2)!.querySelector('textarea.input')).not.toBeNull();
  });

  // The control strip above the stream keeps the paused banner and the
  // objective, and must NOT have kept a second copy of the cap controls.
  it('there is exactly one of each control, and none of them is up in the header', async () => {
    const { container } = render(CollabPane);
    await post(state({ suspended: true, objective: 'Ship it', hopState: { remaining: 2, cap: 20 } }));

    expect(container.querySelectorAll('.cap-row')).toHaveLength(1);
    expect(container.querySelectorAll('.cap-input')).toHaveLength(1);
    expect(container.querySelectorAll('.stop-btn')).toHaveLength(1);
    // The banner and the objective did stay up top, ahead of the stream.
    const pane = container.querySelector('.collab') as HTMLElement;
    const kids = Array.from(pane.children);
    expect(kids.findIndex((k) => k.querySelector('.suspend-text') || k.classList.contains('suspend-banner')))
      .toBeLessThan(kids.findIndex((k) => k.classList.contains('stream')));
  });
});

describe('CollabHopBar — the remaining count', () => {
  it('shows what is left against what it started with', async () => {
    const { container } = render(CollabPane);
    await post(state({ hopState: { remaining: 14, cap: 20 } }));
    expect(hop(container)!.textContent).toBe('hops 14/20');
  });

  it('takes the emphasis state at 3 and keeps it down to 0 — and drops it again when the budget refills', async () => {
    const { container } = render(CollabPane);
    await post(state({ hopState: { remaining: 4, cap: 20 } }));
    expect(hop(container)!.className).not.toContain('is-low');

    await post(state({ sinceSeq: 0, hopState: { remaining: 3, cap: 20 } }));
    expect(hop(container)!.className).toContain('is-low');

    await post(state({ sinceSeq: 0, hopState: { remaining: 0, cap: 20 } }));
    expect(hop(container)!.className).toContain('is-low');

    // Posting buys a fresh budget; the emphasis has to come back off with it.
    await post(state({ sinceSeq: 0, hopState: { remaining: 20, cap: 20 } }));
    expect(hop(container)!.className).not.toContain('is-low');
  });

  it('an engine that reports no budget draws no count at all', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(hop(container)).toBeNull();
    // ...but the bar itself is still there, because the cap is still settable.
    expect(bar(container)).not.toBeNull();
  });

  // The number is the ENGINE's. Nothing on this surface may move it.
  it('does NOT tick between polls — the count only moves when the engine says so', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(CollabPane);
      await post(state({ hopState: { remaining: 14, cap: 20 } }));
      expect(hop(container)!.textContent).toBe('hops 14/20');

      // Half a minute of wall clock, with the pane's own poll timer running.
      await vi.advanceTimersByTimeAsync(30000);
      expect(hop(container)!.textContent).toBe('hops 14/20');

      // ...and it moves the moment a poll answers with a new figure.
      await post(state({ sinceSeq: 0, hopState: { remaining: 13, cap: 20 } }));
      expect(hop(container)!.textContent).toBe('hops 13/20');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CollabHopBar — the controls survived the move', () => {
  it('Set cap keeps the three values apart: blank is the default, 0 is OFF, N is N', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const input = container.querySelector('.cap-input') as HTMLInputElement;
    const apply = container.querySelector('.cap-apply') as HTMLElement;

    await fireEvent.click(apply);
    expect(posts().at(-1)).toEqual({ type: 'collabSetCap', collabId: ID, cap: null });

    await fireEvent.input(input, { target: { value: '0' } });
    await fireEvent.click(apply);
    expect(posts().at(-1)).toEqual({ type: 'collabSetCap', collabId: ID, cap: 0 });

    await fireEvent.input(input, { target: { value: '20' } });
    await fireEvent.click(apply);
    expect(posts().at(-1)).toEqual({ type: 'collabSetCap', collabId: ID, cap: 20 });
  });

  // W5. The dispatch width sits on the same bar as the hop cap because it is
  // the other half of the same question — how much the room may do before it
  // comes back to you. It is NOT the cap: no blank-means-default, no 0-is-off.
  it('the width control sends the number chosen, and 1 is a real choice', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const width = container.querySelector('.width-input') as HTMLInputElement;
    const apply = container.querySelector('.width-apply') as HTMLElement;

    // `toContainEqual`, not `at(-1)`: this mutation re-polls behind itself so a
    // refusal cannot leave the bar showing a width the engine did not take, and
    // the poll is therefore the last message on the wire.
    await fireEvent.input(width, { target: { value: '3' } });
    await fireEvent.click(apply);
    expect(posts()).toContainEqual({ type: 'collabSetConcurrency', collabId: ID, concurrency: 3 });

    await fireEvent.input(width, { target: { value: '1' } });
    await fireEvent.click(apply);
    expect(posts()).toContainEqual({ type: 'collabSetConcurrency', collabId: ID, concurrency: 1 });
  });

  it('draws the width the ENGINE reports, and reads an absent one as serial', async () => {
    const { container } = render(CollabPane);
    await post(state());
    // An engine that predates the field sends nothing. Serial is what a room
    // without the setting has always been, so that is what the bar must say -
    // never a blank where a fact belongs.
    expect((container.querySelector('.width-text') as HTMLElement).textContent).toContain('serial');

    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: null, concurrency: 3 } }));
    expect((container.querySelector('.width-text') as HTMLElement).textContent).toContain('3');
  });

  it('refuses to send a width below 1 rather than clamping it silently', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await fireEvent.input(container.querySelector('.width-input') as HTMLInputElement, { target: { value: '0' } });
    await fireEvent.click(container.querySelector('.width-apply') as HTMLElement);
    expect(posts().filter((p) => p.type === 'collabSetConcurrency')).toEqual([]);
  });

  it('Stop still posts collabStop, and is dead on an archived collab', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await fireEvent.click(container.querySelector('.stop-btn') as HTMLButtonElement);
    expect(posts()).toContainEqual({ type: 'collabStop', collabId: ID });

    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', archivedAt: '2026-08-05T11:00:00.000Z', loopBreakerCap: null } }));
    expect((container.querySelector('.stop-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});

// W7-L2. A COUNCIL round dispatches every member's turn at once, by
// construction — there is no "how many run at once" for the width control to
// answer there, and drawing it anyway is what sent Passing asking what it
// was for. The other half of that same complaint: even where the control DOES
// mean something, it said only "turns: serial 1 [Set width]" with no
// explanation of what it sets or what raising it costs.
describe('CollabHopBar — the width control is meaningless in a COUNCIL', () => {
  it('renders in a DISCUSS room, with a plain-language title explaining it', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const width = container.querySelector('.width-text') as HTMLElement | null;
    expect(width).not.toBeNull();
    const title = width!.title.toLowerCase();
    expect(title).toContain('parallel turns');
    expect(title).toContain('file-read-only');
  });

  it('does not render at all in a COUNCIL room', async () => {
    const { container } = render(CollabPane);
    await post(state({ collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: null, flavor: 'council' } }));
    expect(container.querySelector('.width-text')).toBeNull();
    expect(container.querySelector('.width-input')).toBeNull();
    expect(container.querySelector('.width-apply')).toBeNull();
    // The rest of the bar is still there — hiding the width did not take the
    // cap or Stop with it.
    expect(container.querySelector('.cap-apply')).not.toBeNull();
  });

  it('appears and disappears with the RE-POLLED flavor, never optimistically', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(container.querySelector('.width-apply')).not.toBeNull();

    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: null, flavor: 'council' } }));
    expect(container.querySelector('.width-apply')).toBeNull();

    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: null, flavor: 'discuss' } }));
    expect(container.querySelector('.width-apply')).not.toBeNull();
  });
});

describe('CollabHopBar — the cap explainer is a TOOLTIP, not bar prose', () => {
  // Owner UAT: the inline sentence wrapped into a tall column at sidebar
  // widths. The bar shows the short form; the sentence rides `title`. jsdom
  // has no layout, so what is asserted is the CONTENT split, not the wrap.
  it('shows the short cap label and keeps the full sentence on hover', async () => {
    const { container } = render(CollabPane);
    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: 12 } }));

    const cap = container.querySelector('.cap-text') as HTMLElement;
    expect(cap.textContent).toBe('cap: 12');
    expect(cap.getAttribute('title')).toContain('Loop breaker: 12 agent turns without you');
  });

  it('keeps the three cap states apart at bar width too', async () => {
    const { container } = render(CollabPane);
    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: null } }));
    expect((container.querySelector('.cap-text') as HTMLElement).textContent).toBe('cap: default');

    await post(state({ sinceSeq: 0, collab: { id: ID, title: 'Budget', createdAt: '', loopBreakerCap: 0 } }));
    expect((container.querySelector('.cap-text') as HTMLElement).textContent).toBe('cap: off');
    expect((container.querySelector('.cap-text') as HTMLElement).getAttribute('title')).toContain('OFF');
  });
});
