// collabWatch — the HOST-side collab poll (report F1 / plan 2.1).
//
// The defect it exists for: until now the only thing that ever asked the engine
// how a collab was doing was a mounted CollabPane. Close the tab and the
// sidebar ring went dark and stayed dark while the agents kept working, because
// the ring's only input is a `collabStateData` payload some pane's poll
// produced. So every test below runs with NO webview mounted at all — that is
// the whole point, and a test that needed a pane would be testing the thing
// that already worked.
//
// Fake timers throughout: the watch owns a re-armed timeout, so real time would
// make these tests slow and flaky in exactly the way the pane's own poll tests
// avoid.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchCollabs, stopCollabWatch, COLLAB_WATCH_MS, type CollabWatchHost } from '../../../src/dashboard/collabWatch';
import type { CollabSource } from '../../../src/dashboard/collabData';

interface FakeHost extends CollabWatchHost {
  posts: Array<Record<string, unknown>>;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
}

function fakeHost(reply: (params?: Record<string, unknown>) => Record<string, unknown>, client = true): FakeHost {
  const posts: Array<Record<string, unknown>> = [];
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const source: CollabSource = {
    extMethod: async (method, params) => {
      calls.push({ method, params });
      return reply(params);
    },
  };
  return {
    posts,
    calls,
    post: (msg) => posts.push(msg),
    cwd: () => 'C:/repo',
    collabClient: () => (client ? source : undefined),
  };
}

const working = () => ({ collab: { id: 'c1', title: 'Storm', createdAt: '', loopBreakerCap: null }, participants: [], messages: [], agents: [{ slug: 'collab-crane', state: 'running' }], suspended: false });

afterEach(() => {
  stopCollabWatch();
  vi.useRealTimers();
});

describe('collabWatch — a collab whose tab is shut', () => {
  it('keeps reporting its state with no pane mounted anywhere', async () => {
    vi.useFakeTimers();
    const host = fakeHost(working);
    watchCollabs(host, ['c1']);
    // Nothing before the first interval elapses — the watch is a background
    // observer, not a second burst of traffic on every list refresh.
    expect(host.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls[0].method).toBe('collab_state');
    expect(host.posts[0]).toMatchObject({ type: 'collabStateData', collabId: 'c1', agents: [{ slug: 'collab-crane', state: 'running' }] });
  });

  it('keeps going tick after tick, and asks only for what is NEW', async () => {
    vi.useFakeTimers();
    const host = fakeHost(() => ({ ...working(), messages: [{ seq: 4, authorId: 'collab-crane', authorKind: 'agent', text: 'on it', createdAt: '' }] }));
    watchCollabs(host, ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls[0].params).toEqual({ collabId: 'c1', cwd: 'C:/repo' });
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls[1].params).toEqual({ collabId: 'c1', sinceSeq: 4, cwd: 'C:/repo' });
    expect(host.posts).toHaveLength(2);
  });

  it('watches every live collab it was given, and drops one taken off the list', async () => {
    vi.useFakeTimers();
    const host = fakeHost(working);
    watchCollabs(host, ['c1', 'c2']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls.map((c) => c.params?.collabId)).toEqual(['c1', 'c2']);
    watchCollabs(host, ['c2']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls.map((c) => c.params?.collabId)).toEqual(['c1', 'c2', 'c2']);
  });
});

describe('collabWatch — what it must NOT do', () => {
  it('arms no timer at all for an empty list', async () => {
    vi.useFakeTimers();
    const host = fakeHost(working);
    watchCollabs(host, []);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS * 3);
    expect(host.calls).toEqual([]);
  });

  it('stops for good when the panel goes away — nothing may outlive it', async () => {
    vi.useFakeTimers();
    const host = fakeHost(working);
    watchCollabs(host, ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    stopCollabWatch();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS * 3);
    expect(host.calls).toHaveLength(1);
  });

  it('says nothing while there is no engine to ask, and picks up when one appears', async () => {
    vi.useFakeTimers();
    const dead = fakeHost(working, false);
    watchCollabs(dead, ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS * 2);
    // No `collabStateData` carrying "Open a chat first" — the sidebar would
    // have shown an error for a collab that is merely unobserved.
    expect(dead.posts).toEqual([]);

    const live = fakeHost(working);
    watchCollabs(live, ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(live.posts).toHaveLength(1);
  });

  it('swallows a failing background poll rather than painting an error over an open room', async () => {
    vi.useFakeTimers();
    const host = fakeHost(() => { throw new Error('engine offline'); });
    watchCollabs(host, ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls).toHaveLength(1);
    expect(host.posts).toEqual([]);
    // And it keeps trying — a dead engine is not a reason to stop watching.
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(host.calls).toHaveLength(2);
  });
});
