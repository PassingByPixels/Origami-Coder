// sessionOrder.ts unit tests — the host side of sidebar drag-to-reorder.
//
// These assert the property the feature actually depends on: the sessions map is
// the ONLY record of chat order (requestSessions projects it; the open-set
// persists it as "tab order"), so a rank that drops or invents an entry silently
// loses a user's chat or resurrects a closed one. Each case below is a way the
// webview's order can disagree with the live map by the time it arrives.

import { describe, it, expect } from 'vitest';
import { rankEntries } from '../../../src/dashboard/agentManager/sessionOrder';
import { computeOpenSet, saveOpenSet, loadOpenSet } from '../../../src/dashboard/agentManager/sessionRestore';
import type { Memento } from 'vscode';

type S = { kind?: 'chat' | 'agent'; client?: { currentSessionId?: string | null } | null };
function chat(engineId: string): S { return { kind: 'chat', client: { currentSessionId: engineId } }; }

function fakeMemento(seed: Record<string, unknown> = {}): Memento {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); },
    keys: () => [...m.keys()],
  } as unknown as Memento;
}

describe('rankEntries — applying a dragged order to the live sessions map', () => {
  const live = (): Map<string, string> => new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]);

  it('reorders to exactly the requested order when it names every live id', () => {
    expect(rankEntries(live(), ['c', 'a', 'b'])).toEqual([['c', 'C'], ['a', 'A'], ['b', 'B']]);
  });

  it('keeps a session the order never named — a chat opened mid-drag is not lost', () => {
    // The webview drew its list before 'c' existed, so it can only speak for a+b.
    const ranked = rankEntries(live(), ['b', 'a']);
    expect(ranked).toEqual([['b', 'B'], ['a', 'A'], ['c', 'C']]);
    expect(ranked!.map(([id]) => id)).toContain('c');
  });

  it('ignores an id that is no longer live — a chat closed mid-drag is not resurrected', () => {
    expect(rankEntries(live(), ['b', 'gone', 'a', 'c'])).toEqual([['b', 'B'], ['a', 'A'], ['c', 'C']]);
  });

  it('a repeated id is placed once, at its first mention — never duplicated', () => {
    const ranked = rankEntries(live(), ['c', 'a', 'c', 'b']);
    expect(ranked).toEqual([['c', 'C'], ['a', 'A'], ['b', 'B']]);
    expect(ranked!.filter(([id]) => id === 'c')).toHaveLength(1);
  });

  it('never changes the SET of sessions, whatever the order says', () => {
    for (const order of [[], ['a'], ['c', 'c', 'c'], ['x', 'y'], ['b', 'a', 'c'], ['c', 'x', 'b', 'a']]) {
      const ranked = rankEntries(live(), order);
      const ids = (ranked ?? [...live()]).map(([id]) => id);
      expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    }
  });

  it('returns null when the order names nothing live — the map is left alone, not reshuffled', () => {
    expect(rankEntries(live(), [])).toBeNull();
    expect(rankEntries(live(), ['x', 'y'])).toBeNull();
    expect(rankEntries(new Map(), ['a'])).toBeNull();
  });

  it('an empty live map yields null rather than an empty rebuild', () => {
    expect(rankEntries(new Map<string, string>(), [])).toBeNull();
  });
});

describe('rankEntries + the open set — a reorder is what actually gets persisted', () => {
  // The panel rebuilds its map from the rank and then calls saveOpen(). This is
  // the join that makes a drag survive a restart: if the rank did not feed the
  // open-set projection, the sidebar would reorder and the next window would not.
  it('the persisted tab order follows the drag, not the original insertion order', () => {
    const sessions = new Map<string, S>([
      ['session-1', chat('eng-A')],
      ['session-2', chat('eng-B')],
      ['session-3', chat('eng-C')],
    ]);
    expect(computeOpenSet(sessions, null, false).open).toEqual(['eng-A', 'eng-B', 'eng-C']);

    const ranked = rankEntries(sessions, ['session-3', 'session-1', 'session-2']);
    const rebuilt = new Map<string, S>(ranked!);

    const m = fakeMemento();
    saveOpenSet(m, rebuilt, 'session-1', false);
    expect(loadOpenSet(m)).toEqual({ open: ['eng-C', 'eng-A', 'eng-B'], active: 'eng-A', grid: false });
  });

  it('rebuilding in place preserves each session object identity (the client is not re-created)', () => {
    const a = chat('eng-A');
    const b = chat('eng-B');
    const ranked = rankEntries(new Map<string, S>([['s1', a], ['s2', b]]), ['s2', 's1']);
    expect(ranked![0][1]).toBe(b);
    expect(ranked![1][1]).toBe(a);
  });
});
