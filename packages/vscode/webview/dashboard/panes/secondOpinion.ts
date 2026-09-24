// secondOpinion.ts — what ONE `secondOpinionResult` message does to a chat's
// transcript.
//
// A pure leaf beside chatMessage.ts (no DOM, no Svelte, no `vscode`) for the
// reason sessionChanges.ts and chatFocus.ts are: the RULES are where the bugs
// are, and every rule here is about correlation, which is exactly the kind of
// thing a rendered test proves badly.
//
// THE RULE THAT MATTERS. A chat can have two reviews in flight at once — the
// same turn, two models, because comparing them is the obvious next thing a
// user does. So an answer is matched to its card by the host's `id`, never by
// "the last pending card". Matching on recency looks identical in every
// single-review test and silently fills the wrong card the first time somebody
// asks two models at once.
//
// A SECOND rule with the same shape: an answer whose id matches no card is
// DROPPED, not appended. That happens after a webview reload (the transcript is
// restored, the pending card is not) and appending would put a review with no
// question above it into the scrollback.

import type { Message, SecondOpinionInfo } from './chatMessage';

/** The `secondOpinionResult` wire shape, read defensively — it crosses a
 *  postMessage boundary from the extension host, so nothing here may assume a
 *  field arrived, and an older host is a real case after an extension update. */
export interface SecondOpinionWire {
  id?: unknown;
  modelId?: unknown;
  modelLabel?: unknown;
  state?: unknown;
  text?: unknown;
  error?: unknown;
  attribution?: unknown;
}

function info(wire: SecondOpinionWire, state: SecondOpinionInfo['state']): SecondOpinionInfo {
  return {
    id: String(wire.id ?? ''),
    modelId: String(wire.modelId ?? ''),
    modelLabel: String(wire.modelLabel ?? '') || String(wire.modelId ?? ''),
    state,
    // Carried on EVERY state, because it is a property of how the review was
    // made rather than of how it ended — and it rides the `pending` post too,
    // so the caveat is on screen while the reader is waiting, not added after
    // they have already started trusting the answer.
    ...(wire.attribution ? { attribution: String(wire.attribution) } : {}),
    ...(state === 'error' ? { error: String(wire.error ?? '') } : {}),
  };
}

/**
 * Apply one answer to a transcript.
 *
 * `pending` OPENS a card — reported through `open` rather than returned,
 * because allocating a row id and scrolling to it are the pane's jobs and this
 * leaf has neither. Every other state FILLS the card with the matching id and
 * comes back as a new message list.
 *
 * Returns `undefined` when the list is unchanged (a card was opened, or the
 * answer matched nothing), so the caller assigns only when there is something
 * to assign — assigning a stale array over a list `open` has just appended to
 * would drop the new row.
 */
export function applySecondOpinion(
  messages: Message[],
  wire: SecondOpinionWire,
  open: (label: string, extra: Partial<Message>) => void,
): Message[] | undefined {
  const id = String(wire.id ?? '');
  if (!id) return undefined;
  const state = wire.state === 'ok' || wire.state === 'error' ? wire.state : 'pending';

  if (state === 'pending') {
    const seed = info(wire, 'pending');
    open(`Second opinion — ${seed.modelLabel}`, { secondOpinion: seed });
    return undefined;
  }

  let hit = false;
  const next = messages.map((msg) => {
    if (msg.kind !== 'secondOpinion' || msg.secondOpinion?.id !== id) return msg;
    hit = true;
    return {
      ...msg,
      // The reviewing model's identity is kept from the card that has been on
      // screen, not re-read from the answer: the card is what the user has been
      // looking at, and a host that answered with a different label would
      // relabel a review mid-flight.
      text: state === 'ok' ? String(wire.text ?? '') : msg.text,
      secondOpinion: { ...msg.secondOpinion, ...info(wire, state), modelLabel: msg.secondOpinion.modelLabel },
    };
  });
  return hit ? next : undefined;
}
