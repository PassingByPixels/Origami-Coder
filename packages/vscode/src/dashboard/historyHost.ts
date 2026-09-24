// historyHost.ts — the HOST half of lazy loading (t-ucnp7t). Plan sections 3.5 and 3.6; the wire is
// `reports/lazy_loading_plan_2026-09-24/wire_contract.md`.
//
// What a reopened chat holds on this side:
//   - `Session.messageLog` stays the window from the restore onward, APPEND ONLY. Every cursor that
//     counts positions in it (the phone's `since`, the loop boundary, the pane's `restoredAt`) keeps
//     its meaning, because nothing is ever put in front of it (plan F13).
//   - `HostHistory.olderLog` holds the older pages, PREPEND ONLY, built from the page's frames by the
//     same log writers the live stream uses (`pageCollector`), so an old message reads the same
//     whether it came in on the restore or on a scroll-up (plan K4).
//
// An old engine sends no window: `settleRestore` then marks the chat fully loaded, which is today's
// behaviour exactly (contract section 6).
//
// No `vscode` import: DashboardPanel passes what it needs as `HistoryDeps`, so every rule here runs
// under vitest against a fake client.

import type { AcpEventHandlers } from '../acpClient';
import type { HistoryPageReply, HistorySearchReply, HistoryWindow, RosterRow, SubagentRoster } from '../acpHistory';
import { peerLogEntry } from './peerMessages';
import { logStreamDrop, logSubagentDone, logSubagentTokens, logToolCall, logToolResult, type SessionMessage } from './sessionLog';

export interface HostHistory {
  /** Set at recall/fork, cleared by the window (new engine) or by the start settling (old engine). */
  restoring: boolean;
  /** True once an engine window arrived: this chat pages. False = the whole chat was replayed. */
  lazy: boolean;
  /** The older pages, oldest first. Prepend only. */
  olderLog: SessionMessage[];
  cursor: string | null;
  hasMore: boolean;
  totalMessages: number | null;
  latestUser: { messageId: string; text: string } | null;
  /** Every engine message id on screen: the restore's page, then each older page. Global find
   *  asks it "is this hit loaded yet" (contract 5.5). */
  loadedIds: string[];
  /** Direct and deeper sub-agents, from session rows (contract 4). */
  roster: RosterRow[];
  /** One engine call at a time for this chat (contract 3): every load chains on this. */
  queue: Promise<void>;
  /** Counter behind each `history_page` pageId (unique per chat). */
  seq: number;
}

export function newHistory(): HostHistory {
  return { restoring: true, lazy: false, olderLog: [], cursor: null, hasMore: false, totalMessages: null, latestUser: null, loadedIds: [], roster: [], queue: Promise.resolve(), seq: 0 };
}

/** The one `historyState` post: the attach burst (`withOlder`, a late tab has none of it yet) and
 *  every change of state after it (without the rows, which went out as `historyPage`). */
export function historyStatePost(sessionId: string, h: HostHistory, withOlder = false): Record<string, unknown> {
  return {
    type: 'historyState', sessionId,
    restoring: h.restoring, lazy: h.lazy, cursor: h.cursor, hasMore: h.hasMore,
    total: h.totalMessages, latestUser: h.latestUser, loadedIds: h.loadedIds, roster: h.roster,
    ...(withOlder && h.olderLog.length > 0 ? { older: h.olderLog } : {}),
  };
}

/** Adopt the engine's window. The notification and the response's `_meta` copy are equal
 *  (contract 1.3), so a second adopt of the same restore changes nothing. */
export function adoptWindow(h: HostHistory, win: HistoryWindow): void {
  if (h.lazy) return;
  h.restoring = false;
  h.lazy = true;
  h.cursor = win.cursor;
  h.hasMore = win.hasMore;
  h.totalMessages = win.totalMessages;
  h.latestUser = win.latestUser;
  h.loadedIds = [...win.messageIds];
}

/** The start settled (resolved or refused). `win` is the response's own copy of the window, for
 *  the case where the notification never came. No window at all = an old engine that replayed the
 *  whole chat, or a failed start: either way nothing is left to load. True when anything changed. */
export function settleRestore(h: HostHistory, win?: HistoryWindow | null): boolean {
  if (!h.restoring) return false;
  if (win) adoptWindow(h, win);
  h.restoring = false;
  if (!h.lazy) { h.hasMore = false; h.cursor = null; }
  return true;
}

/** The roster rows, and the sidebar ring's running set seeded from them (plan F9): a running
 *  child whose card is above the loaded page is still out. Only DIRECT children count, the same
 *  set the ring tracks from `task` cards. Returns true when the running set changed. */
export function adoptRoster(h: HostHistory, roster: SubagentRoster, running: Set<string>): boolean {
  h.roster = roster.rows;
  let changed = false;
  for (const row of roster.rows) {
    if (row.depth !== 1) continue;
    if (row.status === 'running' && !running.has(row.id)) { running.add(row.id); changed = true; }
    if (row.status === 'idle' && running.delete(row.id)) changed = true;
  }
  return changed;
}

