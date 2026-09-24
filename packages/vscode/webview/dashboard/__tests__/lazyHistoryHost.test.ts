// t-ucnp7t — lazy loading, HOST side, against the engine lane's wire contract
// (reports/lazy_loading_plan_2026-09-24/wire_contract.md). The engine half is not merged, so the
// engine is a fake that speaks the contract: frames through the REAL acpClient decode, replies of
// the contract's shapes.
//
// The frames are not invented: they are the captured `session/load` replay in
// reloadReplay.fixture.json (see reloadReplay.test.ts for its provenance), re-sent with the page
// tag the contract adds. That is the one change the contract makes to a frame (section 2.2).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { establishSession, type SessionConnection } from '../../../src/acpFork';
import type { HistoryPageReply, HistoryWindow, SubagentRoster } from '../../../src/acpHistory';
import {
  adoptRoster, adoptWindow, historyStatePost, loadHistory, logAgentChunk, logUserChunk, messageCountOf, newHistory,
  pageCollector, searchHistory, settleRestore, untilOf, historyUnavailable, type HistoryDeps,
} from '../../../src/dashboard/historyHost';
import { logToolCall, logToolResult, type SessionMessage } from '../../../src/dashboard/sessionLog';
import { replaySessionTo } from '../../../src/dashboard/replaySession';

type Notification = { sessionId: string; update: Record<string, unknown> };
const REPLAY: Notification[] = JSON.parse(readFileSync(path.join(__dirname, 'reloadReplay.fixture.json'), 'utf8'));
const TRANSCRIPT = REPLAY.filter((n) => n.update.sessionUpdate !== 'session_info_update');

function handlers(over: Partial<AcpEventHandlers> = {}): AcpEventHandlers {
  return {
    onAgentMessageChunk: vi.fn(), onAgentImageChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallUpdate: vi.fn(),
    onPermissionRequest: vi.fn(), onAvailableCommands: vi.fn(), onPlanStatus: vi.fn(), onPlanReady: vi.fn(),
    onBestOfNComplete: vi.fn(), onTaskShape: vi.fn(), onTodoUpdate: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
    ...over,
  };
}

const impl = (client: AcpClient) =>
  (client as unknown as { buildClientImpl: () => { sessionUpdate: (p: unknown) => Promise<void>; extNotification: (m: string, p: unknown) => Promise<void> } }).buildClientImpl();

const tagged = (n: Notification, pageId: string): Notification =>
  ({ ...n, update: { ...n.update, _meta: { ...((n.update._meta as object) ?? {}), origami_page: pageId } } });

/** The live log the way DashboardPanel.ts writes it (its handlers call these same writers). */
function liveLogHandlers(log: SessionMessage[]): AcpEventHandlers {
  return handlers({
    onAgentMessageChunk: (text) => logAgentChunk(log, text),
    onUserMessageChunk: (text) => logUserChunk(log, text),
    onToolCallStart: (args) => { logToolCall(log, args as unknown as Record<string, unknown>); },
    onToolCallUpdate: (args) => logToolResult(log, args as unknown as Record<string, unknown>),
  });
}

const withoutTime = (log: SessionMessage[]) => log.map(({ timestamp: _t, messageId: _m, ...rest }) => rest);

