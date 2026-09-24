// t-ucnp7t — lazy loading, WEBVIEW side: the rules (panes/chatHistory.ts), the top-of-transcript
// bar (ChatHistoryBar.svelte), find's two modes (ChatFind.svelte + ChatFindAll.svelte), and the
// pane driven end to end through the host's own post shapes (src/dashboard/historyHost.ts).
//
// Every host post below is the shape historyHost.ts builds (historyStatePost / loadHistory /
// searchHistory), and every `messages` array is the host log shape (sessionLog.ts). jsdom has no
// layout: scroll positions are driven by hand, and what the prepend LOOKS like needs the real
// window (named in the lane report).

import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ChatPane from '../panes/ChatPane.svelte';
import ChatHistoryBar from '../components/ChatHistoryBar.svelte';
import ChatFind from '../components/ChatFind.svelte';
import ChangesPill from '../components/ChangesPill.svelte';
import {
  applyHistory, changesFor, composerHint, earlierLabel, emptyHistory, loadAllFirst, pinnedFor, requestHistory,
  rewindAcross, shownMessages, subagentSource, type ChatHistory, type HistoryHolder, type RosterRow,
} from '../panes/chatHistory';
import { heldScrollTop, holdPlace } from '../panes/historyScroll';
import { subagentRows } from '../panes/subagentRows';
import { pickJumpMatch, type GlobalHit } from '../components/chatFindGlobal';
import { findMatches } from '../components/chatFind';
import type { Message } from '../panes/chatMessage';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const settle = async () => { for (let i = 0; i < 4; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); } };

let ids = 0;
const nextId = () => ++ids;
const row = (kind: Message['kind'], text: string, extra: Partial<Message> = {}): Message => ({ id: nextId(), kind, label: kind, text, ...extra });
const holder = (messages: Message[], history?: ChatHistory): HistoryHolder => ({ id: 'session-1', agentName: 'Tsuru', messages, history });
const rosterRow = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: 'kid-1', parentId: 'ses_1', depth: 1, title: 'scan the repo', agent: 'explore', status: 'running', created: 1000, updated: 2000,
  tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.5, steps: 3, context: 900, ...over,
});
/** A lazy window, as historyStatePost builds it once the engine's window landed. */
const windowState = (over: Record<string, unknown> = {}) => ({
  type: 'historyState', sessionId: 'session-1', restoring: false, lazy: true, cursor: 'c1', hasMore: true, total: 120,
  latestUser: null, loadedIds: ['n1', 'n2'], roster: [], ...over,
});

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); ids = 0; });
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('chatHistory — the window and the older pages', () => {
  it('older pages go to `older`, never into `messages`: the same array, the same rows (plan F13)', () => {
    const newest = [row('user', 'newest q')];
    const s = holder(newest);
    applyHistory(s, windowState(), nextId);
    applyHistory(s, { type: 'historyPage', sessionId: 'session-1', messages: [{ kind: 'user', text: 'older q', timestamp: 1 }, { kind: 'agent', text: 'older a', timestamp: 2, messageId: 'm-old' }], messageIds: ['o1', 'o2'], cursor: 'c2', hasMore: true, total: 120, loaded: 4 }, nextId);
    expect(s.messages).toBe(newest);
    expect(s.messages.map((m) => m.text)).toEqual(['newest q']);
    expect(shownMessages(s).map((m) => m.text)).toEqual(['older q', 'older a', 'newest q']);
    expect(s.history?.older[1].engineMsgId).toBe('m-old');
    expect(s.history).toMatchObject({ cursor: 'c2', hasMore: true, loadedIds: ['o1', 'o2', 'n1', 'n2'] });
  });

  it('an old engine: nothing older, and the transcript is the very same array as before', () => {
    const s = holder([row('user', 'q')]);
    applyHistory(s, { type: 'historyState', sessionId: 'session-1', restoring: false, lazy: false, cursor: null, hasMore: false, total: null, latestUser: null, loadedIds: [], roster: [] }, nextId);
    expect(shownMessages(s)).toBe(s.messages);
    expect(earlierLabel(s.history!)).toBe('Load earlier messages');
    expect(loadAllFirst(s, 'export', () => undefined)).toBe(false);
    expect(posts()).toEqual([]);
  });

  it('a later tab takes the older rows once, and never a second copy (plan 3.5 late tab)', () => {
    const s = holder([]);
    const older = [{ kind: 'user', text: 'q0', timestamp: 1 }];
    applyHistory(s, windowState({ older }), nextId);
    applyHistory(s, windowState({ older }), nextId);
    expect(s.history?.older.map((m) => m.text)).toEqual(['q0']);
  });

  it('the restore ending settles a replayed compaction marker (plan F5)', () => {
    const s = holder([row('compacted', 'summary', { compacting: true })]);
    applyHistory(s, windowState({ restoring: true }), nextId);
    applyHistory(s, windowState(), nextId);
    expect(s.messages[0].compacting).toBe(false);
  });

  it('the label counts what is left, and shows progress while a whole-chat load runs (plan 3.6)', () => {
    const s = holder([]);
    applyHistory(s, windowState({ total: 870, loadedIds: Array.from({ length: 50 }, (_, i) => `n${i}`) }), nextId);
    expect(earlierLabel(s.history!)).toBe('Load earlier messages (820 more)');
    applyHistory(s, { type: 'historyProgress', sessionId: 'session-1', reason: 'export#1', loaded: 350, total: 870 }, nextId);
    expect(earlierLabel(s.history!)).toBe('Loading 350 of 870 messages…');
    applyHistory(s, { type: 'historyProgress', sessionId: 'session-1', reason: 'scroll#2', loaded: 50, total: 870 }, nextId);
    expect(earlierLabel(s.history!)).toBe('Loading earlier messages…');
    applyHistory(s, windowState({ total: null }), nextId);
    s.history!.loading = null;
    expect(earlierLabel(s.history!)).toBe('Load earlier messages');
  });

  it('a failed load clears the loading state and keeps the error on screen, never "Loading…" for ever', () => {
    const s = holder([]);
    applyHistory(s, windowState(), nextId);
    applyHistory(s, { type: 'historyProgress', sessionId: 'session-1', reason: 'scroll#1', loaded: 2, total: 120 }, nextId);
    applyHistory(s, { type: 'historyLoaded', sessionId: 'session-1', reason: 'scroll#1', ok: false, error: 'This engine cannot load older messages. Update Origami.' }, nextId);
    expect(s.history?.loading).toBeNull();
    expect(s.history?.error).toMatch(/Update Origami/);
  });
});

