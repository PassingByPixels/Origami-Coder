// chatHistory.ts — lazy loading, WEBVIEW side (t-ucnp7t). Plan sections 3.5, 3.6 and 4; the host
// half is src/dashboard/historyHost.ts, the wire is the engine lane's wire_contract.md.
//
// A reopened chat shows only its newest page. The older pages arrive later and live in their OWN
// list, `ChatHistory.older`, never in `ChatSession.messages`: every index into `messages` (the
// pane's `restoredAt`, the phone cache, the loop boundary) keeps its meaning (plan F13). The
// transcript draws `[...older, ...messages]`.
//
// Every feature that assumed the whole transcript reads through the helpers at the bottom, so
// none of them shows a silently cut result (plan section 4): export and rewind load what they need
// first, the changes pill says "loaded part", the pinned question comes from the engine's walk,
// and the sub-agent drawer gets a card for every child the roster names.
//
// An old engine sends `lazy: false`: `older` stays empty, `hasMore` false, and every helper returns
// what the pane used before this file existed (contract section 6).

import { getVsCodeApi } from '../../shared/vscodeApi';
import { restoreLog, type RestoredEntry } from './chatRestore';
import { pinnedMirrorText } from '../components/pinnedUser';
import { aggregateSessionChanges, type RawFileDiff, type SessionChanges } from './sessionChanges';
import { rewindSlice } from './rewindSlice';
import { holdPlace } from './historyScroll';
import { REPLY_MS } from '../components/subagentTranscriptTiming';
import type { Message } from './chatMessage';

/** Mirror of src/acpHistory.ts `RosterRow` (a webview leaf cannot import src/). Its drift guard is
 *  in __tests__/lazyHistoryWebview.test.ts. */
export interface RosterRow {
  id: string;
  parentId: string;
  depth: number;
  title: string;
  agent: string | null;
  status: 'running' | 'idle';
  created: number;
  updated: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost: number;
  steps: number | null;
  context: number | null;
}

export interface ChatHistory {
  /** The engine sent a window: this chat pages. False = everything was replayed (old engine). */
  lazy: boolean;
  /** Reopening: "Loading chat history…" until the window lands (plan 3.6). */
  restoring: boolean;
  /** Older pages, oldest first. Prepend only. */
  older: Message[];
  cursor: string | null;
  hasMore: boolean;
  total: number | null;
  /** Engine message ids already on screen (global find's "is it loaded yet"). */
  loadedIds: string[];
  latestUser: { messageId: string; text: string } | null;
  roster: RosterRow[];
  /** One card per DIRECT child the roster names, so a child spawned above the loaded page still
   *  has a card for its live events to land on and a row in the drawer (plan F8). Never drawn in
   *  the transcript itself: it is not a message. */
  rosterCards: Message[];
  /** A load in flight: what for, and how far ("Loading 350 of 870 messages…"). */
  loading: { reason: string; loaded: number; total: number | null } | null;
  error: string;
}

/** What this file reads off ChatPane's session. Structural, like its sibling leaves. */
export interface HistoryHolder {
  id: string;
  agentName: string;
  messages: Message[];
  history?: ChatHistory;
  starting?: boolean;
  revertStash?: Message[];
  currentAgentMsgId?: number | null;
  currentThoughtMsgId?: number | null;
  subagentChanges?: Record<string, RawFileDiff[]>;
}

export function emptyHistory(): ChatHistory {
  return { lazy: false, restoring: false, older: [], cursor: null, hasMore: false, total: null, loadedIds: [], latestUser: null, roster: [], rosterCards: [], loading: null, error: '' };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Actions waiting on a load: export, a find jump, a rewind. Keyed by the request's own token,
 *  which the host echoes on `historyLoaded` as `reason`. Module state on purpose: the pane's
 *  message router is the one reader, and a hidden cell's load must still finish its action. */
const waiting = new Map<string, (done: { ok: boolean; found?: boolean }) => void>();
/** The loads each chat has posted and not seen end, by request token. The scroll trigger and the
 *  button share it, so the two can never ask for the same page twice. */
const inFlight = new Map<string, Set<string>>();
/** One deadline per chat, re-armed by every post of its load (plan 3.6 "No answer"). */
const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

/** No answer for REPLY_MS: every load still open for the chat ends as a failure, through the SAME
 *  route a host answer takes, so the bar says so and a waiting action is released. */
function arm(sessionId: string): void {
  clearTimeout(deadlines.get(sessionId));
  if (!inFlight.get(sessionId)?.size) { deadlines.delete(sessionId); return; }
  deadlines.set(sessionId, setTimeout(() => {
    deadlines.delete(sessionId);
    for (const reason of inFlight.get(sessionId) ?? []) {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'historyLoaded', sessionId, reason, ok: false, error: `No answer after ${REPLY_MS / 1000} s. Try again.` } }));
    }
  }, REPLY_MS));
}

