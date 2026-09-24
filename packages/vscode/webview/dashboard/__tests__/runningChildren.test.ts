// Pure-logic tests for src/dashboard/runningChildren.ts — the HOST half of
// the sidebar ring's 4th state ("sub-agents running"). Imports the real src
// module directly, the same precedent acpTaskMeta.test.ts already uses for
// testing src/ code from under webview/dashboard/__tests__.
import { describe, expect, it } from 'vitest';
import { recordSpawn } from '../../../src/dashboard/runningChildren';

describe('recordSpawn', () => {
  it('tracks a BACKGROUND task spawn', () => {
    const children = new Set<string>();
    recordSpawn(children, { toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    expect(children.has('child-a')).toBe(true);
  });

  it('ignores a FOREGROUND task', () => {
    const children = new Set<string>();
    recordSpawn(children, { toolName: 'task', taskBackground: false, taskSessionId: 'child-a' });
    expect(children.size).toBe(0);
  });

  it('ignores a toolResult for an unrelated tool', () => {
    const children = new Set<string>();
    recordSpawn(children, { toolName: 'write_file', taskBackground: true, taskSessionId: 'child-a' });
    expect(children.size).toBe(0);
  });

  it('ignores a spawn missing its child session id', () => {
    const children = new Set<string>();
    recordSpawn(children, { toolName: 'task', taskBackground: true });
    expect(children.size).toBe(0);
  });

  it('re-recording the same child (every update to its launcher card) stays a single entry', () => {
    const children = new Set<string>();
    recordSpawn(children, { toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    recordSpawn(children, { toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    expect(children.size).toBe(1);
  });
});
