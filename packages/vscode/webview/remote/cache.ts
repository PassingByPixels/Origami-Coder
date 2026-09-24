// Transcript rows are kept per chat in localStorage beside the seq marks
// (pairing.ts, seq.ts) and dispatched into the bundle before the socket opens;
// the hydration burst then carries only the rows the desk is missing.
//
// The cursor advances on a restore and nowhere else: it indexes the desktop's
// `messageLog`, which the page cannot derive from the live stream because some
// call sites mutate the log's last row instead of pushing.
//
// Security invariant: the painted bundle must not talk before the desk has.
// Painting mounts `ChatView` before the socket is open, so its boot requests
// would go out under K (readable by any pairing-secret holder) instead of the
// post-verification K'. `speak()` holds outbound until the desk speaks past the
// handshake; the page re-declares its cursor afterwards, because a reconnect is
// answered from the presence edge before the returning page's hello.
//
// Malformed is absent, never repaired (same rule as seq.ts).

import {
  TX_PREFIX,
  empty,
  forgetCache,
  read,
  write,
  type CacheFile,
  type Cached,
} from './cacheStore';

/** Rows kept per chat. Mirrors the desktop's REMOTE_TAIL_MESSAGES; the page
 *  bundle cannot import src/remote/remoteTranscript.ts (it pulls node:zlib). */
const MAX_ROWS = 80;

/** Desk -> phone messages that are the handshake, not yet a decision to talk to
 *  this page. `remote/challenge` and `remote/revoked` are answered in main.ts. */
const HANDSHAKE = new Set(['remote/hello', 'remote/challenge', 'remote/revoked']);

interface Msg {
  type?: unknown;
  sessionId?: unknown;
  messages?: unknown;
  omitted?: unknown;
  from?: unknown;
  desk?: unknown;
}

/** What the desktop is told this page holds, and what the page paints before it
 *  is told anything. One instance per page load, keyed by the pairing. */
export class TranscriptCache {
  private readonly key: string;
  private file: CacheFile;
  /** Chats already restored once: a second restore must REPLACE the rows, not append. */
  private readonly painted = new Set<string>();
  /** Chats the desktop named in the burst now arriving. */
  private announced = new Set<string>();
  /** The last `sessionCreated` per chat; it arrives BEFORE the rows it describes. */
  private readonly meta = new Map<string, Record<string, unknown>>();
  /** The chat THIS page painted from cache, until a burst says whether the desk still has it. */
  private pending: string | null = null;
  /** True between an instant paint and the desk's first non-handshake word. */
  private holding = false;
  private queued: Array<[(msg: unknown) => void, unknown]> = [];
  /** First sender registered through `speak`, used to re-declare the cursor.
   *  Unwrapped on purpose: it only fires after the desk has hydrated. */
  private wire: ((msg: unknown) => void) | null = null;
  /** What `cursors()` last told the desk this page holds. Those chats are not
   *  evicted by another chat's write, and the set is replaced on every
   *  declaration, so it resets with the socket that opens one. */
  private pinned: ReadonlySet<string> = new Set();
  /** The chat the strip last moved to, read off `speak`. The desk forgets the
   *  phone's focus on every hydration, so the page says it again per burst. */
  private showing: string | null = null;

  constructor(
    private readonly rid: string,
    private readonly to: (msg: unknown) => void,
    private readonly win: Window = window,
  ) {
    this.key = TX_PREFIX + rid;
    this.file = read(win, this.key);
  }

  /** Feed every inbound message, on both seams `main.ts` has. Returns the message
   *  to hand to the bundle — a restore is rewritten when the desk sent a delta. */
  public note(msg: unknown): unknown {
    const m = msg as Msg | null;
    if (!m || typeof m !== 'object') return msg;
    const id = typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : '';
    if (this.holding && !HANDSHAKE.has(String(m.type))) this.release();
    if (m.type === 'remote/hello') this.noteDesk(m.desk);
    else if (m.type === 'sessionCreated' && id) this.noteCreated(id, m);
    else if (m.type === 'sessionClosed' && id) this.drop(id);
    else if (m.type === 'restoreActiveSession' && id) this.endOfBurst(id);
    else if (m.type === 'restoreMessages' && id && Array.isArray(m.messages)) return this.noteRestore(id, m);
    return msg;
  }

  /** What this page holds, as fields for a frame to carry. Sent on both hello and
   *  snapshot: the desk hydrates on the hello, one frame ahead of the snapshot. */
  public cursors(): { desk?: string; since?: Record<string, number> } {
    const desk = this.file.desk;
    if (!desk) return {};
    const since: Record<string, number> = {};
    for (const [id, s] of Object.entries(this.file.sessions)) since[id] = s.cursor;
    // Declaring is pinning: until the next declaration these chats must survive
    // another chat's write, or the desk holds a cursor for rows this page lost.
    this.pinned = new Set(Object.keys(since));
    return { desk, since };
  }

  /** The `remote/snapshot` this page sends on every socket open — the frame that
   *  MEANS "hydrate me". The post-restore re-declaration is `remote/cursors`. */
  public snapshot(): object {
    return { type: 'remote/snapshot', ...this.cursors() };
  }

  /** Paint the chat the desktop was last on, before any socket is open. The three
   *  messages match `replaySessionTo`'s order, so `mountPick.ts` mounts as always. */
  public paint(): boolean {
    const id = this.paintable();
    if (!id) return false;
    const s = this.file.sessions[id];
    this.painted.add(id);
    this.pending = id;
    this.holding = true;
    this.to({ type: 'sessionCreated', ...(s.meta ?? {}), sessionId: id, agentArt: null });
    this.to(this.restoreFor(id, s));
    this.to({ type: 'restoreActiveSession', sessionId: id });
    return true;
  }