describe('chatHistory — plan section 4, with only part of the chat loaded', () => {
  it('F2 export: a FAILED load does not export a part chat, and does not ask again by itself', () => {
    const s = { ...holder([row('user', 'newest')]), id: 'session-fail' };
    applyHistory(s, windowState({ sessionId: 'session-fail' }), nextId);
    const run = vi.fn(() => { loadAllFirst(s, 'export', run); });
    loadAllFirst(s, 'export', run);
    applyHistory(s, { type: 'historyLoaded', sessionId: 'session-fail', reason: posts()[0].reason, ok: false, error: 'boom' }, nextId);
    expect(run).not.toHaveBeenCalled();
    expect(posts().filter((p) => p.type === 'historyLoad')).toHaveLength(1);
    expect(s.history?.error).toBe('boom');
  });

  it('F2 export: loads the whole chat first, then runs the export with every row', () => {
    const s = holder([row('user', 'newest')]);
    applyHistory(s, windowState(), nextId);
    const run = vi.fn();
    expect(loadAllFirst(s, 'export', run)).toBe(true);
    const ask = posts()[0];
    expect(ask).toMatchObject({ type: 'historyLoad', sessionId: 'session-1', until: 'all' });
    expect(String(ask.reason)).toMatch(/^export/);
    expect(run).not.toHaveBeenCalled();
    applyHistory(s, { type: 'historyPage', sessionId: 'session-1', messages: [{ kind: 'user', text: 'first', timestamp: 1 }], messageIds: ['o1'], cursor: null, hasMore: false, total: 3, loaded: 3 }, nextId);
    applyHistory(s, { type: 'historyLoaded', sessionId: 'session-1', reason: ask.reason, ok: true }, nextId);
    expect(run).toHaveBeenCalledTimes(1);
    expect(loadAllFirst(s, 'export', run)).toBe(false);
  });

  it('F4 rewind inside the loaded rows trims exactly as before', () => {
    const s = holder([row('user', 'q1'), row('agent', 'a1', { engineMsgId: 'e1' }), row('user', 'q2'), row('agent', 'a2', { engineMsgId: 'e2' })]);
    expect(rewindAcross(s, 'e2', vi.fn())).toBe(true);
    expect(s.messages.map((m) => m.text)).toEqual(['q1', 'a1']);
    expect(s.revertStash?.map((m) => m.text)).toEqual(['q2', 'a2']);
  });

  it('F4 rewind of an OLDER row trims the older pages too, and stashes everything after', () => {
    const s = holder([row('user', 'newest q'), row('agent', 'newest a', { engineMsgId: 'e9' })]);
    applyHistory(s, windowState(), nextId);
    applyHistory(s, { type: 'historyPage', sessionId: 'session-1', messages: [{ kind: 'user', text: 'q0', timestamp: 1 }, { kind: 'user', text: 'q1', timestamp: 2 }, { kind: 'agent', text: 'a1', timestamp: 3, messageId: 'e1' }], messageIds: ['o1', 'o2'], cursor: null, hasMore: false, total: 5, loaded: 5 }, nextId);
    expect(rewindAcross(s, 'e1', vi.fn())).toBe(true);
    // The engine reverts from q1, the user row that opened a1's turn.
    expect(shownMessages(s).map((m) => m.text)).toEqual(['q0']);
    expect(s.messages).toEqual([]);
    expect(s.revertStash?.map((m) => m.text)).toEqual(['q1', 'a1', 'newest q', 'newest a']);
  });

  it('F4 rewind whose question is ABOVE everything loaded: loads until a user row, then rewinds', () => {
    const s = holder([row('agent', 'tail of a long turn', { engineMsgId: 'e5' })]);
    applyHistory(s, windowState(), nextId);
    const retry = vi.fn(() => rewindAcross(s, 'e5', vi.fn()));
    expect(rewindAcross(s, 'e5', retry)).toBe(false);
    expect(s.messages).toHaveLength(1);
    const ask = posts()[0];
    expect(ask).toMatchObject({ type: 'historyLoad', until: 'user' });
    applyHistory(s, { type: 'historyPage', sessionId: 'session-1', messages: [{ kind: 'user', text: 'the question', timestamp: 1 }], messageIds: ['o1'], cursor: 'c2', hasMore: true, total: 9, loaded: 3 }, nextId);
    applyHistory(s, { type: 'historyLoaded', sessionId: 'session-1', reason: ask.reason, ok: true }, nextId);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(shownMessages(s)).toEqual([]);
    expect(s.revertStash?.map((m) => m.text)).toEqual(['the question', 'tail of a long turn']);
  });

  it('F8 roster: a child above the loaded page gets a card and a drawer row; a loaded card wins', () => {
    const s = holder([row('tool', 'task', { toolName: 'task', taskSessionId: 'kid-2', toolStatus: 'completed', taskBackground: true })]);
    applyHistory(s, windowState({ roster: [rosterRow(), rosterRow({ id: 'kid-2', title: 'second', created: 3000 }), rosterRow({ id: 'grandkid', depth: 2 })] }), nextId);
    const source = subagentSource(s);
    expect(source.map((m) => m.taskSessionId)).toEqual(['kid-1', 'kid-2']);
    const rows = subagentRows(source, 5000);
    const off = rows.find((r) => r.taskSessionId === 'kid-1')!;
    expect(off).toMatchObject({ ordinal: 1, state: 'running', description: 'scan the repo' });
    expect(off.tokens).toMatchObject({ input: 10, output: 20, steps: 3, context: 900, cost: 0.5 });
    expect(rows.find((r) => r.taskSessionId === 'kid-2')?.ordinal).toBe(2);
    expect(rows.some((r) => r.taskSessionId === 'grandkid')).toBe(false);
  });

  it('F8 roster: an idle child\'s card is settled, and the done marker a live event wrote survives a re-send', () => {
    const s = holder([]);
    applyHistory(s, windowState({ roster: [rosterRow({ status: 'idle', updated: 4000 })] }), nextId);
    expect(subagentRows(subagentSource(s), 9000)[0]).toMatchObject({ state: 'done', endedAt: 4000 });
    const t = holder([]);
    applyHistory(t, windowState({ roster: [rosterRow()] }), nextId);
    t.history!.rosterCards[0].taskDone = 'error';
    applyHistory(t, windowState({ roster: [rosterRow()] }), nextId);
    expect(t.history!.rosterCards[0].taskDone).toBe('error');
  });

  it('F8 roster: when the page holding the real card loads, the live state moves onto it', () => {
    const s = holder([]);
    applyHistory(s, windowState({ roster: [rosterRow()] }), nextId);
    s.history!.rosterCards[0].taskStream = 'reading files';
    applyHistory(s, { type: 'historyPage', sessionId: 'session-1', messages: [{ kind: 'tool', text: 'task', timestamp: 1, tool: { call: { toolCallId: 'c1', toolName: 'task', title: 'task' }, result: { toolCallId: 'c1', status: 'completed', taskSessionId: 'kid-1', taskBackground: true } } }], messageIds: ['o1'], cursor: null, hasMore: false, total: 3, loaded: 3 }, nextId);
    const source = subagentSource(s);
    expect(source).toHaveLength(1);
    expect(source[0].toolCallId).toBe('c1');
    expect(source[0].taskStream).toBe('reading files');
  });

  it('F11 pinned question: from the engine when no loaded row is a user row', () => {
    const s = holder([row('agent', 'a long turn'), row('tool', 'read')]);
    applyHistory(s, windowState({ latestUser: { messageId: 'mu', text: 'why is it slow?' } }), nextId);
    expect(pinnedFor(s)).toBe('why is it slow?');
    const t = holder([row('user', 'loaded q'), row('agent', 'a')]);
    applyHistory(t, windowState({ latestUser: { messageId: 'mu', text: 'older q' } }), nextId);
    expect(pinnedFor(t)).toBe('loaded q');
  });

  it('F12 changes pill: labelled partial while older pages are not loaded', () => {
    const edit = row('tool', 'edit', { toolName: 'edit', toolPath: 'a.ts', toolDiff: { path: 'a.ts', oldText: 'x', newText: 'y' } });
    const s = holder([edit]);
    applyHistory(s, windowState(), nextId);
    expect(changesFor(s)).toMatchObject({ fileCount: 1, partial: true });
    s.history!.hasMore = false;
    expect(changesFor(s).partial).toBeUndefined();
  });

  it('F12 changes pill: the partial figure is LABELLED on screen, a whole-chat one is not', () => {
    const changes = { fileCount: 1, adds: 1, dels: 1, files: [{ path: 'a.ts', adds: 1, dels: 1, created: false }] };
    const partial = render(ChangesPill, { changes: { ...changes, partial: true } });
    expect(partial.container.querySelector('.cp-part')?.textContent).toBe('loaded');
    cleanup();
    const whole = render(ChangesPill, { changes });
    expect(whole.container.querySelector('.cp-part')).toBeNull();
  });

  it('3.6 composer: "Loading chat…" while the reopen arrives, the old text for a fresh start', () => {
    const s: HistoryHolder = { ...holder([]), starting: true, history: { ...emptyHistory(), restoring: true } };
    expect(composerHint(s)).toMatch(/^Loading chat/);
    expect(composerHint({ ...s, history: undefined })).toMatch(/^Starting engine/);
    expect(composerHint({ ...s, starting: false })).toBe('');
  });

  it('a scroll-up load is one at a time: a second trigger before the answer sends nothing', () => {
    expect(requestHistory('session-9', 'page', 'scroll')).toBe(true);
    expect(requestHistory('session-9', 'page', 'scroll')).toBe(false);
    expect(posts()).toHaveLength(1);
    applyHistory(holder([]) as HistoryHolder & { id: string }, { type: 'historyLoaded', sessionId: 'session-9', reason: posts()[0].reason, ok: true }, nextId);
  });
});

