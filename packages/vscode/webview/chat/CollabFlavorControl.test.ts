// W5-L2 — the room's FLAVOR control, driven through the real pane so the poll
// is the thing that moves it.
//
// Two facts are worth a render, and neither is provable in a leaf:
//
//   1. IT NEVER ASSERTS THE NEW FLAVOR LOCALLY. Becoming a council is GATED
//      engine-side on every member being read-only for files, so a control that
//      flipped itself on click would show a council the engine refused to make.
//      The line only moves when a poll says it did.
//   2. IT SITS ON THE HOP BAR, beside the cap and the width, because all three
//      answer "how much may this room do before it comes back to me".

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { tick } from 'svelte';
import CollabPane from './CollabPane.svelte';

const ID = 'collab-flavor';

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
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

const state = (collab: Record<string, unknown> = {}) => ({
  type: 'collabStateData',
  collabId: ID,
  sinceSeq: 0,
  collab: { id: ID, title: 'Council', createdAt: '', loopBreakerCap: null, ...collab },
  participants: [],
  messages: [],
  agents: [],
  suspended: false,
});

const line = (c: HTMLElement) => (c.querySelector('.fl-text') as HTMLElement | null)?.textContent ?? '';
const button = (c: HTMLElement) => c.querySelector('.fl-apply') as HTMLButtonElement;

describe('CollabFlavorControl', () => {
  it('says a room with no flavor is a DISCUSSION, never a blank where a fact belongs', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(line(container)).toContain('discuss');
    // The button says what pressing it DOES, which is the one thing a two-state
    // control can say that its label cannot.
    expect(button(container).textContent).toContain('Make it a council');
  });

  it('sends the flavor the button offers, and does NOT flip itself', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await fireEvent.click(button(container));

    const sent = posts().find((p) => p.type === 'collabSetFlavor');
    expect(sent).toMatchObject({ type: 'collabSetFlavor', collabId: ID, flavor: 'council' });
    // The engine can refuse this. Until a poll says otherwise the room is still
    // a discussion, and the control still says so.
    await tick();
    expect(line(container)).toContain('discuss');
    expect(button(container).textContent).toContain('Make it a council');
  });

  it('re-polls, so a refusal comes back as the flavor that actually stuck', async () => {
    const { container } = render(CollabPane);
    await post(state());
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(button(container));
    expect(posts().some((p) => p.type === 'collabPoll' && p.collabId === ID)).toBe(true);
  });

  it('draws a COUNCIL as a council once the engine says it is one', async () => {
    const { container } = render(CollabPane);
    await post(state({ flavor: 'council' }));
    expect(line(container)).toContain('council');
    // ...and the button now offers the way back, which is never gated.
    expect(button(container).textContent).toContain('Make it a discussion');
    await fireEvent.click(button(container));
    expect(posts().find((p) => p.type === 'collabSetFlavor')).toMatchObject({ flavor: 'discuss' });
  });

  it('is on the hop bar, beside the cap and the width', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const bar = container.querySelector('.cap-row') as HTMLElement;
    expect(bar.querySelector('.fl-apply')).not.toBeNull();
    expect(bar.querySelector('.width-apply')).not.toBeNull();
  });

  it('is dead on an ARCHIVED room, which cannot be deliberating', async () => {
    const { container } = render(CollabPane);
    await post(state({ archivedAt: new Date(1).toISOString() }));
    expect(button(container).disabled).toBe(true);
  });
});
