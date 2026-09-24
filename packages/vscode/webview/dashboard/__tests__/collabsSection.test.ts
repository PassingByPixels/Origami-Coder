// collabsSection — the sidebar's Collabs half: its dragged height (moved out of
// DashboardPanel.ts verbatim) and its new collapsed flag.
//
// The two behaviour claims worth pinning are both about what SURVIVES a reload:
// a collapse the user chose must come back collapsed, and — the trap the height
// half already carried — a non-positive height must never be stored, because a
// 0 would erase the split the user dragged to and read back as "default".
//
// The move out of the panel is covered by the height cases still passing here
// with the SAME key the panel used: change the key and a workspace loses the
// height it had already dragged to.

import { describe, it, expect } from 'vitest';
import type { Memento } from 'vscode';
import {
  COLLABS_SECTION_MESSAGE_TYPES,
  COLLABS_HEIGHT_KEY,
  COLLABS_OPEN_KEY,
  handleCollabsSectionMessage,
  usableHeight,
  type CollabsSectionHost,
} from '../../../src/dashboard/collabsSection';

function fakeMemento(seed: Record<string, unknown> = {}): Memento {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => { if (v === undefined) m.delete(k); else m.set(k, v); return Promise.resolve(); },
    keys: () => [...m.keys()],
  } as unknown as Memento;
}
interface FakeHost extends CollabsSectionHost { posts: Array<Record<string, unknown>> }
function fakeHost(memento: Memento): FakeHost {
  const posts: Array<Record<string, unknown>> = [];
  return { posts, post: (msg) => posts.push(msg), workspaceState: () => memento };
}
const last = (h: FakeHost) => h.posts[h.posts.length - 1]!;

describe('COLLABS_SECTION_MESSAGE_TYPES — the three messages this leaf owns', () => {
  it('names every case handled below, nothing else', () => {
    expect([...COLLABS_SECTION_MESSAGE_TYPES].sort()).toEqual([
      'requestCollabsHeight', 'resizeCollabsSection', 'setCollabsCollapsed',
    ]);
  });

  // The panel used to hold these two cases inline. The KEY is what a workspace
  // that already dragged its divider has stored, so the move must not rename it.
  it('keeps the height key the panel wrote, so a dragged split survives the move', () => {
    expect(COLLABS_HEIGHT_KEY).toBe('origami.collabsSectionHeight');
  });
});

describe('the collapsed flag survives a reload', () => {
  it('round-trips: collapse, then a fresh mount handshake answers collapsed', () => {
    const memento = fakeMemento();
    handleCollabsSectionMessage(fakeHost(memento), { type: 'setCollabsCollapsed', collapsed: true });

    // A brand-new webview asking on mount — the only thing carried over is the store.
    const remount = fakeHost(memento);
    handleCollabsSectionMessage(remount, { type: 'requestCollabsHeight' });
    expect(last(remount)).toMatchObject({ type: 'collabsHeight', collapsed: true });
  });

  // t-qhzy4k — the default is CLOSED now: the Collabs block must not be on the
  // screen of anyone who never asked for it.
  it('defaults to CLOSED when nothing was ever stored', () => {
    const host = fakeHost(fakeMemento());
    handleCollabsSectionMessage(host, { type: 'requestCollabsHeight' });
    expect(last(host)).toEqual({ type: 'collabsHeight', heightPx: null, collapsed: true });
  });

  it('collapsing CLEARS the key rather than storing the default as a choice', () => {
    const memento = fakeMemento({ [COLLABS_OPEN_KEY]: true });
    handleCollabsSectionMessage(fakeHost(memento), { type: 'setCollabsCollapsed', collapsed: true });

    expect(memento.keys()).not.toContain(COLLABS_OPEN_KEY);
    const remount = fakeHost(memento);
    handleCollabsSectionMessage(remount, { type: 'requestCollabsHeight' });
    expect(last(remount)).toMatchObject({ collapsed: true });
  });

  it('an OPENED section survives a reload', () => {
    const memento = fakeMemento();
    handleCollabsSectionMessage(fakeHost(memento), { type: 'setCollabsCollapsed', collapsed: false });
    const remount = fakeHost(memento);
    handleCollabsSectionMessage(remount, { type: 'requestCollabsHeight' });
    expect(last(remount)).toMatchObject({ collapsed: false });
  });

  it('a collapse does NOT disturb the dragged height, so re-opening restores it', () => {
    const memento = fakeMemento({ [COLLABS_HEIGHT_KEY]: 180 });
    const host = fakeHost(memento);
    handleCollabsSectionMessage(host, { type: 'setCollabsCollapsed', collapsed: true });
    expect(last(host)).toEqual({ type: 'collabsHeight', heightPx: 180, collapsed: true });
  });
});

describe('the dragged height — the cases moved out of DashboardPanel', () => {
  it('stores a dragged height, rounded, and echoes what was stored', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleCollabsSectionMessage(host, { type: 'resizeCollabsSection', heightPx: 212.6 });

    expect(memento.get(COLLABS_HEIGHT_KEY)).toBe(213);
    // collapsed:true is the default echo since t-qhzy4k — a drag stores the
    // height without deciding whether the section is open.
    expect(last(host)).toEqual({ type: 'collabsHeight', heightPx: 213, collapsed: true });
  });

  it('a non-positive or unusable height is CLEARED, never stored as a size', () => {
    for (const heightPx of [0, -40, Number.NaN, 'tall', null]) {
      const memento = fakeMemento({ [COLLABS_HEIGHT_KEY]: 180 });
      const host = fakeHost(memento);
      handleCollabsSectionMessage(host, { type: 'resizeCollabsSection', heightPx });
      expect(memento.keys()).not.toContain(COLLABS_HEIGHT_KEY);
      expect(last(host)).toMatchObject({ heightPx: null });
    }
  });

  it('usableHeight is the one rule both the read and the write go through', () => {
    expect(usableHeight(212.6)).toBe(213);
    expect(usableHeight(0)).toBeNull();
    expect(usableHeight(Number.POSITIVE_INFINITY)).toBeNull();
    expect(usableHeight(undefined)).toBeNull();
  });

  it('ignores a message it does not own', () => {
    const host = fakeHost(fakeMemento());
    handleCollabsSectionMessage(host, { type: 'setChatSection', section: 'sec1' });
    expect(host.posts).toEqual([]);
  });
});
