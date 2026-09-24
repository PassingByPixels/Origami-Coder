// t-ru13hb item 2 — CONFIRM-OR-UNDO ON A CHAT ROW'S ×.
//
// The × posted `closeSession` on the click, with no confirm and no way back: a
// mis-aimed pointer (the × sits two pixels from the rename pencil) closed a
// chat outright. The owner's ruling was the fuse toast rather than a modal —
// the row goes at once, an "Undo" toast runs for the fuse, and the host is
// told ONLY when the fuse burns.
//
// What must be true, and is asserted below:
//   - the click removes the row and posts NOTHING yet;
//   - Undo brings the row back, still with no post;
//   - the fuse burning posts closeSession exactly once.
// The middle one is the whole point: an optimistic post with a later "undo"
// that reopens the session is a different, lossier feature.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import ChatsList from './ChatsList.svelte';
import { CLOSE_FUSE_MS, supersede } from './pendingClose';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
  vi.useRealTimers();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

function posts(): Array<Record<string, unknown>> {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
}

const closes = () => posts().filter((m) => m.type === 'closeSession');

function sessionList(...ids: string[]): unknown {
  return {
    type: 'sessionList',
    sessions: ids.map((id, n) => ({ id, number: n + 1, agentName: 'Tsuru', title: id })),
  };
}

function rowNames(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('.session-row .session-name')).map((n) =>
    (n.textContent ?? '').replace('Tsuru: ', ''),
  );
}

async function mountWith(...ids: string[]): Promise<HTMLElement> {
  const { container } = render(ChatsList, { props: {} });
  await post(sessionList(...ids));
  globalThis.__vscodeApiMock.postMessage.mockClear();
  return container as HTMLElement;
}

const closeButtons = (c: HTMLElement) => Array.from(c.querySelectorAll('.session-close')) as HTMLButtonElement[];
const toast = (c: HTMLElement) => c.querySelector('.og-toast');
const undoBtn = (c: HTMLElement) => c.querySelector('.og-toast-action') as HTMLButtonElement | null;

describe('closing a chat row is undoable', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it('the × takes the row off the list and posts nothing yet', async () => {
    const c = await mountWith('alpha', 'beta');
    await fireEvent.click(closeButtons(c)[0]);
    await tick();
    expect(rowNames(c)).toEqual(['beta']);
    expect(closes(), 'the host must not hear about a close that can still be undone').toHaveLength(0);
    expect(toast(c), 'the way back has to be on screen').not.toBeNull();
  });

  it('Undo brings the row back and still posts nothing', async () => {
    const c = await mountWith('alpha', 'beta');
    await fireEvent.click(closeButtons(c)[0]);
    await tick();
    await fireEvent.click(undoBtn(c)!);
    await tick();
    expect(rowNames(c)).toEqual(['alpha', 'beta']);
    expect(closes()).toHaveLength(0);
    expect(toast(c), 'the toast goes with the undo').toBeNull();
  });

  it('an undone close stays undone once the fuse time has passed', async () => {
    const c = await mountWith('alpha', 'beta');
    await fireEvent.click(closeButtons(c)[0]);
    await tick();
    await fireEvent.click(undoBtn(c)!);
    await tick();
    vi.advanceTimersByTime(CLOSE_FUSE_MS * 3);
    await tick();
    expect(closes(), 'the fuse was defused, not merely hidden').toHaveLength(0);
    expect(rowNames(c)).toEqual(['alpha', 'beta']);
  });

  it('the fuse burning posts closeSession exactly once', async () => {
    const c = await mountWith('alpha', 'beta');
    await fireEvent.click(closeButtons(c)[0]);
    await tick();
    vi.advanceTimersByTime(CLOSE_FUSE_MS);
    await tick();
    expect(closes()).toEqual([{ type: 'closeSession', sessionId: 'alpha' }]);
    vi.advanceTimersByTime(CLOSE_FUSE_MS * 2);
    await tick();
    expect(closes(), 'one fuse, one post').toHaveLength(1);
  });

  it('closing a second row commits the first rather than queueing two toasts', async () => {
    const c = await mountWith('alpha', 'beta', 'gamma');
    await fireEvent.click(closeButtons(c)[0]);
    await tick();
    await fireEvent.click(closeButtons(c)[0]); // 'beta' — 'alpha' is already off the list
    await tick();
    expect(closes()).toEqual([{ type: 'closeSession', sessionId: 'alpha' }]);
    expect(c.querySelectorAll('.og-toast')).toHaveLength(1);
    expect(rowNames(c)).toEqual(['gamma']);
  });
});

describe('the pending-close rule itself', () => {
  it('supersede commits the one already waiting and keeps the new one', () => {
    expect(supersede({ id: 'a', label: 'A' }, { id: 'b', label: 'B' }))
      .toEqual({ commit: 'a', pending: { id: 'b', label: 'B' } });
  });
  it('re-closing the SAME row commits nothing twice', () => {
    expect(supersede({ id: 'a', label: 'A' }, { id: 'a', label: 'A' }).commit).toBeNull();
  });
  it('nothing waiting means nothing to commit', () => {
    expect(supersede(null, { id: 'a', label: 'A' }).commit).toBeNull();
  });

  // MIRROR GUARD (WORKING_ON_ORIGAMI_CODER.md Part 5): the fuse this component
  // times the commit on and the fuse InlineToast.svelte BURNS on screen are two
  // declarations of one number. If they drift, the toast disappears while the
  // close is still pending, or lingers after it has gone through.
  it('CLOSE_FUSE_MS is the duration InlineToast actually burns for', () => {
    const src = readFileSync(
      join(__dirname, '..', 'dashboard', 'components', 'InlineToast.svelte'), 'utf8');
    expect(src).toMatch(new RegExp(`FUSE_MS\\s*=\\s*${CLOSE_FUSE_MS}\\b`));
    expect(src).toMatch(new RegExp(`og-toast-burn\\s+${CLOSE_FUSE_MS}ms`));
  });
});
