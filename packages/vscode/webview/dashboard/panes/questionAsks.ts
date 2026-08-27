// questionAsks.ts — per-chat ownership of a batched clarifying-question ask,
// and the gate that decides which batch (if any) the modal may render.
//
// ChatPane held ONE `questionAsk` for the whole pane behind a bare
// `{#if questionAsk}`. Two defects fell out of that single slot. The modal
// opened over whichever cell was on screen instead of the chat that asked
// (observed live at 0.3.65: Tsuru #5's three-question batch popped over Tsuru
// #4, the tab being read). And a second asking chat OVERWROTE the first, whose
// engine then blocked forever on an answer that could no longer be given.
// Keying by sessionId fixes both: a batch is owned, and batches cannot collide.
//
// The DRAFT — which question the user is on, and what they picked or typed —
// lives here rather than inside QuestionModal, because leaving the tab unmounts
// the modal. Hidden is not dismissed: the batch returns exactly as it was left.
//
// Pure and DOM-free on purpose, so the ownership rules are testable without a
// render, and so ChatPane (at its architecture cap) carries none of them.

/** One choice in a question, as the engine puts it on the ask. */
export type QuestionAskOption = { optionId: string; name: string; kind: string };

/** One question inside a batch. */
export type QuestionAskQuestion = { title: string; options: QuestionAskOption[] };

/** What the user has entered for one question. Both fields may be empty. */
export type QuestionAskDraft = { optionId: string; answerText: string };

/** A whole batch, plus the user's progress through it. */
export type QuestionAskEntry = {
  sessionId: string;
  toolCallId: string;
  questions: QuestionAskQuestion[];
  currentIndex: number;
  /** Keyed by question POSITION — the engine matches answers positionally. */
  answers: Record<number, QuestionAskDraft>;
};

/** Every open batch, keyed by the id of the chat that asked. */
export type QuestionAsks = Record<string, QuestionAskEntry>;

/**
 * The batch store with `sessionId`'s ask opened.
 *
 * A chat can only be blocked on one ask at a time (the engine waits for the
 * answer before it asks again), so one entry per chat is the whole rule. The
 * host REPLAYS a buffered ask when its view mounts or grid mode turns on
 * (DashboardPanel.replayBufferedQuestionFor), and a replay carries the SAME
 * toolCallId — so the draft is kept there, and reset only for a genuinely new
 * ask. Without that check a replay would silently wipe answers already typed.
 */
export function openAsk(
  asks: QuestionAsks,
  sessionId: string,
  toolCallId: string,
  questions: QuestionAskQuestion[],
): QuestionAsks {
  const held = asks[sessionId];
  const resumed = held && held.toolCallId === toolCallId;
  return {
    ...asks,
    [sessionId]: {
      sessionId,
      toolCallId,
      questions,
      currentIndex: resumed ? held.currentIndex : 0,
      answers: resumed ? { ...held.answers } : {},
    },
  };
}

/** The batch store with `sessionId`'s ask removed (answered or cancelled). */
export function closeAsk(asks: QuestionAsks, sessionId: string): QuestionAsks {
  if (!(sessionId in asks)) return asks;
  const next = { ...asks };
  delete next[sessionId];
  return next;
}

/**
 * The one batch the modal may render, or `null`.
 *
 * The gate is ownership: a batch shows only over a cell that is ON SCREEN, and
 * the active cell wins, so the chat being read never has another chat's
 * question thrown over it. In the single-chat layout `onScreenSessionIds` holds
 * exactly the active cell, which reduces this to "the asking chat is the one
 * you are looking at". In the grid EVERY cell is on screen — the layout the
 * host already treats as all-sessions-mounted — so a batch there is not hidden
 * (that would strand the engine with no modal anywhere); tab order breaks the
 * tie deterministically.
 */
export function visibleAsk(
  asks: QuestionAsks,
  activeSessionId: string | null,
  onScreenSessionIds: readonly string[],
): QuestionAskEntry | null {
  if (activeSessionId && onScreenSessionIds.includes(activeSessionId) && asks[activeSessionId]) {
    return asks[activeSessionId];
  }
  for (const id of onScreenSessionIds) {
    if (asks[id]) return asks[id];
  }
  return null;
}

/**
 * The `permission` post that ANSWERS a batch, addressed to the asking chat.
 *
 * The head answer keeps the single-question wire shape byte-for-byte, so a
 * one-question ask replies exactly as it did before batching existed; the rest
 * ride `answers`, which the engine maps one-per-question.
 */
export function answerPost(
  ask: QuestionAskEntry,
  answers: ReadonlyArray<{ optionId: string; answerText?: string }>,
): Record<string, unknown> {
  const head = answers[0];
  return {
    type: 'permission',
    toolCallId: ask.toolCallId,
    sessionId: ask.sessionId,
    optionId: head?.optionId ?? '',
    ...(head?.answerText ? { answerText: head.answerText } : {}),
    ...(answers.length > 1 ? { answers: answers.map((a) => ({ ...a })) } : {}),
  };
}

/**
 * The `permission` post that CANCELS a batch, addressed to the asking chat.
 *
 * Dropping the entry alone is not enough: the engine is blocked on an answer,
 * and a cancel it never hears leaves the turn hung forever.
 */
export function cancelPost(ask: QuestionAskEntry): Record<string, unknown> {
  return { type: 'permission', toolCallId: ask.toolCallId, sessionId: ask.sessionId, optionId: null };
}