  /** Wrap one outbound send. Until the page has painted from the cache this is the
   *  function given; after that it holds sends until the desk is past the handshake. */
  public speak(send: (msg: unknown) => void): (msg: unknown) => void {
    this.wire ??= send;
    return (msg) => {
      // The strip's `remote/focus` is the only place this file learns the owner's chat.
      const m = msg as Msg | null;
      if (m?.type === 'remote/focus' && typeof m.sessionId === 'string') this.showing = m.sessionId;
      return this.holding ? void this.queued.push([send, msg]) : send(msg);
    };
  }

  /** The pairing is gone (a revoke), so its transcripts go with it. */
  public forget(): void {
    this.file = empty();
    forgetCache(this.rid, this.win);
  }

  private release(): void {
    this.holding = false;
    const queued = this.queued;
    this.queued = [];
    for (const [send, m] of queued) send(m);
  }

  private paintable(): string | undefined {
    const has = (id?: string): boolean => !!id && (this.file.sessions[id]?.rows.length ?? 0) > 0;
    if (has(this.file.active)) return this.file.active;
    return Object.keys(this.file.sessions)
      .filter((id) => has(id))
      .sort((a, b) => this.file.sessions[b].at - this.file.sessions[a].at)[0];
  }

  /** A different desk process invalidates every cursor at once: session ids restart
   *  at `session-1` on each extension-host start, while the rows behind them do not. */
  private noteDesk(desk: unknown): void {
    if (typeof desk !== 'string' || !desk) return;
    if (this.file.desk === desk) return;
    this.file = { v: 1, desk, sessions: {} };
    this.save();
  }

  private noteCreated(id: string, m: Msg): void {
    this.announced.add(id);
    // The ASCII bot art is kilobytes the phone never draws (replaySession.ts sends null).
    const { agentArt: _dropped, ...meta } = m as Record<string, unknown>;
    this.meta.set(id, meta);
    const s = this.file.sessions[id];
    if (!s) return;
    s.meta = meta;
    this.save();
  }

  private drop(id: string): void {
    if (!(id in this.file.sessions)) return;
    delete this.file.sessions[id];
    this.save();
  }

  /** `restoreActiveSession` ends a hydration burst, so the desk's chat list is then
   *  fully known: a painted chat the burst never announced is gone and must be repinned. */
  private endOfBurst(active: string): void {
    const painted = this.pending;
    // Only the painted chat, and only against a burst that named something.
    if (painted && this.announced.size > 0) {
      this.pending = null;
      if (!this.announced.has(painted)) {
        this.drop(painted);
        if (painted !== active) this.to({ type: 'soloSession', sessionId: active });
      }
    }
    // A hydration forgets which chat this phone is reading, so re-say it here once
    // per burst, for a chat the burst itself announced.
    const focus = [this.showing, painted, active].find((id) => !!id && this.announced.has(id));
    if (focus) this.wire?.({ type: 'remote/focus', sessionId: focus });
    this.announced = new Set();
    if (this.file.active === active) return;
    this.file.active = active;
    this.save();
  }

  private noteRestore(id: string, m: Msg): unknown {
    const messages = m.messages as unknown[];
    const from = typeof m.from === 'number' && Number.isInteger(m.from) && m.from >= 0 ? m.from : undefined;
    const held = this.file.sessions[id];
    let rows = messages;
    let cursor = (typeof m.omitted === 'number' ? m.omitted : 0) + messages.length;
    if (from !== undefined) {
      // A delta: `held.cursor - held.rows.length` is the log index the cached rows start at.
      const base = held ? held.cursor - held.rows.length : from;
      const keep = Math.max(0, Math.min(held?.rows.length ?? 0, from - base));
      rows = [...(held?.rows ?? []).slice(0, keep), ...messages];
      cursor = from + messages.length;
    }
    if (rows.length > MAX_ROWS) rows = rows.slice(-MAX_ROWS);
    const entry: Cached = { rows, cursor, at: Date.now(), meta: this.meta.get(id) ?? held?.meta };
    // A delta spliced onto nothing is not a transcript: `from` above zero with
    // nothing held means the cursor is not recorded, so the next burst sends the tail.
    if (from === undefined || from === 0 || held) this.file.sessions[id] = entry;
    // The bundle is given the local entry, never the stored one (cacheStore.ts).
    this.save(id);
    const out = this.restoreFor(id, entry);
    this.painted.add(id);
    // The desk's copy of this cursor, levelled on a socket it can still be sent on.
    if (this.file.desk) this.wire?.({ type: 'remote/cursors', ...this.cursors() });
    return out;
  }

  /** The `restoreMessages` the bundle sees: always the whole cached run, never a
   *  delta. `replaces` tells `ChatPane` to rebuild the rows rather than append. */
  private restoreFor(id: string, s: Cached): object {
    return {
      type: 'restoreMessages',
      sessionId: id,
      messages: s.rows,
      truncated: s.cursor > s.rows.length,
      omitted: s.cursor - s.rows.length,
      replaces: this.painted.has(id),
    };
  }

  private save(writing?: string): void {
    // Not debounced: a timer that hasn't fired yet is exactly what an app kill destroys.
    write(this.win, this.key, this.file, this.pinned, writing);
  }
}

/** Re-exported, not re-implemented: `forgetCache` lives in `cacheStore.ts`. */
export { forgetCache };