describe('acpClient — a page frame is history, never a live event (contract 2.4)', () => {
  it('routes every tagged frame to its page and none to the live handlers', async () => {
    const live = handlers();
    const client = new AcpClient(live);
    const collector = pageCollector();
    (client as unknown as { pageSinks: Map<string, AcpEventHandlers> }).pageSinks.set('p1', collector.handlers);
    for (const n of TRANSCRIPT) await impl(client).sessionUpdate(tagged(n, 'p1'));
    expect(live.onToolCallStart).not.toHaveBeenCalled();
    expect(live.onToolCallUpdate).not.toHaveBeenCalled();
    expect(live.onUserMessageChunk ?? vi.fn()).not.toHaveBeenCalled();
    expect(collector.log.length).toBeGreaterThan(0);
  });

  it('builds the SAME log from a page as the restore builds from the same messages (plan K4)', async () => {
    const liveLog: SessionMessage[] = [];
    const liveClient = new AcpClient(liveLogHandlers(liveLog));
    for (const n of TRANSCRIPT) await impl(liveClient).sessionUpdate(n);

    const pageClient = new AcpClient(handlers());
    const collector = pageCollector();
    (pageClient as unknown as { pageSinks: Map<string, AcpEventHandlers> }).pageSinks.set('p1', collector.handlers);
    for (const n of TRANSCRIPT) await impl(pageClient).sessionUpdate(tagged(n, 'p1'));

    expect(liveLog.map((e) => e.kind)).toEqual(['user', 'tool', 'agent']);
    expect(withoutTime(collector.log)).toEqual(withoutTime(liveLog));
  });

  it('keeps reasoning and an image on an older page, the way the pane drew them live (plan K4)', async () => {
    const client = new AcpClient(handlers());
    const collector = pageCollector();
    (client as unknown as { pageSinks: Map<string, AcpEventHandlers> }).pageSinks.set('p1', collector.handlers);
    const frame = (update: Record<string, unknown>) => ({ sessionId: 's', update: { ...update, _meta: { origami_page: 'p1' } } });
    await impl(client).sessionUpdate(frame({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weigh ' } }));
    await impl(client).sessionUpdate(frame({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'options' } }));
    await impl(client).sessionUpdate(frame({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }));
    await impl(client).sessionUpdate(frame({ sessionUpdate: 'agent_message_chunk', messageId: 'm7', content: { type: 'text', text: 'here it is' } }));
    expect(collector.log.map((e) => [e.kind, e.text])).toEqual([
      ['thought', 'weigh options'],
      ['agent', '![image](data:image/png;base64,AAAA)'],
      ['agent', 'here it is'],
    ]);
  });

  it('keeps the agent message id on a page entry: the rewind anchor and the find jump target', async () => {
    const client = new AcpClient(handlers());
    const collector = pageCollector();
    (client as unknown as { pageSinks: Map<string, AcpEventHandlers> }).pageSinks.set('p1', collector.handlers);
    for (const n of TRANSCRIPT) await impl(client).sessionUpdate(tagged(n, 'p1'));
    const agentFrame = TRANSCRIPT.find((n) => n.update.sessionUpdate === 'agent_message_chunk' && n.update.messageId);
    expect(collector.log.find((e) => e.kind === 'agent')?.messageId).toBe(agentFrame?.update.messageId);
  });

  it('drops a tagged frame no page asked for instead of drawing it live', async () => {
    const live = handlers();
    const client = new AcpClient(live);
    const agent = TRANSCRIPT.find((n) => n.update.sessionUpdate === 'agent_message_chunk')!;
    await impl(client).sessionUpdate(tagged(agent, 'nobody'));
    expect(live.onAgentMessageChunk).not.toHaveBeenCalled();
    // The same frame untagged is live, so the drop is the tag's doing.
    await impl(client).sessionUpdate(agent);
    expect(live.onAgentMessageChunk).toHaveBeenCalledTimes(1);
  });

  it('an old todowrite frame on a page does not replace the live todo strip', async () => {
    const live = handlers();
    const client = new AcpClient(live);
    const collector = pageCollector();
    (client as unknown as { pageSinks: Map<string, AcpEventHandlers> }).pageSinks.set('p1', collector.handlers);
    const todo = { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'todowrite', rawInput: { todos: [{ content: 'old', status: 'completed', priority: 'low' }] }, _meta: { origami_page: 'p1' } } };
    await impl(client).sessionUpdate(todo);
    expect(live.onTodoUpdate).not.toHaveBeenCalled();
    expect(collector.log).toEqual([]);
  });

  it('historyPage sends the contract request, collects the frames that precede the reply, and forgets the page after', async () => {
    const client = new AcpClient(handlers());
    const extMethod = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      // The engine sends the page's frames BEFORE its reply on the one stream (contract 2.2).
      for (const n of TRANSCRIPT) await impl(client).sessionUpdate(tagged(n, String(params.pageId)));
      return { sessionId: 'ses_1', pageId: params.pageId, cursor: 'c2', hasMore: true, messageIds: ['m1', 'm2'], messages: 2, totalMessages: 90, capped: false };
    });
    (client as unknown as { connection: unknown }).connection = { extMethod };
    const collector = pageCollector();
    const reply = await client.historyPage({ sessionId: 'ses_1', before: 'c1', pageId: 'older-1' }, collector.handlers);
    expect(extMethod).toHaveBeenCalledWith('_history_page', { sessionId: 'ses_1', before: 'c1', pageId: 'older-1' });
    expect(reply).toMatchObject({ cursor: 'c2', hasMore: true, messageIds: ['m1', 'm2'], totalMessages: 90 });
    expect(collector.log.map((e) => e.kind)).toEqual(['user', 'tool', 'agent']);
    expect((client as unknown as { pageSinks: Map<string, unknown> }).pageSinks.size).toBe(0);
  });
});