/** Ask the host for older pages. `kind` names the purpose (it is the prefix of the progress label);
 *  `then` runs when the load ends. False when a scroll-up load is already running (one at a time). */
export function requestHistory(sessionId: string, until: 'page' | 'all' | 'user' | { messageId: string }, kind: string, then?: (done: { ok: boolean; found?: boolean }) => void): boolean {
  if (kind === 'scroll' && historyInFlight(sessionId)) return false;
  const reason = `${kind}#${++seq}`;
  if (then) waiting.set(reason, then);
  inFlight.set(sessionId, (inFlight.get(sessionId) ?? new Set()).add(reason));
  arm(sessionId);
  getVsCodeApi().postMessage({ type: 'historyLoad', sessionId, until, reason });
  return true;
}

/** True while a load for this chat is posted and unanswered. */
export function historyInFlight(sessionId: string): boolean {
  return (inFlight.get(sessionId)?.size ?? 0) > 0;
}

/** Roster rows -> the drawer's cards. Only direct children: a grandchild never had a card in this
 *  chat, and the drawer must not start listing them. A card that already exists keeps what the live
 *  stream wrote on it since. */
function rosterCardsFrom(rows: RosterRow[], old: Message[], nextId: () => number): Message[] {
  const prior = new Map(old.map((c) => [c.taskSessionId, c]));
  return rows.filter((r) => r.depth === 1).map((r) => {
    const was = prior.get(r.id);
    const idle = r.status === 'idle';
    return {
      id: was?.id ?? nextId(),
      kind: 'tool',
      label: r.title || 'task',
      text: r.title,
      toolName: 'task',
      toolStatus: 'completed',
      taskSessionId: r.id,
      taskBackground: true,
      ...(r.agent ? { taskAgentType: r.agent } : {}),
      ...(r.title ? { taskDescription: r.title } : {}),
      taskTokens: {
        input: r.tokens.input, output: r.tokens.output, reasoning: r.tokens.reasoning, cacheRead: r.tokens.cacheRead, cacheWrite: r.tokens.cacheWrite, cost: r.cost,
        ...(r.steps !== null ? { steps: r.steps } : {}), ...(r.context !== null ? { context: r.context } : {}),
      },
      timestamp: r.created,
      taskStartedAt: r.created,
      ...(idle ? { taskDone: 'completed' as const, taskEndedAt: r.updated } : {}),
      ...(was?.taskDone ? { taskDone: was.taskDone, taskEndedAt: was.taskEndedAt } : {}),
      ...(was?.taskStream ? { taskStream: was.taskStream } : {}),
      ...(was?.taskThinking ? { taskThinking: was.taskThinking } : {}),
    } satisfies Message;
  });
}

/** When an older page brings a child's REAL card, whatever the live stream wrote on its roster card
 *  moves over, so the done marker or the latest spend is not lost with the stand-in. */
function adoptLiveState(rows: Message[], cards: Message[]): void {
  for (const row of rows) {
    const stand = row.taskSessionId ? cards.find((c) => c.taskSessionId === row.taskSessionId) : undefined;
    if (!stand) continue;
    if (!row.taskDone && stand.taskDone) { row.taskDone = stand.taskDone; row.taskEndedAt = stand.taskEndedAt; }
    if (stand.taskTokens) row.taskTokens = stand.taskTokens;
    if (stand.taskStream && !row.taskStream) row.taskStream = stand.taskStream;
  }
}

