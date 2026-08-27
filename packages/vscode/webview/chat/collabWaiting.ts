// What the room is still BLOCKED on — the standing "waiting on…" line (2.3).
//
// An `ask` that nobody has answered is the whole reason a four-agent room can
// sit apparently idle: one agent is waiting on another, and the only trace of it
// was a bubble that scrolled off the top of the transcript ten messages ago.
//
// The data was already there. `kind` and `mentions` are stored per message and
// the engine's own wake rule routes on them, so this reads the pairing back out
// with no state of its own and nothing inferred: an ask names a target, the
// TARGET answering closes it, and an ask that named nobody is not a wait.
//
// PURE and DOM-free, so the pairing is testable without a render. The shapes
// mirror src/acpExtTypes.ts rather than importing it — tsconfig.webview.json
// pins rootDir to `webview/` — the same convention collabKinds.ts follows.

/** The part of a `CollabMessage` this leaf reads. */
export interface AskMessage {
  seq: number;
  authorId: string;
  kind?: string;
  mentions?: string[];
}

/** One unanswered question: who is waiting, and on whom. */
export interface OpenAsk {
  seq: number;
  from: string;
  to: string;
}

/**
 * Every ask still waiting for its own target, oldest first.
 *
 * Oldest first because a nested chain IS the order — crane waits on heron waits
 * on fox — and reversing it would read as the innermost question being the one
 * the room started with.
 *
 * An `answer` closes only the ask it came AFTER: an answer that arrived earlier
 * answered a different question, and one from a third agent answered nobody.
 */
export function openAsks(messages: readonly AskMessage[]): OpenAsk[] {
  const open: OpenAsk[] = [];
  for (const m of messages) {
    if (m.kind === 'ask') {
      const to = (m.mentions ?? [])[0];
      if (to) open.push({ seq: m.seq, from: m.authorId, to });
      continue;
    }
    if (m.kind !== 'answer') continue;
    // The newest matching ask first: a target asked twice answers the last one.
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].to === m.authorId) { open.splice(i, 1); break; }
    }
  }
  return open;
}
