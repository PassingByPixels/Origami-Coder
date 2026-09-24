// pendingClose.ts — the rule behind an UNDOABLE chat close (t-ru13hb item 2).
//
// The sidebar's × used to post `closeSession` on the click. There was no
// confirm and no way back, and the × sits a few pixels from the rename pencil.
// The owner's ruling: the row goes at once, an Undo toast runs for the fuse,
// and the host is told only when the fuse burns.
//
// A LEAF because ChatsList.svelte is a capped file and this is a decision, not
// markup: WHICH close is waiting, and what a second close does to the first.
// The component owns the timer and the toast; this owns the rule and the one
// number both halves have to agree on.

/**
 * How long the row stays recoverable. It MIRRORS InlineToast.svelte's own fuse
 * (its FUSE_MS and the `og-toast-burn` animation) — the toast is what tells the
 * user how long they have, so a different number here would either commit the
 * close behind a toast still on screen or leave a dead toast behind one already
 * committed. chatCloseUndo.test.ts reads both files and fails if they drift.
 */
export const CLOSE_FUSE_MS = 4000;

/** The one close waiting on its fuse: the id to post, and the name to show. */
export interface PendingClose {
  id: string;
  label: string;
}

/**
 * A second × while one close is still waiting. ONE toast at a time: a stack of
 * undo toasts is a queue the user has to read backwards, so the earlier close
 * is committed there and then and the new one takes the fuse.
 *
 * `commit` is the id to post now, or null. Re-closing the row already waiting
 * (it is off the list, but a replayed `sessionList` could put it back) commits
 * nothing: it is the same close, not a second one.
 */
export function supersede(
  pending: PendingClose | null,
  next: PendingClose,
): { commit: string | null; pending: PendingClose } {
  return { commit: pending && pending.id !== next.id ? pending.id : null, pending: next };
}

/** What the toast says. The chat is NAMED: with two rows gone the undo has to
 *  say which one it brings back. */
export function closeToastText(label: string): string {
  return label ? `Closed “${label}”` : 'Chat closed';
}

/** The fuse itself: one pending close, one timer, one commit. */
export interface CloseFuse {
  /** The × on a row. Commits whatever was already waiting (supersede). */
  close(next: PendingClose): void;
  /** Undo — drop the fuse, keep the chat, tell the host nothing. */
  undo(): void;
  /** The fuse ran out, or the toast was swiped away: commit now. A swipe is
   *  NOT an undo; it only takes the toast off screen. */
  commit(): void;
  dispose(): void;
}

/**
 * The component keeps the pending close in `$state` and hands it here through
 * `onChange`; the timer and the commit rule live here, out of a capped file.
 */
export function createCloseFuse(opts: {
  post: (id: string) => void;
  onChange: (pending: PendingClose | null) => void;
}): CloseFuse {
  let pending: PendingClose | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const set = (next: PendingClose | null) => { pending = next; opts.onChange(next); };
  const disarm = () => { if (timer) clearTimeout(timer); timer = null; };
  const commit = () => {
    disarm();
    const done = pending;
    set(null);
    if (done) opts.post(done.id);
  };
  return {
    close(next) {
      const r = supersede(pending, next);
      disarm();
      if (r.commit) opts.post(r.commit);
      set(r.pending);
      timer = setTimeout(commit, CLOSE_FUSE_MS);
    },
    undo() { disarm(); set(null); },
    commit,
    dispose: disarm,
  };
}