/** Every host post of the lazy-loading wire, in one place. The pane routes these four types here. */
export function applyHistory(s: HistoryHolder, msg: Record<string, unknown>, nextId: () => number): void {
  // Read back after the assignment: in the pane `s` is a Svelte state proxy, and only writes made
  // through it are seen by the transcript.
  if (!s.history) s.history = emptyHistory();
  const h = s.history;
  switch (msg.type) {
    case 'historyState': {
      const wasRestoring = h.restoring;
      h.restoring = msg.restoring === true;
      h.lazy = msg.lazy === true;
      h.cursor = str(msg.cursor);
      h.hasMore = msg.hasMore === true && h.cursor !== null;
      h.total = count(msg.total);
      const u = msg.latestUser as { messageId?: unknown; text?: unknown } | null | undefined;
      h.latestUser = u && typeof u.messageId === 'string' && typeof u.text === 'string' ? { messageId: u.messageId, text: u.text } : null;
      h.loadedIds = ids(msg.loadedIds);
      if (Array.isArray(msg.roster)) { h.roster = msg.roster as RosterRow[]; h.rosterCards = rosterCardsFrom(h.roster, h.rosterCards, nextId); }
      // A tab that attaches after a scroll-up takes the older rows once, the same "a pane with rows
      // takes no replay" rule the window's own restore follows (sessionReplay.ts).
      if (Array.isArray(msg.older) && h.older.length === 0) h.older = restoreLog<Message>([], msg.older as RestoredEntry[], nextId, s.agentName);
      // F5: the restore is over, so a compaction marker it replayed is not still compacting (no
      // turnDone follows a replay, and nothing else would settle it).
      if (wasRestoring && !h.restoring) s.messages = s.messages.map((m) => (m.kind === 'compacted' && m.compacting ? { ...m, compacting: false } : m));
      return;
    }
    case 'historyPage': {
      if (historyInFlight(s.id)) arm(s.id);
      // A page this pane already holds (a tab that attached mid-load got it in its historyState)
      // is not drawn twice.
      const pageIds = ids(msg.messageIds);
      if (pageIds.length > 0 && pageIds.every((id) => h.loadedIds.includes(id))) return;
      const rows = restoreLog<Message>([], (Array.isArray(msg.messages) ? msg.messages : []) as RestoredEntry[], nextId, s.agentName);
      adoptLiveState(rows, h.rosterCards);
      holdPlace(s.id);
      h.older = [...rows, ...h.older];
      h.loadedIds = [...ids(msg.messageIds), ...h.loadedIds];
      h.cursor = str(msg.cursor);
      h.hasMore = msg.hasMore === true && h.cursor !== null;
      h.total = count(msg.total) ?? h.total;
      if (h.loading) h.loading = { ...h.loading, loaded: count(msg.loaded) ?? h.loading.loaded };
      return;
    }
    case 'historyProgress':
      if (historyInFlight(s.id)) arm(s.id);
      h.loading = { reason: String(msg.reason ?? ''), loaded: count(msg.loaded) ?? 0, total: count(msg.total) };
      h.error = '';
      return;
    case 'historyLoaded': {
      const reason = String(msg.reason ?? '');
      inFlight.get(s.id)?.delete(reason);
      arm(s.id);
      h.loading = null;
      h.error = msg.ok === false ? String(msg.error ?? 'Could not load older messages.') : '';
      const then = waiting.get(reason);
      waiting.delete(reason);
      then?.({ ok: msg.ok !== false, ...(typeof msg.found === 'boolean' ? { found: msg.found } : {}) });
      return;
    }
  }
}

/** The pane's router asks this before calling `applyHistory`. */
export const HISTORY_POSTS: ReadonlySet<string> = new Set(['historyState', 'historyPage', 'historyProgress', 'historyLoaded']);

/** What the transcript draws. The SAME array when nothing older is loaded, so an old engine's pane
 *  renders exactly as before. */
export function shownMessages(s: HistoryHolder): Message[] {
  const older = s.history?.older;
  return older && older.length > 0 ? [...older, ...s.messages] : s.messages;
}

