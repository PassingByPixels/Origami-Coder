// subagentChanges — t-j3qxbp: does the chat pane's changed-files pill see a
// SUB-AGENT's own edits? It did not: aggregateSessionChanges only walked the
// parent's own `messages`, and a child's tool calls never land there (the
// engine degrades a forwarded child tool part to a text line, same problem
// subagentTodos.ts already solved for todos). Same fix shape: the forwarded
// line is a SIGNAL, the host pulls the child's own stored session, and the
// webview folds the child's raw diffs into the same pill.

import { describe, expect, it, vi } from 'vitest';
import { makeSubagentChangesPuller, saysEditTool, subagentFileDiffs } from '../../../src/dashboard/subagentChanges';
import type { SessionMessage } from '../../../src/dashboard/sessionLog';

const toolEntry = (status: string, diff: { path: string; oldText: string; newText: string } | undefined): SessionMessage => ({
  kind: 'tool',
  text: 'edit',
  timestamp: 0,
  tool: { call: { toolCallId: 'tc' }, result: { toolCallId: 'tc', status, diff } } as SessionMessage['tool'],
});

describe('saysEditTool — recognising a forwarded child tool line', () => {
  it('matches the edit-class tool names', () => {
    expect(saysEditTool('> edit: src/a.ts')).toBe(true);
    expect(saysEditTool('> multi_edit: src/a.ts')).toBe(true);
    expect(saysEditTool('> write: src/new.ts')).toBe(true);
  });
  it('does not match a read/grep/bash line', () => {
    expect(saysEditTool('> read: src/a.ts')).toBe(false);
    expect(saysEditTool('> bash: ls')).toBe(false);
  });
});

describe('subagentFileDiffs — extracting the child\'s own before/after pairs', () => {
  it('reads the diff off a completed tool entry', () => {
    const entries = [toolEntry('completed', { path: '/w/src/a.ts', oldText: 'a', newText: 'b' })];
    expect(subagentFileDiffs(entries)).toEqual([{ path: '/w/src/a.ts', oldText: 'a', newText: 'b' }]);
  });
  it('skips a failed call (nothing actually changed)', () => {
    const entries = [toolEntry('failed', { path: '/w/src/a.ts', oldText: 'a', newText: 'b' })];
    expect(subagentFileDiffs(entries)).toEqual([]);
  });
  it('skips a tool entry with no diff (a read, a grep)', () => {
    const entries = [toolEntry('completed', undefined)];
    expect(subagentFileDiffs(entries)).toEqual([]);
  });
});

describe('makeSubagentChangesPuller — coalescing', () => {
  it('reads once per child and posts what it found', async () => {
    const read = vi.fn().mockResolvedValue({ entries: [toolEntry('completed', { path: '/w/a.ts', oldText: '', newText: 'x' })] });
    const post = vi.fn();
    const pull = makeSubagentChangesPuller({ read, post });
    pull('child-1');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('child-1', [{ path: '/w/a.ts', oldText: '', newText: 'x' }]);
  });

  it('a signal that arrives mid-read is coalesced into ONE extra read, not queued per-signal', async () => {
    let resolveFirst: (() => void) | null = null;
    const read = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        if (!resolveFirst) { resolveFirst = () => resolve({ entries: [] }); return; }
        resolve({ entries: [] });
      }),
    );
    const post = vi.fn();
    const pull = makeSubagentChangesPuller({ read, post });
    pull('child-1');
    pull('child-1'); // arrives while the first read is in flight
    pull('child-1'); // and again — must not cost a THIRD read
    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(2); // the in-flight one, plus ONE coalesced re-read
  });
});
