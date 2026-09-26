// t-t7lfho — a chat this desk gave to another desk: NO write leaves the pane.
// Driven as the host drives ChatPane (window messages in, postMessage out).
// The gate is ONE place (webview/shared/nestWriteGate.ts, applied inside
// getVsCodeApi); the transcript's Retry and Rewind also stop before they
// change the view. The engine's read-only guard stays the backstop.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import ChatPane from './ChatPane.svelte';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { NEST_WRITE_TYPES } from '../../shared/nestWriteGate';

const SID = 'ses-away-1';
const OTHER = 'ses-here-2';

async function host(data: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
const writes = () => posts().filter((m) => NEST_WRITE_TYPES.has(String(m['type'])));
const away = (ids: string[]) => host({ type: 'origami/nestIndex', rows: [], desks: [], away: ids.map((id) => ({ id, desk: 'dev-5090', at: 1 })) });

/** A finished turn whose stream then stopped: the agent row has a Rewind, the card a Retry. */
async function chat(): Promise<HTMLElement> {
  const { container } = render(ChatPane);
  await host({ type: 'sessionCreated', sessionId: SID, sessionNumber: 1, agentName: 'Coder', agentArt: null });
  await host({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
  await host({ type: 'echoUser', sessionId: SID, text: 'fix the rig' });
  await host({ type: 'agentText', sessionId: SID, text: 'Done.', messageId: 'msg_1' });
  await host({ type: 'turnDone', sessionId: SID });
  await host({ type: 'streamDrop', sessionId: SID, notice: { kind: 'stopped', attempt: 3, max: 3, detail: 'socket closed' } });
  return container as HTMLElement;
}
const button = (c: HTMLElement, label: RegExp) => Array.from(c.querySelectorAll('button')).find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement;

beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
afterEach(async () => { cleanup(); await away([]); });

describe('ChatPane on a chat that went to another desk', () => {
  it('control: on a chat this desk writes, Retry posts a send (so the test can see a post)', async () => {
    const c = await chat();
    await fireEvent.click(button(c, /^Retry$/));
    expect(writes().map((m) => m['type'])).toEqual(['send']);
  });

  it('control: on a chat this desk writes, Rewind posts revertToMessage', async () => {
    const c = await chat();
    await fireEvent.click(button(c, /Rewind here/));
    expect(writes()).toEqual([{ type: 'revertToMessage', messageId: 'msg_1', sessionId: SID }]);
  });

  it('Retry and Rewind post nothing and leave the transcript as it was', async () => {
    const c = await chat();
    await away([SID]);
    const rows = c.querySelectorAll('.cell-messages [class*="row"]').length;
    await fireEvent.click(button(c, /Rewind here/));
    await fireEvent.click(button(c, /^Retry$/));
    await tick();
    expect(writes()).toEqual([]);
    expect(c.querySelectorAll('.cell-messages [class*="row"]').length).toBe(rows);
    expect(c.querySelector('.rewind-undo')).toBeNull();
    expect(c.querySelector('.stream-indicator')).toBeNull();
  });

  it('every write type the pane can post is dropped for the away chat, and passes for a chat of this desk', async () => {
    render(ChatPane);
    await away([SID]);
    const api = getVsCodeApi();
    for (const type of NEST_WRITE_TYPES) api.postMessage({ type, sessionId: SID, text: 'x' });
    expect(writes()).toEqual([]);
    for (const type of NEST_WRITE_TYPES) api.postMessage({ type, sessionId: OTHER, text: 'x' });
    expect(writes().map((m) => m['type'])).toEqual([...NEST_WRITE_TYPES]);
    // Cancel and a read are not writes: they still go.
    api.postMessage({ type: 'cancel', sessionId: SID });
    api.postMessage({ type: 'requestHistory' });
    expect(posts().slice(-2).map((m) => m['type'])).toEqual(['cancel', 'requestHistory']);
    // Taken back here: the next push has no away record, and writes go again.
    await away([]);
    api.postMessage({ type: 'send', sessionId: SID, text: 'x' });
    expect(writes().at(-1)).toMatchObject({ type: 'send', sessionId: SID });
  });
});

// A new write path must be classified here, or this test fails: every message
// type the chat pane and its transcript components post WITH a sessionId is
// either gated (NEST_WRITE_TYPES) or named below as not a write, with why.
describe('drift guard — every session-scoped post is classified', () => {
  const NOT_WRITES: Record<string, string> = {
    cancel: 'stops a turn; writes no row',
    engineRetry: 'starts the engine again; the prompt it holds was gated when it was sent',
    permission: 'answers an ask; writes no row',
    dismissSubagent: 'workspaceState only',
    closeSession: 'closes the tab here',
    popOutSession: 'opens a tab',
    recallSession: 'opens a chat',
    activeSessionChanged: 'view state',
    exportSession: 'reads the transcript',
    openSubagentDrawer: 'view state',
    openSideQuestsDrawer: 'view state',
    requestSubagentTranscript: 'a read',
    stopSubagent: 'a child session',
    secondOpinion: 'a read-only review',
    forkChat: 'reads the source to make a NEW chat; writes nothing into the source (t-v5qv6u)',
    setMode: 'engine config kept out of the session row (not in ROW_WRITING_CONFIG, engine/src/acp/service.ts)',
    setEffort: 'engine config kept out of the session row (not in ROW_WRITING_CONFIG)',
    sidebarChat: 'view state: the chat the sidebar displays (t-xp0dzr)',
    imageError: 'a notice shown in the chat; writes no row (t-xsufto: the id only places it)',
    setBudget: 'the global monthly cap (~/.origami/budget.json); the id only places the note (t-xsufto)',
  };
  const files = [
    'panes/ChatPane.svelte', 'components/ChatTranscript.svelte', 'components/MessageRow.svelte', 'components/ToolCard.svelte',
    'components/SubagentDock.svelte', 'components/ComposerUtilityRow.svelte', 'components/InputBar.svelte',
  ];
  it('no unclassified type', () => {
    const found = new Set<string>();
    for (const f of files) {
      const src = readFileSync(join(__dirname, '..', f), 'utf-8');
      for (const m of src.matchAll(/postMessage\(\{\s*type:\s*'(\w+)'([^}]*)\}/g)) if (/sessionId/.test(m[2] ?? '')) found.add(m[1]!);
    }
    expect(found.size).toBeGreaterThan(8);
    const unclassified = [...found].filter((t) => !NEST_WRITE_TYPES.has(t) && !(t in NOT_WRITES));
    expect(unclassified).toEqual([]);
  });
});
