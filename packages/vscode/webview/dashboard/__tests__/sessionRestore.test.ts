// sessionRestore.ts unit tests — persist the WHOLE open-set of chat tabs and
// reopen it on restart. Pure planners + a Map-backed fake Memento + a fake
// engine client/host for the async enactor. Asserts observable behaviour:
// persisted ids drive reopen calls, a missing id is skipped (no ghost tab),
// layout + active are restored, and an absent/older-install set falls back.

import { describe, it, expect } from 'vitest';
import type { Memento } from 'vscode';
import {
  computeOpenSet, loadOpenSet, saveOpenSet, isPrematureEmpty, planReopen, restoreOpenSet, type OpenSetState,
} from '../../../src/dashboard/agentManager/sessionRestore';

function fakeMemento(seed: Record<string, unknown> = {}): Memento {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); },
    keys: () => [...m.keys()],
  } as unknown as Memento;
}

type S = { kind?: 'chat' | 'agent'; client?: { currentSessionId?: string | null } | null };
function sess(entries: Array<[string, S]>): Map<string, S> { return new Map(entries); }
function chat(engineId: string | null): S { return { kind: 'chat', client: { currentSessionId: engineId } }; }
function agent(engineId: string | null): S { return { kind: 'agent', client: { currentSessionId: engineId } }; }

describe('computeOpenSet — chat engine ids in tab order, active mapped through', () => {
  it('includes chat sessions with an engine id, in order; excludes agents and un-started chats', () => {
    const sessions = sess([
      ['session-1', chat('eng-A')],
      ['session-2', agent('eng-B')],   // background agent — not a tab
      ['session-3', chat(null)],       // not started yet — no engine id
      ['session-4', chat('eng-C')],
    ]);
    const state = computeOpenSet(sessions, 'session-4', true);
    expect(state.open).toEqual(['eng-A', 'eng-C']);
    expect(state.active).toBe('eng-C');
    expect(state.grid).toBe(true);
  });
  it('an active pointing at an agent / unknown resolves to null active', () => {
    const sessions = sess([['session-1', chat('eng-A')], ['session-2', agent('eng-B')]]);
    expect(computeOpenSet(sessions, 'session-2', false).active).toBeNull();
    expect(computeOpenSet(sessions, 'nope', false).active).toBeNull();
  });
});

describe('loadOpenSet / saveOpenSet round-trip', () => {
  it('save then load returns the persisted open-set', () => {
    const m = fakeMemento();
    saveOpenSet(m, sess([['session-1', chat('eng-A')], ['session-2', chat('eng-B')]]), 'session-2', true);
    expect(loadOpenSet(m)).toEqual({ open: ['eng-A', 'eng-B'], active: 'eng-B', grid: true });
  });
  it('absent or malformed persistence reads as null (older-install fallback)', () => {
    expect(loadOpenSet(fakeMemento())).toBeNull();
    expect(loadOpenSet(fakeMemento({ 'origami.openSessions': { open: 'x', grid: true } }))).toBeNull();
    expect(loadOpenSet(fakeMemento({ 'origami.openSessions': { open: [], grid: 'yes' } }))).toBeNull();
  });
  it('non-string ids are filtered out on load', () => {
    const m = fakeMemento({ 'origami.openSessions': { open: ['eng-A', 3, '', 'eng-B'], active: 'eng-B', grid: false } });
    expect(loadOpenSet(m)).toEqual({ open: ['eng-A', 'eng-B'], active: 'eng-B', grid: false });
  });
});

describe('saveOpenSet / isPrematureEmpty — never clobber a good set with a premature empty one', () => {
  it('isPrematureEmpty: empty projection + a mid-connect chat -> true; only-agents / no-sessions / non-empty -> false', () => {
    expect(isPrematureEmpty([], sess([['session-1', chat(null)]]))).toBe(true);
    expect(isPrematureEmpty([], sess([['session-1', agent('eng-B')]]))).toBe(false);
    expect(isPrematureEmpty([], sess([]))).toBe(false);
    expect(isPrematureEmpty(['eng-A'], sess([['session-1', chat(null)]]))).toBe(false);
  });
  it('skips the write when a chat exists but has no engine id yet (boot mid-connect) — the prior set survives', () => {
    const m = fakeMemento({ 'origami.openSessions': { open: ['eng-A'], active: 'eng-A', grid: false } });
    saveOpenSet(m, sess([['session-1', chat(null)]]), 'session-1', false);
    expect(loadOpenSet(m)).toEqual({ open: ['eng-A'], active: 'eng-A', grid: false });
  });
  it('persists a genuinely empty set when there are no chat tabs (user closed the last one)', () => {
    const m = fakeMemento({ 'origami.openSessions': { open: ['eng-A'], active: 'eng-A', grid: false } });
    saveOpenSet(m, sess([]), null, false);
    expect(loadOpenSet(m)).toEqual({ open: [], active: null, grid: false });
  });
});

