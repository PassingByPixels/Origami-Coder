// Crane reuse guard — the brand crane is the shared CraneMark component,
// used in BOTH the ChatView header AND the ChatPane empty state. This mounts
// ChatView in its SOLO (popped-out editor tab) mode — the only mode that puts
// both surfaces in one DOM (the plain sidebar renders SidebarLauncher, whose
// threads live in their own solo tabs) — and asserts BOTH cranes are present,
// which can only hold if CraneMark is wired into both surfaces (not inlined in
// one and missing from the other). It also pins the header crane to the small
// size and the empty-state crane to the large size.

import { render } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import ChatView from './ChatView.svelte';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

afterEach(() => {
  delete (window as unknown as { __ORIGAMI_SOLO_SESSION__?: string }).__ORIGAMI_SOLO_SESSION__;
});

describe('ChatView — shared CraneMark in header + empty state', () => {
  it('mounts two cranes (header + empty-state) at their respective sizes', async () => {
    // Solo mode: ChatView reads its dedicated session id from this global in
    // onMount, then renders the brand header (crane 18) + the ChatPane for that
    // one session (empty-state crane 112 until the first turn).
    (window as unknown as { __ORIGAMI_SOLO_SESSION__?: string }).__ORIGAMI_SOLO_SESSION__ = SID;
    const { container } = render(ChatView);
    // ChatPane needs the session replayed before it renders the cell + empty state.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'sessionCreated',
          sessionId: SID,
          sessionNumber: 1,
          agentName: 'Coder',
          agentArt: null,
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // Every crane is a CraneMark instance: an aria-hidden <svg> on the
    // 64-unit viewBox. The header (18) + the empty state (112) → exactly two.
    const cranes = Array.from(
      container.querySelectorAll('svg[viewBox="0 0 64 64"]'),
    ) as SVGElement[];
    expect(cranes).toHaveLength(2);
    for (const c of cranes) {
      expect(c.getAttribute('aria-hidden')).toBe('true');
    }

    const sizes = cranes
      .map((c) => Number(c.getAttribute('width')))
      .sort((a, b) => a - b);
    // The small header crane and the large empty-state crane. 56 -> 112 with
    // ChatEmptyState.svelte's own bump — and this assertion is the END-TO-END
    // proof of it: the size is read off a crane that reached the DOM through
    // ChatView -> ChatPane -> ChatEmptyState, not off the component in isolation.
    expect(sizes).toEqual([18, 112]);
  });
});
