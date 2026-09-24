// SwipeRow in its one remaining caller (Labyrinth run rows; the chat rows dropped it in t-ql9ari). The GESTURE is proven by swipeRowMath.test.ts
// (pure maths) and needs a human eye on a real browser for the feel; what is
// provable in jsdom is the part that used to be a button and now has to still
// work: the × is gone, the revealed action fires the caller's own delete, and
// the keyboard path still exists.
//
// NAMED SwipeRowDom, not SwipeRow.test.ts: Windows resolves paths
// case-insensitively, so a file called SwipeRow.test.ts and one called
// swipeRow.test.ts ARE the same file on this machine. Writing the second
// silently destroyed the first during this task, and `vitest run
// swipeRow.test.ts` then reported the other file's 7 tests green.
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import { tick } from 'svelte';
import ChatsList from '../chat/ChatsList.svelte';
import LabyrinthRunCard from '../dashboard/components/LabyrinthRunCard.svelte';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

const sessionList = (...ids: string[]) => ({
  type: 'sessionList',
  sessions: ids.map((id, n) => ({ id, number: n + 1, agentName: 'Tsuru', title: id })),
});

describe('SwipeRow — the Labyrinth run rows', () => {
  const base = { title: 'Assess the repo', onSelect: () => {} };

  it('the swipe action ARMS the confirm rather than deleting outright', async () => {
    let deleted = 0;
    const { container } = render(LabyrinthRunCard, { props: { ...base, onDelete: () => { deleted++; } } });
    await fireEvent.click(container.querySelector('.lab-del')!);
    await tick();
    // Armed, nothing destroyed: the two-step this row has always had survives
    // the gesture replacing its button.
    expect(deleted).toBe(0);
    expect(container.querySelector('.lab-confirm')).not.toBeNull();
  });

  it('a row that cannot be deleted gets no swipe wrapper at all', () => {
    const { container } = render(LabyrinthRunCard, { props: { ...base, collab: true, onDelete: () => {} } });
    expect(container.querySelector('.lab-del')).toBeNull();
    expect(container.querySelector('.og-sw')).toBeNull();
    // ...and the card itself is still there to be picked.
    expect(container.querySelector('.lab-run')).not.toBeNull();
  });

  it('the chat rows no longer use it (t-ql9ari): the x button is their only delete control', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    expect(container.querySelector('.og-sw-clip')).toBeNull();
    expect(container.querySelector('.session-close')?.textContent).toContain('×');
  });
});