describe('chatHistory — no answer is an error, never "Loading…" for ever (plan 3.6)', () => {
  it('fails every open load of the chat 20 s after the LAST sign of life, through the normal route', async () => {
    vi.useFakeTimers();
    const seen: Array<Record<string, unknown>> = [];
    const listen = (ev: MessageEvent) => { if (ev.data?.type === 'historyLoaded') seen.push(ev.data); };
    window.addEventListener('message', listen);
    try {
      const s = { ...holder([]), id: 'session-dl' };
      applyHistory(s, windowState({ sessionId: 'session-dl' }), nextId);
      const done = vi.fn();
      requestHistory('session-dl', 'all', 'export', done);
      vi.advanceTimersByTime(15_000);
      applyHistory(s, { type: 'historyProgress', sessionId: 'session-dl', reason: posts()[0].reason, loaded: 50, total: 120 }, nextId);
      vi.advanceTimersByTime(15_000);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(5_001);
      expect(seen).toEqual([expect.objectContaining({ sessionId: 'session-dl', reason: posts()[0].reason, ok: false })]);
      applyHistory(s, seen[0], nextId);
      expect(done).toHaveBeenCalledWith({ ok: false });
      expect(s.history?.error).toMatch(/No answer after 20 s/);
      expect(requestHistory('session-dl', 'page', 'scroll')).toBe(true);
    } finally {
      window.removeEventListener('message', listen);
      vi.useRealTimers();
    }
  });

  it('a page this pane already holds is not drawn twice (a tab that attached mid-load)', () => {
    const s = holder([]);
    applyHistory(s, windowState({ older: [{ kind: 'user', text: 'q0', timestamp: 1 }], loadedIds: ['o1', 'n1'] }), nextId);
    applyHistory(s, { type: 'historyPage', sessionId: 'session-1', messages: [{ kind: 'user', text: 'q0', timestamp: 1 }], messageIds: ['o1'], cursor: null, hasMore: false, total: 2, loaded: 2 }, nextId);
    expect(shownMessages(s).map((m) => m.text)).toEqual(['q0']);
  });
});