describe('acpClient — the two new notifications', () => {
  const WINDOW = { sessionId: 'ses_1', cursor: 'c1', hasMore: true, messageIds: ['m9'], totalMessages: 870, latestUser: { messageId: 'mu', text: 'why' }, pageSize: 50, byteCap: 16777216, capped: false };

  it('origami/historyWindow and origami/subagentRoster reach their handlers, decoded', async () => {
    const onHistoryWindow = vi.fn();
    const onSubagentRoster = vi.fn();
    const client = new AcpClient(handlers({ onHistoryWindow, onSubagentRoster }));
    await impl(client).extNotification('_origami/historyWindow', WINDOW);
    await impl(client).extNotification('_origami/subagentRoster', { sessionId: 'ses_1', rows: [{ id: 'kid', parentId: 'ses_1', depth: 1, title: 'scan', agent: 'explore', status: 'running', created: 5, updated: 6, tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.1, steps: null, context: null }], truncated: false });
    expect(onHistoryWindow).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'c1', hasMore: true, totalMessages: 870, latestUser: { messageId: 'mu', text: 'why' } }));
    expect(onSubagentRoster.mock.calls[0][0].rows[0]).toMatchObject({ id: 'kid', status: 'running', steps: null });
  });

  it('a hasMore with no cursor is read as the start of the chat (a button that answers nothing is worse)', async () => {
    const onHistoryWindow = vi.fn();
    const client = new AcpClient(handlers({ onHistoryWindow }));
    await impl(client).extNotification('_origami/historyWindow', { ...WINDOW, cursor: null });
    expect(onHistoryWindow.mock.calls[0][0]).toMatchObject({ hasMore: false, cursor: null });
  });

  it('a malformed window is dropped, not guessed', async () => {
    const onHistoryWindow = vi.fn();
    const client = new AcpClient(handlers({ onHistoryWindow }));
    await impl(client).extNotification('_origami/historyWindow', { cursor: 'c1' });
    expect(onHistoryWindow).not.toHaveBeenCalled();
  });
});

describe('establishSession — the window on the load and fork responses (plan F14)', () => {
  const win = { sessionId: 'ses_1', cursor: 'c1', hasMore: true, messageIds: ['m1'], totalMessages: 3, latestUser: null, capped: false };
  const conn = (resp: unknown) => ({
    unstable_forkSession: vi.fn(async () => ({ sessionId: 'ses_fork', ...(resp as object) })),
    loadSession: vi.fn(async () => resp),
    newSession: vi.fn(async () => ({ sessionId: 'ses_new' })),
  }) as unknown as SessionConnection;

  it('a new engine: load and fork both carry the window', async () => {
    const withMeta = { configOptions: [], _meta: { origami_history: win } };
    expect((await establishSession(conn(withMeta), { cwd: '/w', loadSessionId: 'ses_1' })).history).toMatchObject({ cursor: 'c1', hasMore: true });
    expect((await establishSession(conn(withMeta), { cwd: '/w', forkFromSessionId: 'ses_1' })).history).toMatchObject({ cursor: 'c1' });
  });

  it('an old engine: no `history` key at all, so the caller keeps today\'s behaviour', async () => {
    const result = await establishSession(conn({ configOptions: [] }), { cwd: '/w', loadSessionId: 'ses_1' });
    expect('history' in result).toBe(false);
  });
});

/** A fake engine for `loadHistory`: pages of the contract's shape, newest first, each sending its
 *  frames into the sink before answering. `pages[0]` is the page older than the restore. */
