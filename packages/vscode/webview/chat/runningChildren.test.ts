// Pure-logic tests for runningChildren.ts — the row-array reducers behind
// the sidebar ring's 4th state (sessionRowState.ts's `subagentsRunning`).
import { describe, expect, it } from 'vitest';
import { trackSpawnedChild, clearDoneChild } from './runningChildren';

function row(id: string, children: string[] = []) {
  return { id, runningChildren: new Set(children) };
}

describe('trackSpawnedChild', () => {
  it('tracks a BACKGROUND task spawn against its parent session', () => {
    const rows = trackSpawnedChild([row('s1')], { sessionId: 's1', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    expect(rows[0].runningChildren.has('child-a')).toBe(true);
  });

  it('ignores a FOREGROUND task — it never enters the set', () => {
    const rows = trackSpawnedChild([row('s1')], { sessionId: 's1', toolName: 'task', taskBackground: false, taskSessionId: 'child-a' });
    expect(rows[0].runningChildren.size).toBe(0);
  });

  it('ignores a toolResult for an unrelated tool', () => {
    const rows = trackSpawnedChild([row('s1')], { sessionId: 's1', toolName: 'read_file', taskBackground: true, taskSessionId: 'child-a' });
    expect(rows[0].runningChildren.size).toBe(0);
  });

  it('leaves an unrelated session untouched', () => {
    const rows = trackSpawnedChild([row('s1'), row('s2')], { sessionId: 's2', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    expect(rows[0].runningChildren.size).toBe(0);
    expect(rows[1].runningChildren.has('child-a')).toBe(true);
  });

  it('re-seeing the same spawn is a no-op — same Set reference back on the untouched rows', () => {
    const seeded = trackSpawnedChild([row('s1')], { sessionId: 's1', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    const again = trackSpawnedChild(seeded, { sessionId: 's1', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    expect(again[0]).toBe(seeded[0]);
  });
});

describe('clearDoneChild', () => {
  it('retires a tracked child on the terminal marker', () => {
    const seeded = trackSpawnedChild([row('s1')], { sessionId: 's1', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    const done = clearDoneChild(seeded, { sessionId: 's1', taskSessionId: 'child-a' });
    expect(done[0].runningChildren.has('child-a')).toBe(false);
  });

  it('a marker for a child nobody is tracking is a no-op', () => {
    const rows = [row('s1')];
    expect(clearDoneChild(rows, { sessionId: 's1', taskSessionId: 'ghost' })[0]).toBe(rows[0]);
  });

  it('a second sibling child stays tracked when the first finishes', () => {
    let rows = trackSpawnedChild([row('s1')], { sessionId: 's1', toolName: 'task', taskBackground: true, taskSessionId: 'a' });
    rows = trackSpawnedChild(rows, { sessionId: 's1', toolName: 'task', taskBackground: true, taskSessionId: 'b' });
    rows = clearDoneChild(rows, { sessionId: 's1', taskSessionId: 'a' });
    expect(rows[0].runningChildren.has('a')).toBe(false);
    expect(rows[0].runningChildren.has('b')).toBe(true);
  });
});
