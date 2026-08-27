// loopPersistence.ts unit tests — persist active /loop schedules across a VS
// Code window reload, keyed by engine session id. Pure functions + a
// Map-backed fake Memento (same fake as sessionRestore.test.ts). Asserts
// observable behaviour: a saved loop round-trips, malformed data is dropped
// rather than thrown, stopping actually clears the record (no resurrection
// on a later load), and re-arming NEVER fires a loop's prompt immediately —
// only schedules its next tick a full interval out.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Memento } from 'vscode';
import {
  loadPersistedLoops, savePersistedLoop, removePersistedLoop, splitPersistedLoops, armRestoredLoops,
  isPersistent, setPersistedLoopPersistence,
  type PersistedLoop,
} from '../../../src/dashboard/agentManager/loopPersistence';

function fakeMemento(seed: Record<string, unknown> = {}): Memento {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); },
    keys: () => [...m.keys()],
  } as unknown as Memento;
}

const loop = (over: Partial<PersistedLoop> = {}): PersistedLoop => ({
  sessionId: 'eng-A', intervalMs: 1_800_000, prompt: 'check for newly failing tests', runs: 0, createdAt: 1000, ...over,
});

describe('loadPersistedLoops / savePersistedLoop round-trip', () => {
  it('save then load returns the persisted loop', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop());
    expect(loadPersistedLoops(m)).toEqual([loop()]);
  });

  it('an absent key reads as an empty list', () => {
    expect(loadPersistedLoops(fakeMemento())).toEqual([]);
  });

  it('malformed entries are dropped, not thrown', () => {
    const m = fakeMemento({
      'origami.loopSchedules': [
        loop({ sessionId: 'eng-A' }),
        { sessionId: 'eng-B' }, // missing everything else
        null,
        'not an object',
        { sessionId: '', intervalMs: 1000, prompt: 'x', runs: 0, createdAt: 1 }, // empty id
      ],
    });
    expect(loadPersistedLoops(m)).toEqual([loop({ sessionId: 'eng-A' })]);
  });

  it('a non-array stored value reads as empty (older install / corrupt write)', () => {
    expect(loadPersistedLoops(fakeMemento({ 'origami.loopSchedules': { open: 'x' } }))).toEqual([]);
  });

  it('saving a second loop for a DIFFERENT session keeps both', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ sessionId: 'eng-A' }));
    savePersistedLoop(m, loop({ sessionId: 'eng-B', prompt: 'watch CI' }));
    expect(loadPersistedLoops(m).map((l) => l.sessionId).sort()).toEqual(['eng-A', 'eng-B']);
  });

  it('saving again for the SAME session upserts (a tick updating `runs`), not duplicates', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ runs: 0 }));
    savePersistedLoop(m, loop({ runs: 1 }));
    savePersistedLoop(m, loop({ runs: 2 }));
    const all = loadPersistedLoops(m);
    expect(all.length).toBe(1);
    expect(all[0].runs).toBe(2);
  });
});

describe('removePersistedLoop — the one path stopLoopSchedule uses for BOTH /loop stop and the Loops-pane cancel', () => {
  it('cancelling removes it from persistence — a subsequent load does not resurrect it', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop());
    expect(loadPersistedLoops(m)).toHaveLength(1);

    removePersistedLoop(m, 'eng-A');
    expect(loadPersistedLoops(m)).toEqual([]);
    // Load again (simulating a later reload reading the same storage) — still gone.
    expect(loadPersistedLoops(m)).toEqual([]);
  });

  it('removing a session with no persisted loop is a safe no-op', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ sessionId: 'eng-A' }));
    removePersistedLoop(m, 'eng-nonexistent');
    expect(loadPersistedLoops(m).map((l) => l.sessionId)).toEqual(['eng-A']);
  });

  it('removing only affects the matching session, leaving siblings intact', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ sessionId: 'eng-A' }));
    savePersistedLoop(m, loop({ sessionId: 'eng-B' }));
    removePersistedLoop(m, 'eng-A');
    expect(loadPersistedLoops(m).map((l) => l.sessionId)).toEqual(['eng-B']);
  });
});

