// W2 (report F12 / 1.13) — a background collab that NEEDS the user.
//
// A collab tab's title was written once, at open, and never touched again. A
// chat tab has carried a waiting badge since 0.3 (`waitingTitleFor`), so a room
// working behind three other editor tabs could finish, block on a question, and
// sit there indefinitely with nothing to say so.
//
// TWO parts, split on testability. `collabAttention.ts` is the RULE — pure, no
// `vscode` — and `collabTab.setCollabTabWaiting` is the one line of VS Code
// state it drives, on the panel map that file already keeps.
//
// The rule deliberately does NOT badge on "an agent is running". A working room
// is the normal case and a badge that is always on is a badge nobody reads.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collabNeedsUser } from '../../../src/dashboard/collabAttention';

const task = (state: string) => ({
  id: 't1', title: 'Wire the store', owner: null, state, createdBy: 'user',
  result: null, note: null, originSeq: null, createdAt: '', updatedAt: '',
});

describe('collabNeedsUser — when a room is owed an answer', () => {
  it('the loop breaker tripping is the clearest case — nobody will speak again', () => {
    expect(collabNeedsUser({ suspended: true, agents: [], tasks: [] })).toBe(true);
  });

  it('a DONE task is waiting on a human to accept it or send it back', () => {
    expect(collabNeedsUser({ suspended: false, agents: [], tasks: [task('done')] })).toBe(true);
  });

  it('a working room is not owed anything — that is the normal case', () => {
    expect(collabNeedsUser({
      suspended: false,
      agents: [{ slug: 'collab-crane', state: 'running' }],
      tasks: [task('claimed')],
    })).toBe(false);
  });

  // A done task with an agent still working is NOT a wait: the room is mid-flow
  // and the next thing to happen is the agent's, not the user's.
  it('a done task alongside a running agent still waits on the agent', () => {
    expect(collabNeedsUser({
      suspended: false,
      agents: [{ slug: 'collab-crane', state: 'running' }],
      tasks: [task('done')],
    })).toBe(false);
  });

  it('a queued agent counts as work in flight, same as a running one', () => {
    expect(collabNeedsUser({
      suspended: false,
      agents: [{ slug: 'collab-crane', state: 'queued' }],
      tasks: [task('done')],
    })).toBe(false);
  });

  // Every M4 field is optional on the wire. An older engine sends no tasks and
  // no statuses; that must read as "nothing known to be owed", never as a badge.
  it('an older engine that sends none of the fields never badges', () => {
    expect(collabNeedsUser({})).toBe(false);
    expect(collabNeedsUser({ suspended: false })).toBe(false);
  });

  it('an accepted board owes nobody anything', () => {
    expect(collabNeedsUser({ suspended: false, agents: [], tasks: [task('accepted'), task('open')] })).toBe(false);
  });
});

describe('setCollabTabWaiting — the badge on the real panel', () => {
  beforeEach(() => vi.resetModules());

  it('badges the open tab and takes it off again, without stacking prefixes', async () => {
    const panel = { title: 'Collab · Parser', reveal: vi.fn(), onDidDispose: vi.fn(), webview: {}, iconPath: undefined };
    vi.doMock('vscode', () => ({
      window: { createWebviewPanel: vi.fn(() => panel) },
      Uri: { joinPath: vi.fn(() => ({})) },
      ViewColumn: { Active: 1 },
    }));
    const { openCollabTab, setCollabTabWaiting } = await import('../../../src/dashboard/agentManager/collabTab');
    const { WAITING_TITLE_PREFIX } = await import('../../../src/dashboard/tabIcon');

    openCollabTab({ extensionUri: {} } as never, { attachView: vi.fn() }, { id: 'c1', title: 'Parser' });

    setCollabTabWaiting('c1', true);
    expect(panel.title).toBe(`${WAITING_TITLE_PREFIX}Collab · Parser`);
    // Twice running must not stack a second prefix.
    setCollabTabWaiting('c1', true);
    expect(panel.title).toBe(`${WAITING_TITLE_PREFIX}Collab · Parser`);

    setCollabTabWaiting('c1', false);
    expect(panel.title).toBe('Collab · Parser');
  });

  it('a collab with no open tab is a no-op, not a throw', async () => {
    vi.doMock('vscode', () => ({
      window: { createWebviewPanel: vi.fn() },
      Uri: { joinPath: vi.fn(() => ({})) },
      ViewColumn: { Active: 1 },
    }));
    const { setCollabTabWaiting } = await import('../../../src/dashboard/agentManager/collabTab');
    expect(() => setCollabTabWaiting('never-opened', true)).not.toThrow();
  });
});
