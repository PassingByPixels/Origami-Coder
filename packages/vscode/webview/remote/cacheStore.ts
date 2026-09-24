// The transcript's storage half: what localStorage holds, and what is
// evicted when a record will not fit.
//
// Eviction has an order, oldest first inside each step:
//   1. a chat this page did not declare on the socket it is on;
//   2. the record being written right now;
//   3. anything else.
//
// The declared set must not move: the desk answers a phone's `since[id]`
// with rows after that cursor only, so evicting a declared chat's rows
// while its cursor is still reported leaves a transcript that never
// repairs itself. `cache.ts` builds the entry and paints it regardless of
// whether this copy fits; a quota here must never affect what is painted.

/** Beside `origami-remote/ks/`, `origami-remote/seq/` and the view-state blob. */
export const TX_PREFIX = 'origami-remote/tx/';

/** Chats kept. The strip lists what the desk holds; this is what the page can
 *  PAINT instantly, and it opens on one at a time. */
export const MAX_SESSIONS = 3;

/** Bytes of serialised cache. The shell shares localStorage with the
 *  pairing secret, so a transcript must never block a pairing write. */
export const MAX_BYTES = 250_000;

export interface Cached {
  /** The rows exactly as the desktop sent them: post-tail, post-trim. */
  rows: unknown[];
  /** The length of the desktop's `messageLog` that `rows` ends at. */
  cursor: number;
  /** Last written, for eviction. */
  at: number;
  /** The chat's own `sessionCreated`, so an instant paint carries the real name
   *  and number rather than a placeholder the burst then has to correct. */
  meta?: Record<string, unknown>;
}

export interface CacheFile {
  v: 1;
  /** The desk process these cursors were minted against (`remoteDelta.ts`). */
  desk?: string;
  /** The chat the desktop was last on: what a reopened app paints. */
  active?: string;
  sessions: Record<string, Cached>;
}

export function empty(): CacheFile {
  return { v: 1, sessions: {} };
}

export function read(win: Window, key: string): CacheFile {
  try {
    const raw = win.localStorage.getItem(key);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<CacheFile> | null;
    if (!parsed || parsed.v !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') return empty();
    const sessions: Record<string, Cached> = {};
    for (const [id, s] of Object.entries(parsed.sessions)) {
      const c = s as Partial<Cached> | null;
      if (!c || !Array.isArray(c.rows) || typeof c.cursor !== 'number') continue;
      // A cursor shorter than its rows is a record this file did not write.
      if (!Number.isInteger(c.cursor) || c.cursor < c.rows.length) continue;
      sessions[id] = { rows: c.rows, cursor: c.cursor, at: typeof c.at === 'number' ? c.at : 0, meta: c.meta };
    }
    return {
      v: 1,
      desk: typeof parsed.desk === 'string' ? parsed.desk : undefined,
      active: typeof parsed.active === 'string' ? parsed.active : undefined,
      sessions,
    };
  } catch {
    return empty();
  }
}

/**
 * Stores the file, evicting in the header's order until it fits, then
 * gives up rather than throwing: an uncached transcript means a slower
 * boot, not a broken one. `keep` is what the page declared on this socket;
 * `writing` is the record this save is for, if any.
 */
export function write(
  win: Window,
  key: string,
  file: CacheFile,
  keep: ReadonlySet<string> = new Set(),
  writing?: string,
): void {
  const ids = Object.keys(file.sessions).sort((a, b) => file.sessions[a].at - file.sessions[b].at);
  while (ids.length > MAX_SESSIONS) delete file.sessions[ids.shift() as string];
  const order = (declared: boolean): string[] => ids.filter((id) => keep.has(id) === declared && id !== writing);
  const byes = [...order(false), ...(writing !== undefined && writing in file.sessions ? [writing] : []), ...order(true)];
  try {
    for (;;) {
      const json = JSON.stringify(file);
      if (json.length <= MAX_BYTES) return void win.localStorage.setItem(key, json);
      if (byes.length === 0) return void win.localStorage.removeItem(key);
      delete file.sessions[byes.shift() as string];
    }
  } catch {
    /* private mode, quota, a disabled store: the shell still boots. */
  }
}

/** Revoke rotates the pairing, so its cached transcripts go with it. */
export function forgetCache(rid: string, win: Window = window): void {
  try {
    win.localStorage.removeItem(TX_PREFIX + rid);
  } catch {
    /* nothing to forget is the outcome we wanted */
  }
}