/** A child's terminal marker, kept on its roster row too: the log drops an event whose card is
 *  not loaded, and a tab that attaches later reads the roster, not the event. */
export function noteRosterChild(h: HostHistory | undefined, childId: string, done: boolean, tokens?: { input?: number; output?: number; cost?: number }): void {
  const row = h?.roster.find((r) => r.id === childId);
  if (!row) return;
  if (done) row.status = 'idle';
  if (tokens) {
    row.tokens = { ...row.tokens, input: tokens.input ?? row.tokens.input, output: tokens.output ?? row.tokens.output };
    if (typeof tokens.cost === 'number') row.cost = tokens.cost;
  }
}

/** Plan F10: the chat's size, not the page's. */
export function messageCountOf(logLength: number, h: HostHistory | undefined): number {
  const loaded = logLength + (h?.olderLog.length ?? 0);
  return Math.max(loaded, h?.totalMessages ?? 0);
}

/** The agent-text write, shared by the live handler (DashboardPanel.ts) and `pageCollector`. */
export function logAgentChunk(log: SessionMessage[], text: string, messageId?: string): void {
  const last = log[log.length - 1];
  if (last && last.kind === 'agent') {
    last.text += text;
    if (messageId && !last.messageId) last.messageId = messageId;
  } else {
    log.push({ kind: 'agent', text, timestamp: Date.now(), ...(messageId ? { messageId } : {}) });
  }
}

/** The user-text write, shared the same way: a multi-chunk turn stays one entry. */
export function logUserChunk(log: SessionMessage[], text: string): void {
  const last = log[log.length - 1];
  if (last && last.kind === 'user') last.text += text;
  else log.push({ kind: 'user', text, timestamp: Date.now() });
}

const noop = () => undefined;

/**
 * The handler set one older page is decoded into. It WRITES A LOG and does nothing else: no post,
 * no todo strip, no running-child ring, no permission — an old frame is history, not an event
 * (contract 2.4). The writers are the live stream's own, so the rows match a restore of the
 * same messages. Two things the live LOG leaves out are kept here, because the page is drawn beside
 * the newest page, which the pane drew from the live posts: reasoning (a 'thought' entry, drawn as
 * the same ThoughtPill) and an agent image (its own agent row, as the pane's `agentImage` makes).
 * The compaction summary is not kept, as in the live log (plan F5).
 */
export function pageCollector(): { handlers: AcpEventHandlers; log: SessionMessage[] } {
  const log: SessionMessage[] = [];
  let afterImage = false; // text after an image opens its own row below it, in stream order
  const handlers: AcpEventHandlers = {
    onAgentMessageChunk: (text, messageId) => {
      if (afterImage) { afterImage = false; log.push({ kind: 'agent', text, timestamp: Date.now(), ...(messageId ? { messageId } : {}) }); }
      else logAgentChunk(log, text, messageId);
    },
    onUserMessageChunk: (text) => logUserChunk(log, text),
    onPeerMessage: (peer) => { log.push(peerLogEntry(peer)); },
    onStreamDrop: (notice) => logStreamDrop(log, notice),
    onToolCallStart: (args) => { logToolCall(log, args as unknown as Record<string, unknown>); },
    onToolCallUpdate: (args) => logToolResult(log, args as unknown as Record<string, unknown>),
    onSubagentDone: ({ taskSessionId, state, endedAt, tokens }) => logSubagentDone(log, taskSessionId, state, endedAt, tokens),
    onSubagentTokens: ({ childSessionId, tokens }) => logSubagentTokens(log, childSessionId, tokens),
    onAgentThoughtChunk: (text) => {
      const last = log[log.length - 1];
      if (last && last.kind === 'thought') last.text += text;
      else log.push({ kind: 'thought', text, timestamp: Date.now() });
    },
    onAgentImageChunk: (data, mimeType) => { log.push({ kind: 'agent', text: `![image](data:${mimeType};base64,${data})`, timestamp: Date.now() }); afterImage = true; },
    onPermissionRequest: noop, onAvailableCommands: noop,
    onPlanStatus: noop, onPlanReady: noop, onBestOfNComplete: noop, onTaskShape: noop, onTodoUpdate: noop,
    onClose: noop, onError: noop,
  };
  return { handlers, log };
}

/** What a load runs until: one page, the whole chat, a named message (global find), or the user
 *  message that opened a turn (rewind). */
export type LoadUntil = 'page' | 'all' | 'user' | { messageId: string };

export interface HistoryClient {
  historyPage(params: { sessionId: string; before?: string; pageId: string }, sink: AcpEventHandlers): Promise<HistoryPageReply>;
  historySearch(params: { sessionId: string; query: string; cursor?: string }): Promise<HistorySearchReply>;
}

export interface HistoryDeps {
  /** The engine's id for this chat (the ACP session), not the pane's `session-N`. */
  engineSessionId: string;
  client: HistoryClient;
  post: (msg: Record<string, unknown>) => void;
  /** Visible progress outside the pane (DashboardPanel wraps export in a notification). */
  report?: (loaded: number, total: number | null) => void;
}