describe('historyScroll — the reader\'s place across a prepend', () => {
  it('keeps the distance to the end of the content', () => {
    expect(heldScrollTop(3000, 800)).toBe(2200);
    expect(heldScrollTop(500, 800)).toBe(0);
  });

  it('puts scrollTop back after the render, by the height the prepend added', async () => {
    const el = { scrollTop: 100, scrollHeight: 1000 } as unknown as HTMLElement;
    let flush: () => void = () => undefined;
    holdPlace('s', el, () => new Promise<void>((r) => { flush = r; }));
    (el as unknown as { scrollHeight: number }).scrollHeight = 1600; // 600px of older rows went in above
    flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.scrollTop).toBe(700);
  });
});

describe('ChatHistoryBar', () => {
  const mountIn = (props: Record<string, unknown>) => {
    const scroller = document.createElement('div');
    scroller.className = 'cell-messages';
    document.body.appendChild(scroller);
    return { scroller, ...render(ChatHistoryBar, { target: scroller, props }) };
  };

  it('says "Loading chat history…" while the reopen arrives', () => {
    mountIn({ sessionId: 's1', history: { ...emptyHistory(), restoring: true } });
    expect(screen.getByText('Loading chat history…')).toBeTruthy();
  });

  // t-v47uut: a reopen with no rows yet gets a large, centred crane state instead of the 11px line.
  const reopening = { ...emptyHistory(), restoring: true };
  const crane = () => document.querySelector('.reopen-loading');

  it('a reopen with no rows yet: the crane mark (112px) and "Loading chat history…", centred, not the small line', () => {
    mountIn({ sessionId: 's1', history: reopening, empty: true });
    const state = crane();
    expect(state).not.toBeNull();
    expect(state!.getAttribute('role')).toBe('status');
    expect(state!.textContent).toContain('Loading chat history…');
    expect(state!.querySelector('svg[viewBox="0 0 64 64"]')?.getAttribute('width')).toBe('112');
    expect(document.querySelector('.hist-note')).toBeNull();
  });

  it('the crane goes as soon as a row exists; an old engine still replaying keeps the small line', () => {
    mountIn({ sessionId: 's1', history: reopening, empty: false });
    expect(crane()).toBeNull();
    expect(screen.getByText('Loading chat history…').className).toContain('hist-note');
  });

  it('no crane once the restore is over (an empty chat gets the empty state), nor over the older-pages bar', () => {
    mountIn({ sessionId: 's1', history: emptyHistory(), empty: true });
    expect(crane()).toBeNull();
    cleanup();
    mountIn({ sessionId: 's1', history: { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1' }, empty: false });
    expect(crane()).toBeNull();
    expect(screen.getByRole('button', { name: /Load earlier messages/ })).toBeTruthy();
  });

  it('prefers-reduced-motion: the state is marked still and the crane carries no animation', () => {
    const media = (reduce: boolean) => vi.fn((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal('matchMedia', media(true));
    try {
      mountIn({ sessionId: 's1', history: reopening, empty: true });
      expect(crane()!.classList.contains('still')).toBe(true);
      expect(crane()!.querySelectorAll('animateTransform')).toHaveLength(0);
      cleanup();
      vi.stubGlobal('matchMedia', media(false));
      mountIn({ sessionId: 's1', history: reopening, empty: true });
      expect(crane()!.classList.contains('still')).toBe(false);
      expect(crane()!.querySelectorAll('animateTransform').length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the button asks for ONE page; disabled while a load runs', async () => {
    const h = { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1', total: 60, loadedIds: ['a'] };
    mountIn({ sessionId: 's1', history: h });
    const button = screen.getByRole('button', { name: 'Load earlier messages (59 more)' });
    await fireEvent.click(button);
    expect(posts()).toEqual([expect.objectContaining({ type: 'historyLoad', sessionId: 's1', until: 'page' })]);
    applyHistory(holder([]) as HistoryHolder, { type: 'historyLoaded', sessionId: 's1', reason: posts()[0].reason, ok: true }, nextId);
    cleanup();
    mountIn({ sessionId: 's1', history: { ...h, loading: { reason: 'scroll#1', loaded: 1, total: 60 } } });
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the scroll trigger is ignored until the reader scrolls UP (the open-at-top defect, plan section 2)', async () => {
    let hit: () => void = () => undefined;
    const observe = vi.fn((_el: Element, _root: Element, cb: () => void) => { hit = cb; return () => undefined; });
    const { scroller } = mountIn({ sessionId: 's2', history: { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1' }, observe });
    await tick();
    expect(observe).toHaveBeenCalled();
    hit(); // the observer's first report, at paint, before any pin or scroll
    expect(posts()).toEqual([]);
    scroller.scrollTop = 900; scroller.dispatchEvent(new Event('scroll')); // the pane pinning DOWN
    hit();
    expect(posts()).toEqual([]);
    scroller.scrollTop = 20; scroller.dispatchEvent(new Event('scroll')); // the reader going UP
    hit();
    expect(posts()).toEqual([expect.objectContaining({ type: 'historyLoad', sessionId: 's2', until: 'page' })]);
    applyHistory({ ...holder([]), id: 's2' }, { type: 'historyLoaded', sessionId: 's2', reason: posts()[0].reason, ok: true }, nextId);
  });

  it('shows a failed load\'s error with the button, never a spinner that never ends', () => {
    mountIn({ sessionId: 's1', history: { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1', error: 'Could not load older messages: boom' } });
    expect(screen.getByRole('alert').textContent).toMatch(/boom/);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('draws nothing on an old engine (fully loaded chat)', () => {
    const { scroller } = mountIn({ sessionId: 's1', history: emptyHistory() });
    expect(scroller.textContent?.trim()).toBe('');
  });
});

describe('find — LOADED vs ALL (owner answer Q2)', () => {
  const hit = (over: Partial<GlobalHit> = {}): GlobalHit => ({ messageId: 'm-old', partId: 'p', role: 'assistant', kind: 'text', toolCallId: null, time: 1, fromEnd: 80, snippet: 'we moved the needle today', matchStart: 13, matchLength: 6, matchesInPart: 1, ...over });

  it('picks the match inside the hit\'s own row, not the first match on screen', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="agent-row" data-engine-msg="m-new"><p>a needle here</p></div><div class="agent-row" data-engine-msg="m-old"><p>we moved the needle today</p></div>';
    const all = findMatches(root, 'needle');
    expect(pickJumpMatch(root, all, hit())).toBe(1);
  });

  it('places a user-row hit (no id on screen) by the words around the match', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>another needle</p><p>we moved the needle today</p><p>needle at the end</p>';
    const all = findMatches(root, 'needle');
    expect(pickJumpMatch(root, all, hit({ role: 'user', messageId: 'u1' }))).toBe(1);
  });

  const openBar = async (props: Record<string, unknown>) => {
    const cell = document.createElement('div');
    cell.className = 'chat-cell';
    cell.dataset.sessionId = 's1';
    cell.innerHTML = '<div class="cell-messages" data-session-id="s1"><div class="agent-row" data-engine-msg="m-new"><p>a needle here</p></div></div>';
    document.body.appendChild(cell);
    render(ChatFind, { target: cell, props: { sessionId: 's1', ...props } });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    return cell;
  };

  it('an old engine: no mode toggle, find works as today', async () => {
    await openBar({ history: emptyHistory() });
    expect(document.querySelector('.cf-mode')).toBeNull();
    expect(screen.queryByText('Load all')).toBeNull();
  });

  it('LOADED with older pages unloaded: says so and offers "Load all", which loads the whole chat', async () => {
    await openBar({ history: { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1' } });
    expect(document.querySelector('.cf-mode')?.textContent).toBe('Loaded');
    await fireEvent.click(screen.getByText('Load all'));
    expect(posts()).toEqual([expect.objectContaining({ type: 'historyLoad', sessionId: 's1', until: 'all' })]);
  });

  it('ALL: asks the engine, then loads the page that holds an unloaded hit before landing on it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const history = { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1', loadedIds: ['m-new'] };
      const cell = await openBar({ history });
      await fireEvent.click(document.querySelector('.cf-mode')!);
      const input = document.querySelector<HTMLInputElement>('.cf-input')!;
      input.value = 'needle';
      await fireEvent.input(input);
      await vi.advanceTimersByTimeAsync(350);
      expect(posts()).toContainEqual({ type: 'historySearch', sessionId: 's1', query: 'needle' });
      post({ type: 'historySearchResult', sessionId: 's1', query: 'needle', hits: [hit()], done: false, cursor: 'k2', scanned: 2000 });
      await tick();
      expect(document.querySelector('.cf-count')?.textContent?.trim()).toBe('1/1+');
      const load = posts().find((p) => p.type === 'historyLoad');
      expect(load).toMatchObject({ until: { messageId: 'm-old' } });
      // The page lands above the loaded rows; then the load ends with the message found.
      cell.querySelector('.cell-messages')!.insertAdjacentHTML('afterbegin', '<div class="agent-row" data-engine-msg="m-old"><p>we moved the needle today</p></div>');
      const seen: Element[] = [];
      Element.prototype.scrollIntoView = function () { seen.push(this as Element); };
      applyHistory({ ...holder([]), id: 's1', history }, { type: 'historyLoaded', sessionId: 's1', reason: load!.reason, ok: true, found: true }, nextId);
      await settle();
      expect(seen.at(-1)?.closest('[data-engine-msg]')?.getAttribute('data-engine-msg')).toBe('m-old');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ALL on an engine without the search says so, not "0 matches"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openBar({ history: { ...emptyHistory(), lazy: true, hasMore: true, cursor: 'c1' } });
      await fireEvent.click(document.querySelector('.cf-mode')!);
      const input = document.querySelector<HTMLInputElement>('.cf-input')!;
      input.value = 'needle';
      await fireEvent.input(input);
      await vi.advanceTimersByTimeAsync(350);
      post({ type: 'historySearchResult', sessionId: 's1', query: 'needle', hits: [], done: true, cursor: null, error: 'Search of the whole chat needs a newer engine.', unsupported: true });
      await tick();
      expect(screen.getByRole('status').textContent).toMatch(/newer engine/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatPane — a reopened chat, end to end through the host posts', () => {
  // ChatPane never unbinds its window listener (newChatStarting.test.ts's note), so every case
  // opens its own chat id: a pane left over from an earlier case must not hear this one.
  let S = '';
  let n = 0;
  const open = async () => {
    S = `lazy-pane-${++n}`;
    render(ChatPane);
    post({ type: 'sessionCreated', sessionId: S, sessionNumber: 1, agentName: 'Tsuru', agentArt: null, starting: true });
    post({ type: 'historyState', sessionId: S, restoring: true, lazy: false, cursor: null, hasMore: false, total: null, latestUser: null, loadedIds: [], roster: [] });
    await settle();
  };
  const text = () => document.querySelector(`.cell-messages[data-session-id="${S}"]`)?.textContent ?? '';

  it('"Loading chat history…" first, then the newest page, then "Load earlier messages (N more)"', async () => {
    await open();
    expect(text()).toContain('Loading chat history…');
    expect(document.querySelector('textarea')?.getAttribute('placeholder') ?? '').toMatch(/^Loading chat/);
    post({ type: 'echoUser', sessionId: S, text: 'newest question', replay: true });
    post({ type: 'agentText', sessionId: S, text: 'newest answer', messageId: 'e9' });
    post(windowState({ sessionId: S, total: 120 }));
    post({ type: 'sessionStarting', sessionId: S, starting: false });
    await settle();
    expect(text()).not.toContain('Loading chat history…');
    const button = screen.getByRole('button', { name: 'Load earlier messages (118 more)' });
    await fireEvent.click(button);
    const ask = posts().find((p) => p.type === 'historyLoad');
    expect(ask).toMatchObject({ sessionId: S, until: 'page' });
    post({ type: 'historyProgress', sessionId: S, reason: ask!.reason, loaded: 2, total: 120 });
    post({ type: 'historyPage', sessionId: S, messages: [{ kind: 'user', text: 'older question', timestamp: 1 }, { kind: 'agent', text: 'older answer', timestamp: 2, messageId: 'e1' }], messageIds: ['o1', 'o2'], cursor: 'c2', hasMore: true, total: 120, loaded: 4 });
    post({ type: 'historyLoaded', sessionId: S, reason: ask!.reason, ok: true });
    await settle();
    const t = text();
    expect(t.indexOf('older question')).toBeGreaterThan(-1);
    expect(t.indexOf('older question')).toBeLessThan(t.indexOf('older answer'));
    // lastIndexOf: the pinned mirror at the top of the scroller repeats the newest question.
    expect(t.indexOf('older answer')).toBeLessThan(t.lastIndexOf('newest question'));
    expect(screen.getByRole('button', { name: 'Load earlier messages (116 more)' })).toBeTruthy();
    // The older agent row carries its rewind anchor like a live one.
    expect(document.querySelector('[data-engine-msg="e1"] .rewind-btn')).not.toBeNull();
  });

  it('t-v47uut: the pane opens on the crane loading state, and the first row replaces it before the window lands', async () => {
    await open();
    const cell = () => document.querySelector(`.cell-messages[data-session-id="${S}"]`)!;
    expect(cell().querySelector('.reopen-loading')?.textContent).toContain('Loading chat history…');
    expect(cell().querySelector('.chat-empty')).toBeNull(); // one centred state, never two
    post({ type: 'echoUser', sessionId: S, text: 'newest question', replay: true });
    await settle();
    expect(cell().querySelector('.reopen-loading')).toBeNull();
    expect(text()).toContain('newest question');
  });

  it('export with older pages unloaded: loads them all, THEN exports every row, oldest first (plan F2)', async () => {
    await open();
    post({ type: 'echoUser', sessionId: S, text: 'newest question', replay: true });
    post(windowState({ sessionId: S }));
    await settle();
    await fireEvent.click(document.querySelector('.export-btn')!);
    expect(posts().some((p) => p.type === 'exportSession')).toBe(false);
    const ask = posts().find((p) => p.type === 'historyLoad')!;
    expect(ask).toMatchObject({ until: 'all' });
    post({ type: 'historyPage', sessionId: S, messages: [{ kind: 'user', text: 'first question', timestamp: 1 }], messageIds: ['o1'], cursor: null, hasMore: false, total: 3, loaded: 3 });
    post({ type: 'historyLoaded', sessionId: S, reason: ask.reason, ok: true });
    await settle();
    const exported = posts().find((p) => p.type === 'exportSession') as { messages: Array<{ text: string }> } | undefined;
    expect(exported?.messages.map((m) => m.text)).toEqual(['first question', 'newest question']);
  });

  it('an OLD engine (no window): no "Load earlier", export runs at once — today\'s behaviour (contract 6)', async () => {
    await open();
    post({ type: 'echoUser', sessionId: S, text: 'only question', replay: true });
    post({ type: 'sessionStarting', sessionId: S, starting: false });
    post({ type: 'historyState', sessionId: S, restoring: false, lazy: false, cursor: null, hasMore: false, total: null, latestUser: null, loadedIds: [], roster: [] });
    await settle();
    expect(text()).not.toContain('Loading chat history…');
    expect(screen.queryByRole('button', { name: /Load earlier/ })).toBeNull();
    await fireEvent.click(document.querySelector('.export-btn')!);
    expect(posts().some((p) => p.type === 'historyLoad')).toBe(false);
    expect(posts().find((p) => p.type === 'exportSession')).toBeTruthy();
  });

  it('a sub-agent spawned above the page: its live stream lands on the roster card, not on the floor (plan F8)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await open();
      post(windowState({ sessionId: S, roster: [rosterRow({ id: 'kid-off', title: 'survey the logs' })] }));
      post({ type: 'subagentChunk', sessionId: S, childSessionId: 'kid-off', text: 'reading the logs' });
      post({ type: 'openSubagentDrawer', sessionId: S });
      await settle();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('dropped sub-agent'))).toBe(false);
      expect(document.body.textContent).toContain('survey the logs');
      // The row's activity tail shows once the row is unfolded (SubagentRow.svelte).
      const unfold = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '▸');
      await fireEvent.click(unfold!);
      expect(document.body.textContent).toContain('reading the logs');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mirror drift guards (a webview leaf re-declares what the host owns)', () => {
  const fields = (file: string, iface: string) => {
    const src = readFileSync(path.join(__dirname, file), 'utf8');
    const body = src.slice(src.indexOf(`export interface ${iface} {`));
    const block = body.slice(0, body.indexOf('\n}'));
    return [...block.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]).sort();
  };

  it('RosterRow: src/acpHistory.ts and panes/chatHistory.ts agree', () => {
    expect(fields('../panes/chatHistory.ts', 'RosterRow')).toEqual(fields('../../../src/acpHistory.ts', 'RosterRow'));
  });

  it('SearchHit / GlobalHit agree', () => {
    expect(fields('../components/chatFindGlobal.ts', 'GlobalHit')).toEqual(fields('../../../src/acpHistory.ts', 'SearchHit'));
  });
});
