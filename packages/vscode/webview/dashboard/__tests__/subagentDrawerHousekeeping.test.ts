// t-fiszlv — the sub-agent drawer's housekeeping, on both sides of the wire.
//
// R9: a dismissed row must STAY dismissed across a window reload. The dismissal
// is ours, not the engine's, so it cannot ride the transcript the way the done
// marker does — the host's message log is rebuilt from the engine's own replay
// and starts empty. It is held per ENGINE session on the workspace memento
// instead (src/dashboard/subagentDismissed.ts), and handed back on attach.
//
// R18: ONE dock per pane, not one per chat cell. Each mount carries a window
// listener and asks the host for the side-quest folder and the sub-agent ceiling
// on every focus, so an N-cell grid paid N readdirs and N setting reads for N
// copies of a drawer that is only ever read against the chat in focus.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';
import {
  SUBAGENT_DISMISSED_KEY,
  noteSubagentDismissed,
  readSubagentDismissed,
  type DismissedMemento,
} from '../../../src/dashboard/subagentDismissed';
import { replaySessionTo } from '../../../src/dashboard/replaySession';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);

/** A memento that holds exactly what `vscode.Memento` holds for this key. */
function fakeMemento(seed: unknown = undefined): DismissedMemento & { value: unknown } {
  return {
    value: seed,
    get<T>(key: string): T | undefined {
      return key === SUBAGENT_DISMISSED_KEY ? (this.value as T | undefined) : undefined;
    },
    update(key: string, value: unknown) {
      if (key === SUBAGENT_DISMISSED_KEY) this.value = value;
    },
  };
}

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => cleanup());

describe('R9 — the dismissed set is kept per chat on the host', () => {
  it('keeps a key against the ENGINE session id, and hands it back', () => {
    const m = fakeMemento();
    noteSubagentDismissed(m, 'ses_engine_1', 'child-a');
    noteSubagentDismissed(m, 'ses_engine_1', 'call_failed');
    noteSubagentDismissed(m, 'ses_engine_2', 'child-b');

    // Oldest first, and one chat's set never reaches another's.
    expect(readSubagentDismissed(m, 'ses_engine_1')).toEqual(['child-a', 'call_failed']);
    expect(readSubagentDismissed(m, 'ses_engine_2')).toEqual(['child-b']);
    expect(readSubagentDismissed(m, 'ses_never_seen')).toEqual([]);
  });

  it('records the same key once, and answers empty for a chat with no engine session', () => {
    const m = fakeMemento();
    noteSubagentDismissed(m, 'ses_engine_1', 'child-a');
    noteSubagentDismissed(m, 'ses_engine_1', 'child-a');
    expect(readSubagentDismissed(m, 'ses_engine_1')).toEqual(['child-a']);
    noteSubagentDismissed(m, null, 'child-a');
    noteSubagentDismissed(m, 'ses_engine_1', '');
    expect(readSubagentDismissed(m, 'ses_engine_1')).toEqual(['child-a']);
  });

  it('survives whatever is already on the memento, including junk', () => {
    // The memento is JSON a previous version wrote. A malformed value must read
    // as "nothing dismissed", never throw on the attach burst.
    expect(readSubagentDismissed(fakeMemento('nonsense'), 'ses_1')).toEqual([]);
    expect(readSubagentDismissed(fakeMemento({ ses_1: [1, 'child-a', null] }), 'ses_1')).toEqual(['child-a']);
  });

  it('evicts the OLDEST chat once too many are held, and re-touching one keeps it', () => {
    const m = fakeMemento();
    for (let i = 0; i < 41; i++) noteSubagentDismissed(m, `ses_${i}`, 'child-a');
    expect(readSubagentDismissed(m, 'ses_0'), 'the first chat fell off the end').toEqual([]);
    expect(readSubagentDismissed(m, 'ses_40')).toEqual(['child-a']);
    // ses_1 is now the oldest; touching it must move it to the back of the queue.
    noteSubagentDismissed(m, 'ses_1', 'child-b');
    noteSubagentDismissed(m, 'ses_new', 'child-a');
    expect(readSubagentDismissed(m, 'ses_1')).toEqual(['child-a', 'child-b']);
    expect(readSubagentDismissed(m, 'ses_2'), 'the next oldest went instead').toEqual([]);
  });

  it('rides the attach burst, and says nothing when there is nothing to say', () => {
    const sent: Array<Record<string, unknown>> = [];
    const session = { id: 'session-1', number: 1, agentName: 'Tsuru', messageLog: [] };
    const ctx = {
      remote: false, compress: false, wsPath: null, cwd: 'C:/ws',
      contextWindow: 1000, activity: {},
    };
    replaySessionTo((m) => void sent.push(m as Record<string, unknown>), session, {
      ...ctx, dismissedSubagents: ['child-a'],
    });
    expect(sent.find((m) => m['type'] === 'subagentDismissed')).toEqual({
      type: 'subagentDismissed', sessionId: 'session-1', keys: ['child-a'],
    });

    sent.length = 0;
    replaySessionTo((m) => void sent.push(m as Record<string, unknown>), session, { ...ctx, dismissedSubagents: [] });
    expect(sent.some((m) => m['type'] === 'subagentDismissed')).toBe(false);
  });
});