function fakeEngine(pages: Array<{ log: Array<[string, string]>; ids: string[] }>, total = 200) {
  let i = 0;
  let inFlight = 0;
  let overlapped = false;
  const historyPage = vi.fn(async (params: { before?: string; pageId: string }, sink: AcpEventHandlers): Promise<HistoryPageReply> => {
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 1));
    const page = pages[i];
    i += 1;
    for (const [kind, text] of page.log) {
      if (kind === 'user') sink.onUserMessageChunk?.(text);
      else sink.onAgentMessageChunk(text, `id-${text}`);
    }
    inFlight -= 1;
    const hasMore = i < pages.length;
    return { sessionId: 'ses_1', pageId: params.pageId, cursor: hasMore ? `c${i + 1}` : null, hasMore, messageIds: page.ids, messages: page.ids.length, totalMessages: total, capped: false };
  });
  return { client: { historyPage, historySearch: vi.fn() }, historyPage, overlapped: () => overlapped };
}

function restored(win: Partial<HistoryWindow> = {}) {
  const h = newHistory();
  adoptWindow(h, { sessionId: 'ses_1', cursor: 'c1', hasMore: true, messageIds: ['n1', 'n2'], totalMessages: 200, latestUser: null, capped: false, ...win });
  return h;
}

describe('loadHistory — older pages go to olderLog, never into messageLog (plan 3.5, F13)', () => {
  it('one page: prepended in order, posted as historyPage, cursor advanced, messageLog untouched', async () => {
    const h = restored();
    const messageLog: SessionMessage[] = [{ kind: 'user', text: 'newest', timestamp: 1 }];
    const before = JSON.stringify(messageLog);
    const posts: Array<Record<string, unknown>> = [];
    const engine = fakeEngine([{ log: [['user', 'q1'], ['agent', 'a1']], ids: ['o1', 'o2'] }, { log: [['user', 'q0']], ids: ['o0'] }]);
    await loadHistory(h, 'session-1', { engineSessionId: 'ses_1', client: engine.client, post: (m) => void posts.push(m) } as HistoryDeps, 'page', 'scroll');

    expect(engine.historyPage).toHaveBeenCalledTimes(1);
    expect(engine.historyPage.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_1', before: 'c1' });
    expect(h.olderLog.map((e) => e.text)).toEqual(['q1', 'a1']);
    expect(h.cursor).toBe('c2');
    expect(h.loadedIds).toEqual(['o1', 'o2', 'n1', 'n2']);
    expect(JSON.stringify(messageLog)).toBe(before);
    const page = posts.find((m) => m.type === 'historyPage')!;
    expect(page).toMatchObject({ sessionId: 'session-1', cursor: 'c2', hasMore: true, total: 200 });
    expect((page.messages as SessionMessage[]).map((e) => e.text)).toEqual(['q1', 'a1']);
    expect(posts.at(-1)).toMatchObject({ type: 'historyLoaded', reason: 'scroll', ok: true });
  });

  it('"all" loops one call at a time to the start, with progress before each page (export, plan 3.6)', async () => {
    const h = restored();
    const posts: Array<Record<string, unknown>> = [];
    const report = vi.fn();
    const engine = fakeEngine([{ log: [['agent', 'b']], ids: ['o2'] }, { log: [['agent', 'a']], ids: ['o1'] }], 4);
    await loadHistory(h, 'session-1', { engineSessionId: 'ses_1', client: engine.client, post: (m) => void posts.push(m), report }, 'all', 'export');
    expect(engine.historyPage).toHaveBeenCalledTimes(2);
    expect(h.hasMore).toBe(false);
    expect(h.olderLog.map((e) => e.text)).toEqual(['a', 'b']);
    expect(posts.filter((m) => m.type === 'historyProgress').map((m) => m.loaded)).toEqual([2, 3]);
    expect(report).toHaveBeenCalledWith(2, 200);
    expect(posts.at(-1)).toMatchObject({ type: 'historyLoaded', reason: 'export', ok: true });
  });

  it('a named message: stops on the page that holds it (global find jump, contract 5.5)', async () => {
    const h = restored();
    const posts: Array<Record<string, unknown>> = [];
    const engine = fakeEngine([{ log: [['agent', 'x']], ids: ['o3'] }, { log: [['agent', 'y']], ids: ['o2'] }, { log: [['agent', 'z']], ids: ['o1'] }]);
    await loadHistory(h, 's', { engineSessionId: 'ses_1', client: engine.client, post: (m) => void posts.push(m) }, { messageId: 'o2' }, 'find');
    expect(engine.historyPage).toHaveBeenCalledTimes(2);
    expect(posts.at(-1)).toMatchObject({ type: 'historyLoaded', found: true });
  });

  it('a named message that no page holds ends with found:false at the start of the chat (it was deleted)', async () => {
    const h = restored();
    const posts: Array<Record<string, unknown>> = [];
    const engine = fakeEngine([{ log: [['agent', 'x']], ids: ['o1'] }]);
    await loadHistory(h, 's', { engineSessionId: 'ses_1', client: engine.client, post: (m) => void posts.push(m) }, { messageId: 'gone' }, 'find');
    expect(posts.at(-1)).toMatchObject({ type: 'historyLoaded', ok: true, found: false });
  });

  it('"user": stops on the page that holds a user message (rewind whose question is above the page, plan F4)', async () => {
    const h = restored();
    const engine = fakeEngine([{ log: [['agent', 'tail of a long turn']], ids: ['o2'] }, { log: [['user', 'the question'], ['agent', 'start']], ids: ['o1'] }, { log: [['user', 'older']], ids: ['o0'] }]);
    await loadHistory(h, 's', { engineSessionId: 'ses_1', client: engine.client, post: () => undefined }, 'user', 'rewind');
    expect(engine.historyPage).toHaveBeenCalledTimes(2);
    expect(h.olderLog[0]).toMatchObject({ kind: 'user', text: 'the question' });
  });

  it('two requests never overlap on the engine: the second waits for the first (contract 3)', async () => {
    const h = restored();
    const engine = fakeEngine([{ log: [['agent', 'b']], ids: ['o2'] }, { log: [['agent', 'a']], ids: ['o1'] }]);
    const deps = { engineSessionId: 'ses_1', client: engine.client, post: () => undefined };
    await Promise.all([loadHistory(h, 's', deps, 'page', 'scroll'), loadHistory(h, 's', deps, 'page', 'scroll')]);
    expect(engine.overlapped()).toBe(false);
    expect(engine.historyPage.mock.calls.map((c) => c[0].before)).toEqual(['c1', 'c2']);
    expect(h.olderLog.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('an old engine that answers -32601 ends with a visible error, never "Loading…" for ever', async () => {
    const h = restored();
    const posts: Array<Record<string, unknown>> = [];
    const client = { historyPage: vi.fn(async () => { throw new Error('Method not found (-32601)'); }), historySearch: vi.fn() };
    await loadHistory(h, 's', { engineSessionId: 'ses_1', client, post: (m) => void posts.push(m) }, 'page', 'scroll');
    expect(posts.at(-1)).toMatchObject({ type: 'historyLoaded', ok: false });
    expect(String(posts.at(-1)?.error)).toMatch(/Update Origami/);
    expect(h.hasMore).toBe(true);
  });

  it('nothing older: no engine call at all', async () => {
    const h = restored({ hasMore: false, cursor: null });
    const engine = fakeEngine([]);
    await loadHistory(h, 's', { engineSessionId: 'ses_1', client: engine.client, post: () => undefined }, 'all', 'export');
    expect(engine.historyPage).not.toHaveBeenCalled();
  });
});

describe('the restore, new engine vs old engine (contract 6)', () => {
  it('an old engine sends no window: settling marks the chat fully loaded, as today', () => {
    const h = newHistory();
    expect(h.restoring).toBe(true);
    expect(settleRestore(h, null)).toBe(true);
    expect(h).toMatchObject({ restoring: false, lazy: false, hasMore: false });
    expect(historyStatePost('session-1', h)).toMatchObject({ type: 'historyState', restoring: false, lazy: false, hasMore: false });
  });

  it('the response copy is adopted when the notification never came', () => {
    const h = newHistory();
    settleRestore(h, { sessionId: 's', cursor: 'c1', hasMore: true, messageIds: [], totalMessages: 9, latestUser: null, capped: false });
    expect(h).toMatchObject({ lazy: true, hasMore: true, cursor: 'c1', totalMessages: 9 });
  });

  it('after the notification, settling changes nothing and posts nothing new', () => {
    const h = restored();
    expect(settleRestore(h, null)).toBe(false);
    expect(h.hasMore).toBe(true);
  });
});

describe('roster and counts', () => {
  const roster = (rows: Array<Partial<SubagentRoster['rows'][number]>>): SubagentRoster => ({
    sessionId: 'ses_1', truncated: false,
    rows: rows.map((r, i) => ({ id: `k${i}`, parentId: 'ses_1', depth: 1, title: '', agent: null, status: 'idle', created: i, updated: i, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, steps: null, context: null, ...r })),
  });

  it('seeds the ring from running DIRECT children, and clears an idle one (plan F9)', () => {
    const running = new Set(['k1']);
    const h = newHistory();
    expect(adoptRoster(h, roster([{ status: 'running' }, { status: 'idle' }, { status: 'running', depth: 2 }]), running)).toBe(true);
    expect([...running]).toEqual(['k0']);
  });

  it('the message count is the chat\'s, not the page\'s (plan F10)', () => {
    expect(messageCountOf(50, restored({ totalMessages: 870 }))).toBe(870);
    expect(messageCountOf(12, undefined)).toBe(12);
  });

  it('untilOf reads the pane\'s request fail-closed', () => {
    expect(untilOf('all')).toBe('all');
    expect(untilOf({ messageId: 'm1' })).toEqual({ messageId: 'm1' });
    expect(untilOf(42)).toBe('page');
  });
});

describe('global find host call (contract 5)', () => {
  it('forwards hits, and says "needs a newer engine" on -32601 rather than 0 matches', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const hit = { messageId: 'm1', partId: 'p', role: 'assistant', kind: 'text', toolCallId: null, time: 1, fromEnd: 60, snippet: 'the needle', matchStart: 4, matchLength: 6, matchesInPart: 1 };
    const ok = { historyPage: vi.fn(), historySearch: vi.fn(async () => ({ sessionId: 'ses_1', query: 'needle', hits: [hit as never], scanned: 870, done: true, cursor: null })) };
    await searchHistory('session-1', { engineSessionId: 'ses_1', client: ok, post: (m) => void posts.push(m) }, 'needle');
    expect(ok.historySearch).toHaveBeenCalledWith({ sessionId: 'ses_1', query: 'needle' });
    expect(posts[0]).toMatchObject({ type: 'historySearchResult', sessionId: 'session-1', done: true, hits: [hit] });

    const old = { historyPage: vi.fn(), historySearch: vi.fn(async () => { throw new Error('Method not found'); }) };
    await searchHistory('session-1', { engineSessionId: 'ses_1', client: old, post: (m) => void posts.push(m) }, 'needle');
    expect(posts[1]).toMatchObject({ unsupported: true, hits: [] });
  });
});

describe('a request the host cannot serve still gets an END (the pane never waits for ever)', () => {
  it('a load ends failed with its own reason; a search ends done with the reason', () => {
    expect(historyUnavailable('session-1', { type: 'historyLoad', reason: 'export#3' })).toMatchObject({ type: 'historyLoaded', sessionId: 'session-1', reason: 'export#3', ok: false });
    expect(historyUnavailable('session-1', { type: 'historySearch', query: 'x' })).toMatchObject({ type: 'historySearchResult', query: 'x', hits: [], done: true });
  });
});

describe('late tab (plan 3.5): the attach burst carries the older pages and the cursor', () => {
  const ctx = { remote: false, compress: false, wsPath: null, cwd: 'C:/ws', contextWindow: 1000, activity: {}, dismissedSubagents: [] };

  it('a tab gets restoreMessages (the window) and then historyState with the older rows', () => {
    const h = restored();
    h.olderLog = [{ kind: 'user', text: 'older q', timestamp: 1 }];
    const sent: Array<Record<string, unknown>> = [];
    replaySessionTo((m) => void sent.push(m as Record<string, unknown>), { id: 'session-1', number: 1, agentName: 'Tsuru', messageLog: [{ kind: 'user', text: 'new q', timestamp: 2 }], history: h }, ctx);
    const types = sent.map((m) => m.type);
    expect(types.indexOf('restoreMessages')).toBeLessThan(types.indexOf('historyState'));
    expect(sent.find((m) => m.type === 'historyState')).toMatchObject({ cursor: 'c1', hasMore: true, older: [{ text: 'older q' }] });
  });

  it('the phone keeps its tail only: no historyState', () => {
    const sent: Array<Record<string, unknown>> = [];
    replaySessionTo((m) => void sent.push(m as Record<string, unknown>), { id: 'session-1', number: 1, agentName: 'Tsuru', messageLog: [], history: restored() }, { ...ctx, remote: true });
    expect(sent.some((m) => m.type === 'historyState')).toBe(false);
  });
});
