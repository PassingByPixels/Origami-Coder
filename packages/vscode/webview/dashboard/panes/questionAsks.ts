// questionAsks.ts: per-chat ownership of a batched clarifying-question ask,
// and the gate deciding which batch, if any, the modal may render.
//
// Keyed by sessionId, so each chat owns its batch and batches cannot
// collide. The draft persists here, not in QuestionModal, since leaving the
// tab unmounts the modal but does not dismiss the batch. Pure and DOM-free,
// so the ownership rules are testable with no render.

export type QuestionAskOption = { optionId: string; name: string; kind: string };

/** `multiple` (t-xum9v2): "tick all that apply"; absent on a single-choice question. */
export type QuestionAskQuestion = { title: string; options: QuestionAskOption[]; multiple?: boolean };

/** What the user has entered for one question. Both fields may be empty. */
export type QuestionAskDraft = { optionId: string; answerText: string; optionIds?: string[] };

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
 * One entry per chat: the engine blocks on an answer before asking again.
 * A replay of a buffered ask carries the same toolCallId, so the draft is
 * kept and reset only for a genuinely new ask, never wiping typed answers.
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
 * Ownership gate: a batch shows only over a cell on screen, and the active
 * cell wins, so the chat being read never gets another chat's question. In
 * the grid layout every cell is on screen, so a batch there is never hidden
 * (that would strand the engine with no modal); tab order breaks ties.
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
 * The `permission` post that answers a batch, addressed to the asking chat.
 *
 * The head answer keeps the single-question wire shape byte-for-byte, so a
 * one-question ask replies exactly as it did before batching existed.
 */
export function answerPost(
  ask: QuestionAskEntry,
  answers: ReadonlyArray<{ optionId: string; answerText?: string; optionIds?: string[] }>,
): Record<string, unknown> {
  // A tick list only travels in `answers` (t-xum9v2), so a one-question multi ask
  // sends the array too; a single-choice one keeps the bare shape.
  const batch = answers.length > 1 || answers.some((a) => a.optionIds);
  const head = answers[0];
  return {
    type: 'permission',
    toolCallId: ask.toolCallId,
    sessionId: ask.sessionId,
    optionId: head?.optionId ?? '',
    ...(head?.answerText ? { answerText: head.answerText } : {}),
    ...(batch ? { answers: answers.map((a) => ({ ...a })) } : {}),
  };
}

/**
 * The `permission` post that cancels a batch, addressed to the asking chat.
 *
 * Dropping the entry alone is not enough: the engine blocks on an answer,
 * and an unheard cancel leaves the turn hung forever.
 */
export function cancelPost(ask: QuestionAskEntry): Record<string, unknown> {
  return { type: 'permission', toolCallId: ask.toolCallId, sessionId: ask.sessionId, optionId: null };
}