/** Every card a sub-agent event may land on, and what the drawer and the T-numbers are read from:
 *  the roster's stand-ins for children whose real card is not loaded, first (they are the oldest),
 *  then the transcript (plan F8). */
export function subagentSource(s: HistoryHolder): Message[] {
  const shown = shownMessages(s);
  const cards = s.history?.rosterCards;
  if (!cards || cards.length === 0) return shown;
  const real = new Set(shown.map((m) => m.taskSessionId).filter(Boolean));
  const stand = cards.filter((c) => !real.has(c.taskSessionId));
  return stand.length > 0 ? [...stand, ...shown] : shown;
}

/** Plan F11: the pinned question. When no loaded row is a user row (one long agent turn fills the
 *  page), it is the engine's own `latestUser`, which the model walk already found. */
export function pinnedFor(s: HistoryHolder): string {
  const shown = shownMessages(s);
  const text = pinnedMirrorText(shown);
  if (text || shown.some((m) => m.kind === 'user')) return text;
  return s.history?.latestUser?.text ?? '';
}

/** Plan F12: the changes pill. While older pages are unloaded its figure covers the loaded part
 *  only, and says so (`partial`). The session row's own totals are not on the wire. */
export function changesFor(s: HistoryHolder): SessionChanges {
  const changes = aggregateSessionChanges(shownMessages(s), s.subagentChanges);
  return s.history?.hasMore ? { ...changes, partial: true } : changes;
}

/** Plan 3.6: the composer's words while a reopen is still arriving. */
export function composerHint(s: HistoryHolder): string {
  if (!s.starting) return '';
  return s.history?.restoring ? 'Loading chat… you can type now, it sends when the chat connects' : 'Starting engine — you can type now, it sends when the chat connects…';
}

/** Plan F2: export first loads the whole chat, with progress, then runs `run`. True = it is
 *  loading and the caller must stop here; `run` is called again when the load ends. */
export function loadAllFirst(s: HistoryHolder, kind: string, run: () => void): boolean {
  if (!s.history?.hasMore) return false;
  // Only on success: a failed load would otherwise ask again, and again (its error is on the bar).
  return requestHistory(s.id, 'all', kind, (done) => { if (done.ok) run(); });
}

/**
 * Plan F4: "Rewind to here" across the loaded pages. The engine reverts to the USER message that
 * opened the turn (rewindSlice.ts). If that message is above everything loaded, the older pages
 * are loaded first until it is (the host's "user" load), and the rewind runs again — trimming the
 * whole loaded head without it would leave the reader an empty pane and a "Load earlier" that
 * brings back half of the turn the engine just dropped. Returns true when the trim is done and the
 * caller may post the revert.
 */
export function rewindAcross(s: HistoryHolder, engineMsgId: string, retry: () => void): boolean {
  const h = s.history;
  const shown = shownMessages(s);
  const cut = rewindSlice(shown, engineMsgId);
  if (!cut) return false;
  if (cut.keep.length === 0 && h?.hasMore && cut.removed[0]?.kind !== 'user') {
    requestHistory(s.id, 'user', 'rewind', (done) => { if (done.ok) retry(); });
    return false;
  }
  const olderCount = h?.older.length ?? 0;
  if (h && cut.keep.length < olderCount) { h.older = cut.keep; s.messages = []; }
  else s.messages = cut.keep.slice(olderCount);
  s.revertStash = cut.removed;
  s.currentAgentMsgId = null;
  s.currentThoughtMsgId = null;
  return true;
}

/** The "Load earlier messages" label (plan 3.6). `total` counts stored messages, so the remainder
 *  is an estimate the engine also treats as one (contract 3); no number when it could not count. */
export function earlierLabel(h: ChatHistory): string {
  if (h.loading) {
    if (h.loading.reason.startsWith('scroll')) return 'Loading earlier messages…';
    return h.loading.total ? `Loading ${h.loading.loaded} of ${h.loading.total} messages…` : `Loading ${h.loading.loaded} messages…`;
  }
  const left = h.total !== null ? Math.max(0, h.total - h.loadedIds.length) : 0;
  return left > 0 ? `Load earlier messages (${left} more)` : 'Load earlier messages';
}