const unsupported = (err: unknown) => /-32601|method not found/i.test(err instanceof Error ? err.message : String(err));
const errorText = (err: unknown) => (unsupported(err) ? 'This engine cannot load older messages. Update Origami.' : `Could not load older messages: ${err instanceof Error ? err.message : String(err)}`);

function reached(h: HostHistory, until: LoadUntil, page: SessionMessage[]): boolean {
  if (until === 'page') return true;
  if (until === 'user') return page.some((e) => e.kind === 'user');
  if (until === 'all') return false;
  return h.loadedIds.includes(until.messageId);
}

/**
 * Load older pages for one chat, one engine call at a time (contract 3), until `until` holds or
 * the chat's start is reached. Each page goes to the webview as `historyPage` the moment it lands,
 * so the view fills as it goes; `historyProgress` carries "N of M" for the pane and `report`;
 * `historyLoaded` ends it with `reason` echoed, which is what the pane's waiting action keys on.
 * Chained on `h.queue`, so a second request waits for the first rather than racing it.
 */
export function loadHistory(h: HostHistory, sessionId: string, deps: HistoryDeps, until: LoadUntil, reason: string): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const progress = () => {
      const loaded = h.loadedIds.length;
      deps.post({ type: 'historyProgress', sessionId, reason, loaded, total: h.totalMessages });
      deps.report?.(loaded, h.totalMessages);
    };
    try {
      if (typeof until === 'object' && h.loadedIds.includes(until.messageId)) { deps.post({ type: 'historyLoaded', sessionId, reason, ok: true, found: true }); return true; }
      while (h.hasMore && h.cursor) {
        progress();
        const pageId = `older-${++h.seq}`;
        const collector = pageCollector();
        const reply = await deps.client.historyPage({ sessionId: deps.engineSessionId, before: h.cursor, pageId }, collector.handlers);
        h.olderLog = [...collector.log, ...h.olderLog];
        h.loadedIds = [...reply.messageIds, ...h.loadedIds];
        h.cursor = reply.cursor;
        h.hasMore = reply.hasMore;
        if (reply.totalMessages !== null) h.totalMessages = reply.totalMessages;
        deps.post({ type: 'historyPage', sessionId, messages: collector.log, messageIds: reply.messageIds, cursor: h.cursor, hasMore: h.hasMore, total: h.totalMessages, loaded: h.loadedIds.length });
        if (reached(h, until, collector.log)) break;
      }
      const found = typeof until === 'object' ? h.loadedIds.includes(until.messageId) : undefined;
      deps.post({ type: 'historyLoaded', sessionId, reason, ok: true, ...(found === undefined ? {} : { found }) });
      return true;
    } catch (err) {
      deps.post({ type: 'historyLoaded', sessionId, reason, ok: false, error: errorText(err) });
      return false;
    }
  };
  const next = h.queue.then(run, run);
  h.queue = next.then(() => undefined);
  return next;
}

/** Global find (contract 5): one engine call, answered as `historySearchResult`. `unsupported`
 *  tells the find bar to say "needs a newer engine" instead of "0 matches" (contract 6). */
export async function searchHistory(sessionId: string, deps: HistoryDeps, query: string, cursor?: string): Promise<void> {
  try {
    const reply = await deps.client.historySearch({ sessionId: deps.engineSessionId, query, ...(cursor ? { cursor } : {}) });
    deps.post({ type: 'historySearchResult', sessionId, query, hits: reply.hits, done: reply.done, cursor: reply.cursor, scanned: reply.scanned, append: !!cursor });
  } catch (err) {
    deps.post({ type: 'historySearchResult', sessionId, query, hits: [], done: true, cursor: null, error: unsupported(err) ? 'Search of the whole chat needs a newer engine.' : String(err instanceof Error ? err.message : err), unsupported: unsupported(err) });
  }
}

/** The answer to a request this chat cannot serve (its engine is gone, or it is not a reopened
 *  chat): an END, so the pane's bar and any waiting export or find are released with the reason. */
export function historyUnavailable(sessionId: string, req: Record<string, unknown>): Record<string, unknown> {
  const error = 'The engine for this chat is not running. Reopen the chat to load older messages.';
  if (req.type === 'historySearch') return { type: 'historySearchResult', sessionId, query: String(req.query ?? ''), hits: [], done: true, cursor: null, error };
  return { type: 'historyLoaded', sessionId, reason: String(req.reason ?? ''), ok: false, error };
}

/** The pane's requests, routed by DashboardPanel's one-line dispatch. The load resolves true when it
 *  ended well (a failure has already been posted as `historyLoaded` ok:false). */
export const HISTORY_MESSAGE_TYPES: ReadonlySet<string> = new Set(['historyLoad', 'historySearch']);

/** Decode one pane request. `until` arrives as a string or `{ messageId }`; anything else is one page. */
export function untilOf(raw: unknown): LoadUntil {
  if (raw === 'all' || raw === 'user' || raw === 'page') return raw;
  const id = raw && typeof raw === 'object' ? (raw as { messageId?: unknown }).messageId : undefined;
  return typeof id === 'string' && id ? { messageId: id } : 'page';
}
