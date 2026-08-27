// ChatTranscript.test.ts — the renderer, mounted on its own.
//
// This test could not be written before the extraction. The per-message loop
// lived inside ChatPane.svelte, so "does a `compacted` row render as a
// compaction block" could only be asked by booting the whole pane and driving
// a real ACP event sequence at it (sessionCreated → busy → agentThought → …).
// Every branch of the chain therefore cost a wire protocol to reach, and a
// branch nobody could reach cheaply is a branch nobody covered.
//
// It is also the test the NEXT commit needs. A read-only transcript will mount
// this same component with a list of historical messages; the guarantee it
// depends on is exactly this one — a fixed list in, one row per message, in
// order, each dispatched to the renderer its `kind` names. If the dispatch
// chain silently reorders or drops a kind, a historical transcript renders a
// different conversation from the live one it claims to reproduce.

import { render, fireEvent } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatTranscript from './ChatTranscript.svelte';
import type { Message } from '../panes/chatMessage';

// One message per branch of the if/else-if chain, in a deliberately mixed
// order so a renderer that grouped by kind (or sorted) would fail.
const MESSAGES: Message[] = [
  { id: 1, kind: 'user', label: 'You', text: 'ship the extraction' },
  { id: 2, kind: 'thought', label: '', text: 'weighing the boundary' },
  { id: 3, kind: 'tool', label: 'read_file: ChatPane.svelte', text: '', toolKind: 'read', toolName: 'read_file', toolStatus: 'completed' },
  { id: 4, kind: 'agent', label: 'Tsuru', text: 'moved the loop', engineMsgId: 'eng-4' },
  { id: 5, kind: 'verdict', label: '', text: 'Done', verdict: { kind: 'done', reason: 'success' } },
  { id: 6, kind: 'todoSummary', label: '', text: '', summaryTodos: [{ id: 1, content: 'extract', activeForm: 'extracting', status: 'completed' }] },
  { id: 7, kind: 'compacted', label: '', text: 'carried forward: the plan' },
  { id: 8, kind: 'peer', label: 'Kirin', text: 'ack', peerReplyTo: 'Tsuru' },
  { id: 9, kind: 'error', label: 'Error', text: 'nope' },
];

// The DOM signature each kind must produce, in the order the list declares.
// Selectors, not text: they are the contract the moved CSS also targets, so a
// rule left behind in the pane and a row that stopped rendering fail the same
// assertion here.
const EXPECTED = [
  'div.row.user',
  'details.thought-block',
  'div.tool-card',
  'div.agent-row',
  'div.turn-verdict',
  'div.todo-summary-msg',
  'details.compaction-block',
  'div.peer-row',
  'div.row.error',
];