describe('splitPersistedLoops — live vs needs-attention', () => {
  it('a loop whose engine id is in the live set goes to rearm; otherwise needsAttention', () => {
    const loops = [loop({ sessionId: 'eng-A' }), loop({ sessionId: 'eng-B' })];
    const { rearm, needsAttention } = splitPersistedLoops(loops, new Set(['eng-A']));
    expect(rearm.map((l) => l.sessionId)).toEqual(['eng-A']);
    expect(needsAttention.map((l) => l.sessionId)).toEqual(['eng-B']);
  });

  it('an empty live set sends everything to needsAttention — nothing dropped, nothing re-pointed', () => {
    const loops = [loop({ sessionId: 'eng-A' }), loop({ sessionId: 'eng-B' })];
    const { rearm, needsAttention } = splitPersistedLoops(loops, new Set());
    expect(rearm).toEqual([]);
    expect(needsAttention).toEqual(loops);
  });

  it('every id live sends everything to rearm', () => {
    const loops = [loop({ sessionId: 'eng-A' }), loop({ sessionId: 'eng-B' })];
    const { rearm, needsAttention } = splitPersistedLoops(loops, new Set(['eng-A', 'eng-B']));
    expect(rearm).toEqual(loops);
    expect(needsAttention).toEqual([]);
  });
});

describe('armRestoredLoops — a session that could not be restored is surfaced, never dropped or re-pointed', () => {
  it('calls host.arm for a loop whose session came back, with the persisted data intact (runs preserved)', () => {
    const arm = vi.fn();
    const loops = [loop({ sessionId: 'eng-A', runs: 12, prompt: 'triage backlog' })];
    const { rearmed, needsAttention } = armRestoredLoops(loops, new Map([['eng-A', 'session-3']]), { arm });

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith('session-3', loops[0]);
    expect(rearmed).toEqual(loops);
    expect(needsAttention).toEqual([]);
  });

  it('does NOT call host.arm for a loop whose session did not come back — it is reported in needsAttention instead', () => {
    const arm = vi.fn();
    const orphan = loop({ sessionId: 'eng-orphan', prompt: 'poll the deploy', runs: 7 });
    const { rearmed, needsAttention } = armRestoredLoops([orphan], new Map(), { arm });

    expect(arm).not.toHaveBeenCalled();
    expect(rearmed).toEqual([]);
    // Untouched: same prompt/runs/interval, never re-pointed at a substitute session.
    expect(needsAttention).toEqual([orphan]);
  });

  it('a mix: the live one is armed, the orphan is left alone, in persisted order', () => {
    const arm = vi.fn();
    const live = loop({ sessionId: 'eng-live' });
    const orphan = loop({ sessionId: 'eng-orphan' });
    const { rearmed, needsAttention } = armRestoredLoops([live, orphan], new Map([['eng-live', 'session-1']]), { arm });

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith('session-1', live);
    expect(rearmed).toEqual([live]);
    expect(needsAttention).toEqual([orphan]);
  });
});

