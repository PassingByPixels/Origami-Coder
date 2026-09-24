// subagentPaging.ts — t-krxap7. The window bookkeeping behind
// SubagentTranscriptView's "Load earlier steps": which block may be asked for
// next, and which reply may be applied.
//
// It is a pure leaf on purpose. The bug this file exists to prevent is a DOUBLE
// FETCH — the button and the scroll-top observer both call for the previous
// block, and jsdom has no IntersectionObserver to reproduce that with, so the
// guard has to be testable without a DOM.
//
// Every function returns a NEW state rather than mutating, so a Svelte `$state`
// field can be reassigned from it and the reactivity is a plain assignment.

/** The fields a `subagentTranscriptData` reply carries that paging reads. */
export interface PagingReply {
  /** Echo of the cursor the request carried. Absent = this is the newest page. */
  before?: string;
  /** Cursor for the block BEFORE the one just delivered. Absent at the head. */
  cursor?: string;
  hasMore?: boolean;
}

export interface PagingState {
  /** One request at a time. Without this the button and the observer fetch the
   *  same block twice, and the second reply prepends it a second time. */
  inFlight: boolean;
  /** Cursor for the next older block; absent once the head is reached. */
  cursor?: string;
  hasMore: boolean;
  /** Every cursor whose block is ALREADY in the window. A block in the window is
   *  never requested again, whichever trigger asks. `LATEST` stands for the
   *  newest page, which has no cursor of its own. */
  loaded: string[];
}

/** The key the newest page is recorded under — it is fetched with no cursor. */
export const LATEST = '';

export function initialPaging(): PagingState {
  return { inFlight: false, hasMore: false, loaded: [] };
}

/**
 * The cursor a "load earlier" should carry, or null when the fetch must NOT go
 * out: one is already in flight, nothing older exists, or that block is already
 * drawn. All three answers are the same to the caller — send nothing.
 */
export function earlierCursor(state: PagingState): string | null {
  if (state.inFlight) return null;
  if (!state.hasMore || !state.cursor) return null;
  if (state.loaded.includes(state.cursor)) return null;
  return state.cursor;
}

/** Start the earlier-block fetch, or answer null when `earlierCursor` refuses. */
export function beginEarlier(state: PagingState): { state: PagingState; before: string } | null {
  const before = earlierCursor(state);
  if (before === null) return null;
  return { state: { ...state, inFlight: true }, before };
}

/**
 * Start the newest-page fetch — open, refresh, or the running-child poll. It
 * RESETS the window: the reply rebuilds the message list from scratch, so
 * keeping the old `loaded` set would leave the panel believing blocks are drawn
 * that are no longer on screen.
 */
export function beginLatest(): PagingState {
  return { inFlight: true, hasMore: false, loaded: [] };
}

/** True while the window is exactly the newest page. The running-child poll is
 *  gated on this: a poll rebuilds from the newest page, so polling after the
 *  reader paged back would yank their history off the screen mid-read. */
export function atLatestOnly(state: PagingState): boolean {
  return state.loaded.length <= 1 && !state.loaded.some((key) => key !== LATEST);
}

export type Settled = 'latest' | 'earlier' | 'stale';

/**
 * Fold one reply into the window.
 *
 * `stale` means the block is already drawn — a reply that crossed with another,
 * or a second panel answering. Its entries must be DROPPED, which is what makes
 * "already-loaded steps are not re-read" true even when a reply arrives twice.
 */
export function settle(state: PagingState, reply: PagingReply): { state: PagingState; mode: Settled } {
  const key = typeof reply.before === 'string' && reply.before ? reply.before : LATEST;
  // Only an EARLIER block can be stale. A newest-page reply always REPLACES the
  // window — that is what refresh means — so a second one is a redraw, not a
  // re-read, and refusing it would freeze a running child on its first read.
  if (key !== LATEST && state.loaded.includes(key)) {
    return { state: { ...state, inFlight: false }, mode: 'stale' };
  }
  if (key === LATEST) {
    return {
      state: {
        inFlight: false,
        hasMore: reply.hasMore === true && typeof reply.cursor === 'string' && reply.cursor.length > 0,
        ...(reply.cursor ? { cursor: reply.cursor } : {}),
        loaded: [LATEST],
      },
      mode: 'latest',
    };
  }
  const cursor = typeof reply.cursor === 'string' && reply.cursor ? reply.cursor : undefined;
  return {
    state: {
      inFlight: false,
      // A "there is more" with no cursor is unreachable, so it is recorded as the
      // head rather than as a button that answers nothing.
      hasMore: reply.hasMore === true && cursor !== undefined,
      ...(cursor ? { cursor } : {}),
      loaded: [...state.loaded, key],
    },
    mode: 'earlier',
  };
}