describe('R9 — the webview reports every dismissal and honours the replay', () => {
  const SESSION = 'sess-dismiss';

  /** A spawn that FAILED: no child session, so its key is the launcher's call
   *  id — and the × is the only control that row has. */
  async function failedSpawn() {
    post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
    await tick();
    post({
      type: 'toolCall', sessionId: SESSION, toolCallId: 'call_denied', title: 'write story 1',
      kind: 'think', status: 'failed', toolName: 'task',
    });
    await tick();
  }

  /** Open the drawer's list AND its Complete band — a failed spawn has stopped,
   *  so its row lives in the band that is folded shut by default. */
  async function openComplete(container: HTMLElement) {
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    await tick();
    await fireEvent.click(container.querySelector('.sa-group-fold') as HTMLElement);
    await tick();
  }

  it('tells the host when a row is dismissed by its ×', async () => {
    const { container } = render(ChatPane, { props: {} });
    await failedSpawn();
    expect(container.querySelector('.sa-head'), 'the failed row must be on the roster').not.toBeNull();
    await openComplete(container);

    await fireEvent.click(container.querySelector('.sa-dismiss') as HTMLButtonElement);
    await tick();

    expect(posts()).toContainEqual({ type: 'dismissSubagent', sessionId: SESSION, key: 'call_denied' });
    expect(container.querySelector('.sa-head'), 'and the row goes from this drawer at once').toBeNull();
  });

  it('starts a reopened chat from the set the host replays', async () => {
    // The reload case: the transcript comes back from the engine carrying the
    // same failed card, and the host hands back what was already swept.
    const { container } = render(ChatPane, { props: {} });
    await failedSpawn();
    expect(container.querySelector('.sa-head')).not.toBeNull();

    post({ type: 'subagentDismissed', sessionId: SESSION, keys: ['call_denied'] });
    await tick();

    expect(container.querySelector('.sa-head'), 'a row retired before the reload stays retired').toBeNull();
  });

  it('unions the replay with a dismissal made since, and ignores junk keys', async () => {
    const { container } = render(ChatPane, { props: {} });
    await failedSpawn();
    post({ type: 'toolCall', sessionId: SESSION, toolCallId: 'call_two', title: 'write story 2', kind: 'think', status: 'failed', toolName: 'task' });
    await tick();
    await openComplete(container);
    await fireEvent.click(container.querySelector('.sa-dismiss') as HTMLButtonElement);
    await tick();

    post({ type: 'subagentDismissed', sessionId: SESSION, keys: ['call_two', 42, ''] });
    await tick();

    expect(container.querySelector('.sa-head'), 'both rows are retired, from both roads').toBeNull();
  });
});

describe('R18 — one dock per pane, keyed by the active cell', () => {
  /** Three chats, side by side in the grid. */
  async function threeCellGrid() {
    for (const n of [1, 2, 3]) {
      post({ type: 'sessionCreated', sessionId: `sess-${n}`, sessionNumber: n, agentName: 'Tsuru' });
    }
    post({ type: 'setChatLayout', grid: true });
    await tick();
    await tick();
  }

  it('asks the host ONCE, whatever the cell count', async () => {
    const { container } = render(ChatPane, { props: {} });
    await threeCellGrid();
    expect(container.querySelectorAll('.chat-cell')).toHaveLength(3);

    // RED before the fix: three of each, one per mounted cell — three reads of the
    // sub-agent ceiling on mount, and three readdirs of `.origami/sidequests`
    // for every single window focus after it.
    expect(posts().filter((m) => m['type'] === 'requestSubagentLimit')).toHaveLength(1);
    expect(posts().filter((m) => m['type'] === 'requestSideQuests')).toHaveLength(1);

    globalThis.__vscodeApiMock.postMessage.mockClear();
    window.dispatchEvent(new Event('focus'));
    await tick();

    expect(posts().filter((m) => m['type'] === 'requestSideQuests')).toHaveLength(1);
  });

  it('mounts one Subagent dock, for the cell in focus, however many chats have agents out', async () => {
    const { container } = render(ChatPane, { props: {} });
    await threeCellGrid();
    for (const n of [1, 2, 3]) {
      post({
        type: 'toolCall', sessionId: `sess-${n}`, toolCallId: `call_${n}`, title: `write story ${n}`,
        kind: 'think', status: 'in_progress', toolName: 'task', taskSessionId: `child-${n}`, taskBackground: true,
        rawInput: { description: `write story ${n}` },
      });
    }
    await tick();

    // One drawer, not three — and it is the ACTIVE cell's roster.
    expect(container.querySelectorAll('.sa-drawer')).toHaveLength(1);
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    await tick();
    const names = () => [...container.querySelectorAll('.sa-name')].map((n) => n.textContent);
    expect(names()).toEqual(['T1 · write story 3']); // sessionCreated makes the newest chat active

    // Click the FIRST cell's header: the one drawer follows the focus.
    await fireEvent.click(container.querySelectorAll('.cell-header')[0] as HTMLElement);
    await tick();
    expect(container.querySelectorAll('.sa-drawer')).toHaveLength(1);
    expect(names()).toEqual(['T1 · write story 1']);
  });
});