describe('armRestoredLoops — re-arm timing, driven through the EXACT host.arm contract DashboardPanel implements', () => {
  // DashboardPanel's real `arm` callback does exactly this: install the
  // schedule, then setTimeout(..., loop.intervalMs) for the NEXT tick — it
  // must never invoke the tick function synchronously/immediately. This test
  // drives that same shape (a fake `arm` that schedules via a real timer) to
  // prove the contract end to end, not just by code inspection.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a re-armed loop does not fire before a full interval elapses, even though it "should" have already fired while the window was closed', () => {
    const tick = vi.fn();
    const persisted = loop({ sessionId: 'eng-A', intervalMs: 60_000 });
    armRestoredLoops([persisted], new Map([['eng-A', 'session-1']]), {
      arm: (localId, l) => { setTimeout(() => tick(localId), l.intervalMs); },
    });

    // The loop's interval elapsed entirely while the window was closed — a
    // buggy implementation that fires immediately on rearm would have
    // called tick() already. It must not have.
    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_999);
    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith('session-1');
  });

  it('a needs-attention loop schedules nothing at all — no timer, no eventual fire', () => {
    const tick = vi.fn();
    armRestoredLoops([loop({ sessionId: 'eng-orphan', intervalMs: 1_000 })], new Map(), {
      arm: (localId, l) => { setTimeout(() => tick(localId), l.intervalMs); },
    });
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('persistent loops — the flag that lets a loop outlive its chat', () => {
  it('a record persisted BEFORE the flag existed loads fine and is NOT persistent', () => {
    // The upgrade case: every loop already in someone's workspaceState was
    // written without this field. Rejecting those as malformed would silently
    // cancel running loops on upgrade; defaulting them to persistent would
    // silently promote them into loops that survive their chat. Neither is OK.
    const legacy = { sessionId: 'eng-old', intervalMs: 60_000, prompt: 'poll', runs: 4, createdAt: 1 };
    const m = fakeMemento({ 'origami.loopSchedules': [legacy] });
    const loaded = loadPersistedLoops(m);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sessionId).toBe('eng-old');
    expect(isPersistent(loaded[0])).toBe(false);
  });

  it('a present-but-wrong-typed persistent field IS malformed and is dropped', () => {
    const m = fakeMemento({ 'origami.loopSchedules': [{ ...loop(), persistent: 'yes' }] });
    expect(loadPersistedLoops(m)).toEqual([]);
  });

  it('the flag round-trips through save/load', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ persistent: true }));
    expect(isPersistent(loadPersistedLoops(m)[0])).toBe(true);
  });

  it('setPersistedLoopPersistence flips one loop and leaves its siblings alone', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ sessionId: 'eng-A' }));
    savePersistedLoop(m, loop({ sessionId: 'eng-B' }));
    setPersistedLoopPersistence(m, 'eng-A', true);
    const byId = Object.fromEntries(loadPersistedLoops(m).map((l) => [l.sessionId, l]));
    expect(isPersistent(byId['eng-A'])).toBe(true);
    expect(isPersistent(byId['eng-B'])).toBe(false);
  });

  it('setPersistedLoopPersistence on an unknown id writes nothing at all', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop());
    setPersistedLoopPersistence(m, 'eng-nope', true);
    expect(loadPersistedLoops(m)).toEqual([loop()]);
  });

  it('turning persistence back OFF sticks', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ persistent: true }));
    setPersistedLoopPersistence(m, 'eng-A', false);
    expect(isPersistent(loadPersistedLoops(m)[0])).toBe(false);
  });
});

describe('armRestoredLoops — a loop with no live chat splits by INTENT', () => {
  const noHost = { arm: () => {} };

  it('a PERSISTENT loop whose chat did not come back goes to recall, not needs-attention', () => {
    const out = armRestoredLoops([loop({ sessionId: 'eng-gone', persistent: true })], new Map(), noHost);
    expect(out.recall.map((l) => l.sessionId)).toEqual(['eng-gone']);
    expect(out.needsAttention).toEqual([]);
  });

  it('a PLAIN loop whose chat did not come back keeps the old contract exactly', () => {
    const out = armRestoredLoops([loop({ sessionId: 'eng-gone' })], new Map(), noHost);
    expect(out.needsAttention.map((l) => l.sessionId)).toEqual(['eng-gone']);
    expect(out.recall).toEqual([]);
  });

  it('a persistent loop whose chat DID come back is armed normally — never recalled twice', () => {
    // The bug: recalling a loop that already has a live chat, giving one engine
    // session two clients racing each other's prompts.
    const armed: string[] = [];
    const out = armRestoredLoops(
      [loop({ sessionId: 'eng-A', persistent: true })],
      new Map([['eng-A', 'session-3']]),
      { arm: (localId) => armed.push(localId) },
    );
    expect(armed).toEqual(['session-3']);
    expect(out.recall).toEqual([]);
    expect(out.needsAttention).toEqual([]);
  });

  it('a mixed set routes every loop to exactly one bucket', () => {
    const out = armRestoredLoops(
      [
        loop({ sessionId: 'live', persistent: true }),
        loop({ sessionId: 'gone-persistent', persistent: true }),
        loop({ sessionId: 'gone-plain' }),
      ],
      new Map([['live', 'session-1']]),
      noHost,
    );
    expect(out.rearmed.map((l) => l.sessionId)).toEqual(['live']);
    expect(out.recall.map((l) => l.sessionId)).toEqual(['gone-persistent']);
    expect(out.needsAttention.map((l) => l.sessionId)).toEqual(['gone-plain']);
  });

  it('recall does not touch storage — the record survives for a failed recall to fall back on', () => {
    const m = fakeMemento();
    savePersistedLoop(m, loop({ sessionId: 'eng-gone', persistent: true }));
    armRestoredLoops(loadPersistedLoops(m), new Map(), noHost);
    expect(loadPersistedLoops(m)).toHaveLength(1);
  });
});