describe('ChatTranscript — a fixed message list becomes the rows it names', () => {
  it('renders one row per message, in list order, dispatched by kind', () => {
    const { container } = render(ChatTranscript, {
      messages: MESSAGES,
      sessionId: 'sess-1',
      inFlight: false,
      currentThoughtMsgId: null,
      currentAgentMsgId: null,
      openThoughtIds: [],
      onThoughtOpenIds: () => {},
      onImageClick: () => {},
      onRewind: () => {},
    });

    const rows = [...container.children] as HTMLElement[];
    expect(rows.length, 'one top-level row per message, no more and no fewer').toBe(MESSAGES.length);
    const actual = rows.map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => !c.startsWith('svelte-')).join('.')}`);
    // Each row must MATCH its expected signature — startsWith, because a row may
    // carry extra state classes (ToolCard's `done`, MessageRow's kind) beyond the
    // ones that identify it.
    EXPECTED.forEach((want, i) => {
      expect(actual[i], `row ${i} (message id ${MESSAGES[i].id}, kind ${MESSAGES[i].kind})`).toContain(want.split('.').slice(1).join('.'));
      expect(rows[i].tagName.toLowerCase(), `row ${i} tag`).toBe(want.split('.')[0]);
    });
  });
});

// READ-ONLY MODE — the sub-agent transcript's whole safety story.
//
// These rows are HISTORY. Three controls in the live renderer act on the
// user's machine or on whatever turn is running NOW, and they are not in one
// place: the rewind button is in ChatTranscript itself, Kill and Stop are one
// component down in ToolCard. So each is asserted where it actually lives —
// hiding markup at the top would have left the other two armed.
//
// What must KEEP working is asserted too: a reader of a transcript wants to
// open the files the sub-agent touched, and doing so mutates nothing.

const post = () => globalThis.__vscodeApiMock.postMessage;

/** A live bash call old enough to be flagged stuck — the only state in which
 *  ToolCard renders its Kill button at all. */
const STUCK_BASH: Message = {
  id: 1, kind: 'tool', label: 'bash: npm test', text: '',
  toolKind: 'bash', toolName: 'bash', toolStatus: 'in_progress',
  toolShell: { command: 'npm test', state: 'foreground', startedAt: Date.now() - 600_000 },
};

/** A backgrounded shell job — the only state in which Stop is rendered. */
const BACKGROUND_BASH: Message = {
  id: 1, kind: 'tool', label: 'bash: npm run watch', text: '',
  toolKind: 'bash', toolName: 'bash', toolStatus: 'in_progress',
  toolShell: { command: 'npm run watch', state: 'background', jobId: 'job-7', startedAt: Date.now() - 600_000 },
};

const AGENT_TURN: Message = { id: 2, kind: 'agent', label: 'Tsuru', text: 'done', engineMsgId: 'eng-2' };

function mount(messages: Message[], readOnly: boolean, onRewind = () => {}) {
  return render(ChatTranscript, {
    messages, sessionId: 'sess-1', inFlight: false,
    currentThoughtMsgId: null, currentAgentMsgId: null,
    openThoughtIds: [], onThoughtOpenIds: () => {},
    onRewind, readOnly,
  }).container;
}

describe('ChatTranscript — read-only kills the controls that reach the machine', () => {
  beforeEach(() => post().mockReset());

  it('rewind is offered on a live transcript and ABSENT on a read-only one', () => {
    // Both halves, deliberately: an assertion that the button is missing proves
    // nothing unless the same message renders it when read-only is off.
    expect(mount([AGENT_TURN], false).querySelector('.rewind-btn')).not.toBeNull();
    expect(mount([AGENT_TURN], true).querySelector('.rewind-btn')).toBeNull();
  });

  it('never calls onRewind in read-only mode, because there is nothing to click', async () => {
    const onRewind = vi.fn();
    const live = mount([AGENT_TURN], false, onRewind);
    await fireEvent.click(live.querySelector('.rewind-btn') as HTMLElement);
    expect(onRewind, 'the live control is wired').toHaveBeenCalledWith('sess-1', 'eng-2');

    onRewind.mockReset();
    expect(mount([AGENT_TURN], true, onRewind).querySelector('.rewind-btn')).toBeNull();
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("a stuck bash card's Kill is live in the chat and gone in a transcript", async () => {
    const live = mount([STUCK_BASH], false);
    const kill = live.querySelector('.tool-stuck-kill') as HTMLElement | null;
    expect(kill, 'a 10-minute-old foreground bash call must offer Kill').not.toBeNull();
    await fireEvent.click(kill!);
    expect(post()).toHaveBeenCalledWith({ type: 'cancel', sessionId: 'sess-1' });

    post().mockReset();
    const ro = mount([STUCK_BASH], true);
    expect(ro.querySelector('.tool-stuck-kill'), 'Kill cancels the turn running NOW').toBeNull();
    expect(post()).not.toHaveBeenCalled();
  });

  it("a background shell's Stop is live in the chat and gone in a transcript", async () => {
    const live = mount([BACKGROUND_BASH], false);
    const stop = live.querySelector('.tool-stuck-kill') as HTMLElement | null;
    expect(stop, 'a backgrounded job must offer Stop').not.toBeNull();
    await fireEvent.click(stop!);
    expect(post()).toHaveBeenCalledWith({ type: 'stopBackgroundShell', sessionId: 'sess-1', jobId: 'job-7' });

    post().mockReset();
    const ro = mount([BACKGROUND_BASH], true);
    expect(ro.querySelector('.tool-stuck-kill')).toBeNull();
    expect(post()).not.toHaveBeenCalled();
  });

  it('a file link in prose STILL opens the file in read-only mode', async () => {
    // The deliberate exception. Opening what the sub-agent read or wrote is the
    // reason to open its transcript at all, and it changes nothing on disk.
    const c = mount([{ id: 3, kind: 'agent', label: 'Tsuru', text: 'fixed src/foo.ts:78' }], true);
    const link = c.querySelector('a.file-link') as HTMLElement | null;
    expect(link, 'a prose path must still linkify').not.toBeNull();
    await fireEvent.click(link!);
    expect(post()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'src/foo.ts', line: 78 });
  });
});