describe('planReopen — order preserved, missing skipped, active survival', () => {
  const persisted: OpenSetState = { open: ['eng-A', 'eng-B', 'eng-C'], active: 'eng-B', grid: true };
  it('reopens all persisted ids in order when all exist and none are open', () => {
    const plan = planReopen(persisted, new Set(['eng-A', 'eng-B', 'eng-C']), new Set());
    expect(plan).toEqual({ reopen: ['eng-A', 'eng-B', 'eng-C'], active: 'eng-B', grid: true });
  });
  it('skips an id whose transcript no longer exists (no ghost tab)', () => {
    const plan = planReopen(persisted, new Set(['eng-A', 'eng-C']), new Set());
    expect(plan!.reopen).toEqual(['eng-A', 'eng-C']);
  });
  it('drops the active pointer when the active session itself is missing', () => {
    const plan = planReopen(persisted, new Set(['eng-A', 'eng-C']), new Set());
    expect(plan!.active).toBeNull();
  });
  it('skips ids already open and dedupes repeats', () => {
    const dupd: OpenSetState = { open: ['eng-A', 'eng-A', 'eng-B'], active: null, grid: false };
    const plan = planReopen(dupd, new Set(['eng-A', 'eng-B']), new Set(['eng-A']));
    expect(plan!.reopen).toEqual(['eng-B']);
  });
  it('returns null when nothing is restorable (absent set, or every id now missing)', () => {
    expect(planReopen(null, new Set(['eng-A']), new Set())).toBeNull();
    expect(planReopen({ open: [], active: null, grid: false }, new Set(), new Set())).toBeNull();
    expect(planReopen(persisted, new Set(['gone']), new Set())).toBeNull();
  });
});

describe('restoreOpenSet — the async enactor against a fake client + host', () => {
  function fakeClient(existing: string[]) {
    return { listSessions: async () => existing.map((sessionId) => ({ sessionId })) };
  }
  function host() {
    const reopened: string[] = [];
    const activated: string[] = [];
    let grid: boolean | undefined;
    return {
      reopened, activated, get grid() { return grid; },
      h: {
        reopen: async (engineId: string) => { reopened.push(engineId); return `local-${engineId}`; },
        setGrid: (g: boolean) => { grid = g; },
        activate: (localId: string) => { activated.push(localId); },
      },
    };
  }

  it('reopens the surviving ids in order, restores grid, and activates the active tab by its NEW local id', async () => {
    const persisted: OpenSetState = { open: ['eng-A', 'eng-B'], active: 'eng-B', grid: true };
    const c = host();
    const ok = await restoreOpenSet(persisted, fakeClient(['eng-A', 'eng-B', 'eng-Z']), c.h);
    expect(ok).toBe(true);
    expect(c.reopened).toEqual(['eng-A', 'eng-B']);
    expect(c.grid).toBe(true);
    expect(c.activated).toEqual(['local-eng-B']);
  });

  it('skips a persisted id missing on the engine (no reopen for it), still restores the rest', async () => {
    const persisted: OpenSetState = { open: ['eng-A', 'gone', 'eng-B'], active: 'eng-A', grid: false };
    const c = host();
    const ok = await restoreOpenSet(persisted, fakeClient(['eng-A', 'eng-B']), c.h);
    expect(ok).toBe(true);
    expect(c.reopened).toEqual(['eng-A', 'eng-B']);
    expect(c.activated).toEqual(['local-eng-A']);
  });

  it('returns false (fallback) when every persisted id is missing — nothing reopened or activated', async () => {
    const persisted: OpenSetState = { open: ['x', 'y'], active: 'x', grid: false };
    const c = host();
    const ok = await restoreOpenSet(persisted, fakeClient(['other']), c.h);
    expect(ok).toBe(false);
    expect(c.reopened).toEqual([]);
    expect(c.activated).toEqual([]);
  });

  it('returns false when there is no persisted set, no client, or listSessions throws', async () => {
    const c1 = host();
    expect(await restoreOpenSet(null, fakeClient(['eng-A']), c1.h)).toBe(false);
    const c2 = host();
    expect(await restoreOpenSet({ open: ['eng-A'], active: null, grid: false }, null, c2.h)).toBe(false);
    const throwing = { listSessions: async () => { throw new Error('engine offline'); } };
    const c3 = host();
    expect(await restoreOpenSet({ open: ['eng-A'], active: null, grid: false }, throwing, c3.h)).toBe(false);
    expect(c3.reopened).toEqual([]);
  });
});
