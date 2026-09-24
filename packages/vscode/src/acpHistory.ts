// acpHistory.ts — the lazy-loading wire (t-ucnp7t), decoded. The contract is the engine lane's
// `reports/lazy_loading_plan_2026-09-24/wire_contract.md`: a reopened chat replays only its newest
// page, says which page in ONE `HistoryWindow`, sends the sub-agent roster from session rows, and
// answers `history_page` / `history_search` / `subagent_roster` on demand.
//
// Every reader here FAILS CLOSED: a field of the wrong type is dropped, never guessed. An old engine
// sends none of this, and `null` from `historyWindowFrom` is how the host knows to keep today's
// whole-chat behaviour (contract section 6).

/** Contract 1.3. The same object rides `origami/historyWindow` and the load/fork response's
 *  `_meta.origami_history`. */
export interface HistoryWindow {
  sessionId: string;
  /** `before` for the next older `history_page`; null when `hasMore` is false. */
  cursor: string | null;
  hasMore: boolean;
  /** The replayed messages, oldest first. */
  messageIds: string[];
  /** Stored message count; null when the engine could not count. */
  totalMessages: number | null;
  /** The newest user message the model walk found. It can be above the replayed page. */
  latestUser: { messageId: string; text: string } | null;
  capped: boolean;
}

/** Contract 2.3: the reply to one `history_page` call, after all of its frames. */
export interface HistoryPageReply {
  sessionId: string;
  pageId: string;
  cursor: string | null;
  hasMore: boolean;
  messageIds: string[];
  messages: number;
  totalMessages: number | null;
  capped: boolean;
}

/** Contract 4.2, one row. */
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

export interface SubagentRoster {
  sessionId: string;
  rows: RosterRow[];
  truncated: boolean;
}

/** Contract 5.3. */
export interface SearchHit {
  messageId: string;
  partId: string;
  role: 'user' | 'assistant';
  kind: 'text' | 'reasoning' | 'tool';
  toolCallId: string | null;
  time: number;
  fromEnd: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  matchesInPart: number;
}

export interface HistorySearchReply {
  sessionId: string;
  query: string;
  hits: SearchHit[];
  scanned: number;
  done: boolean;
  cursor: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A cursor is opaque (contract 0); only "a non-empty string, or nothing" is read. */
function cursorOf(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

/** `hasMore` is believed only with a cursor to follow: a "more" that cannot be fetched would be a
 *  button that answers nothing. */
function paging(o: Obj): { cursor: string | null; hasMore: boolean } {
  const cursor = cursorOf(o.cursor);
  return { cursor, hasMore: o.hasMore === true && cursor !== null };
}

/** `HistoryWindow` off either copy, or null when the value is not one (an old engine sends none). */
export function historyWindowFrom(raw: unknown): HistoryWindow | null {
  const o = obj(raw);
  const sessionId = o ? str(o.sessionId) : null;
  if (!o || !sessionId || !Array.isArray(o.messageIds)) return null;
  const user = obj(o.latestUser);
  const userId = user ? str(user.messageId) : null;
  const userText = user ? str(user.text) : null;
  return {
    sessionId,
    ...paging(o),
    messageIds: strings(o.messageIds),
    totalMessages: num(o.totalMessages),
    latestUser: userId && userText !== null ? { messageId: userId, text: userText } : null,
    capped: o.capped === true,
  };
}

/** The window a load/fork RESPONSE carries on `_meta.origami_history`, or null. */
export function historyFromResponse(resp: unknown): HistoryWindow | null {
  const meta = obj(obj(resp)?._meta);
  return meta ? historyWindowFrom(meta.origami_history) : null;
}

export function historyPageReplyFrom(raw: unknown, pageId: string): HistoryPageReply {
  const o = obj(raw) ?? {};
  const messageIds = strings(o.messageIds);
  return {
    sessionId: str(o.sessionId) ?? '',
    pageId: str(o.pageId) ?? pageId,
    ...paging(o),
    messageIds,
    messages: num(o.messages) ?? messageIds.length,
    totalMessages: num(o.totalMessages),
    capped: o.capped === true,
  };
}

function rosterRowFrom(raw: unknown): RosterRow | null {
  const o = obj(raw);
  const id = o ? str(o.id) : null;
  if (!o || !id) return null;
  const t = obj(o.tokens) ?? {};
  const n = (v: unknown) => num(v) ?? 0;
  return {
    id,
    parentId: str(o.parentId) ?? '',
    depth: num(o.depth) ?? 1,
    title: str(o.title) ?? '',
    agent: str(o.agent),
    status: o.status === 'running' ? 'running' : 'idle',
    created: n(o.created),
    updated: n(o.updated),
    tokens: { input: n(t.input), output: n(t.output), reasoning: n(t.reasoning), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite) },
    cost: n(o.cost),
    steps: num(o.steps),
    context: num(o.context),
  };
}

/** Roster off the notification params or the method reply. Rows keep the engine's order
 *  (created ascending, then id): that order IS the T-numbering (contract 4.2). */
export function subagentRosterFrom(raw: unknown): SubagentRoster | null {
  const o = obj(raw);
  const sessionId = o ? str(o.sessionId) : null;
  if (!o || !sessionId || !Array.isArray(o.rows)) return null;
  return {
    sessionId,
    rows: o.rows.map(rosterRowFrom).filter((r): r is RosterRow => r !== null),
    truncated: o.truncated === true,
  };
}

function hitFrom(raw: unknown): SearchHit | null {
  const o = obj(raw);
  const messageId = o ? str(o.messageId) : null;
  if (!o || !messageId) return null;
  const kind = o.kind === 'reasoning' || o.kind === 'tool' ? o.kind : 'text';
  return {
    messageId,
    partId: str(o.partId) ?? '',
    role: o.role === 'user' ? 'user' : 'assistant',
    kind,
    toolCallId: str(o.toolCallId),
    time: num(o.time) ?? 0,
    fromEnd: num(o.fromEnd) ?? 0,
    snippet: str(o.snippet) ?? '',
    matchStart: num(o.matchStart) ?? 0,
    matchLength: num(o.matchLength) ?? 0,
    matchesInPart: num(o.matchesInPart) ?? 1,
  };
}

export function historySearchReplyFrom(raw: unknown): HistorySearchReply {
  const o = obj(raw) ?? {};
  const cursor = cursorOf(o.cursor);
  return {
    sessionId: str(o.sessionId) ?? '',
    query: str(o.query) ?? '',
    hits: (Array.isArray(o.hits) ? o.hits : []).map(hitFrom).filter((h): h is SearchHit => h !== null),
    scanned: num(o.scanned) ?? 0,
    // A reply that says "not done" with no cursor cannot be continued, so it IS done.
    done: o.done === true || cursor === null,
    cursor,
  };
}

/** The page a `session/update` frame belongs to (contract 2.4), or undefined for a live or
 *  restore frame. Routing reads this tag and nothing else, never timing. */
export function pageTag(update: unknown): string | undefined {
  const meta = obj(obj(update)?._meta);
  const tag = meta ? meta.origami_page : undefined;
  return typeof tag === 'string' ? tag : undefined;
}
