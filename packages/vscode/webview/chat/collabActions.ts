// collabActions.ts — the collab board's MUTATIONS, as one factory. Extracted
// from CollabPane.svelte (432 of its 440-line cap) at X2 to pay for the setup
// card's wiring, and it mirrors makeCollabPollLoop: a factory the pane holds,
// with no Svelte in it, so the rules below are provable without a render.
//
// THE RULE EVERY ONE OF THEM SHARES: each mutation is a host message and a
// re-poll. The engine owns the transition, so nothing is spliced in locally and
// a refused accept cannot leave a closed task on screen.
//
// `collabId` is a GETTER, not a value: the pane is seeded with its identity on
// mount, so a factory built at component setup would capture an empty id.

export interface CollabActionHost {
  post: (msg: Record<string, unknown>) => void;
  collabId: () => string;
  poll: () => void;
}

export interface CollabActions {
  send: (msg: Record<string, unknown>) => void;
  setCap: (cap: number | null) => void;
  /** W5: turns dispatched at once (1 = serial). W5-L2: the room's own KIND. */
  setConcurrency: (concurrency: number) => void;
  setFlavor: (flavor: 'discuss' | 'council') => void;
  addTask: (title: string) => void;
  updateTask: (taskId: string, action: 'accept' | 'reopen', extra: { note?: string }) => void;
  loadLedger: () => void;
  /** W3 (report 2.4): the three PER-MEMBER mutations. `stopAgent` is one word
   *  from `collabStop` on the wire and a world apart in effect — that one takes
   *  the whole room and spends its hop budget, this one takes one member. */
  stopAgent: (slug: string) => void;
  redirect: (slug: string, text: string) => void;
  review: (taskId: string, verdict: 'approve' | 'reject', note?: string) => void;
}

export function makeCollabActions(host: CollabActionHost): CollabActions {
  const send = (msg: Record<string, unknown>): void => {
    const collabId = host.collabId();
    if (!collabId) return;
    host.post({ ...msg, collabId });
    host.poll();
  };
  return {
    send,
    /** Blank restores the engine default (null); a number sets it, and 0 turns
     *  the breaker off. Blank and 0 are NOT the same input and are not folded.
     *  `cap || default` is exactly the bug this spells out — it would silently
     *  re-arm a breaker the user turned off. No re-poll: `collabCapSet` comes
     *  back and triggers one of its own. */
    setCap: (cap) => {
      const collabId = host.collabId();
      if (collabId) host.post({ type: 'collabSetCap', collabId, cap });
    },
    /** Both go through `send`, unlike `setCap`: either can come back REFUSED —
     *  width is gated on every member being file-read-only; a flavor flip only
     *  refuses an unknown flavor (council rounds are SEALED, not gated). The
     *  re-poll snaps the control back to what stuck, never what did not. */
    setConcurrency: (concurrency) => send({ type: 'collabSetConcurrency', concurrency }),
    setFlavor: (flavor) => send({ type: 'collabSetFlavor', flavor }),
    addTask: (title) => send({ type: 'collabTaskAdd', title }),
    updateTask: (taskId, action, extra) => send({ type: 'collabTaskUpdate', taskId, action, ...extra }),
    /** Asked when the board OPENS, not on every poll — nothing shows the
     *  per-turn entries while the section is shut. */
    loadLedger: () => {
      const collabId = host.collabId();
      if (collabId) host.post({ type: 'requestCollabLedger', collabId });
    },
    stopAgent: (slug) => send({ type: 'collabStopAgent', agentSlug: slug }),
    redirect: (slug, text) => send({ type: 'collabRedirect', agentSlug: slug, text }),
    /** The note is OMITTED when there is none: the engine refuses a reject
     *  without a reason, and `note: ''` is a reason it would refuse twice. */
    review: (taskId, verdict, note) => send({ type: 'collabReview', taskId, verdict, ...(note ? { note } : {}) }),
  };
}
