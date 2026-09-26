// questionBatch.ts — the extension host's half of the BATCHED-question wire
// contract, both directions, as pure functions.
//
// The engine asks N clarifying questions in ONE ACP `session/request_permission`.
// ACP has no many-questions request, so the batch rides `_meta` — the sanctioned
// extension bag — as `_meta.questions` outbound and `_meta.answers` on the reply.
// The spec forbids assumptions about values at these keys, so every level is
// checked before it is read and a malformed batch is DROPPED rather than
// half-rendered.

/** One question inside a batched ask, as the engine puts it on `_meta.questions`. */
export type QuestionAsk = {
  title: string;
  options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
  /** t-xum9v2: "tick all that apply". Absent on a single-choice question. */
  multiple?: true;
};

/** One answer in a batch reply, positionally matched to its question. */
export type QuestionAnswer = { optionId: string; answerText?: string; optionIds?: string[] };

/** The questions a permission ask carries, or `undefined` when it carries none.
 *  `undefined` is the BACK-COMPAT signal as well as the malformed one: an engine
 *  that predates batching sends no `_meta.questions`, and the caller falls back to
 *  the ask's own `title` + `options`. Neither case may throw. */
export function questionsFromMeta(meta: unknown): QuestionAsk[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const raw = (meta as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: QuestionAsk[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const q = item as { question?: unknown; options?: unknown; multiple?: unknown };
    if (typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length === 0) return undefined;
    out.push({
      title: q.question,
      options: q.options.map((o) => {
        const opt = (typeof o === 'object' && o !== null ? o : {}) as { optionId?: unknown; name?: unknown; kind?: unknown };
        return { optionId: String(opt.optionId ?? ''), name: String(opt.name ?? ''), kind: String(opt.kind ?? 'reject_once') };
      }),
      ...(q.multiple === true ? { multiple: true as const } : {}),
    });
  }
  return out;
}

/** The `questions` field of a webview `requestPermission` post: the whole batch, each
 *  question's `multiple` flag kept (t-xum9v2). `{}` when the ask carried none, so the
 *  webview falls back to title + options. Shared by the live forward and the replay of
 *  a buffered ask, so the two cannot drift. */
export function questionsPost(questions: ReadonlyArray<QuestionAsk> | undefined): { questions?: QuestionAsk[] } {
  if (!questions) return {};
  return { questions: questions.map((q) => ({ title: q.title, options: q.options.map((o) => ({ ...o })), ...(q.multiple ? { multiple: true as const } : {}) })) };
}

/** The `_meta` bag a SELECTED permission outcome replies with, or `undefined` when
 *  it needs none (the plain approve, byte-for-byte as before `_meta` existed).
 *  `answerText` is the head question's free text; `answers` is the whole batch,
 *  which the engine maps one-per-question. Entries are copied because the caller's
 *  array is a webview-owned value crossing into a resolved promise. */
export function replyMeta(
  answerText: string | undefined,
  answers: ReadonlyArray<QuestionAnswer> | undefined,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (answerText) meta['answerText'] = answerText;
  if (answers && answers.length > 0) meta['answers'] = answers.map((a) => ({ ...a, ...(a.optionIds ? { optionIds: [...a.optionIds] } : {}) }));
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** A batch reply read off a webview `permission` message, or `undefined`.
 *  `undefined` means "not a batch" — a single-question ask still replies with a bare
 *  `optionId`. An entry with neither a usable `optionId` nor typed text is dropped
 *  WHOLE, because a short batch would make the engine re-ask the remainder and the
 *  user would see the modal again. */
export function questionAnswers(raw: unknown): QuestionAnswer[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: QuestionAnswer[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined;
    const entry = item as { optionId?: unknown; answerText?: unknown; optionIds?: unknown };
    const optionId = typeof entry.optionId === 'string' ? entry.optionId : '';
    const text = typeof entry.answerText === 'string' ? entry.answerText.trim() : '';
    // t-xum9v2: a multi-select answer. The tick list is the answer, so an empty one
    // ("none apply") is kept; only string ids go on.
    if (Array.isArray(entry.optionIds)) {
      const optionIds = entry.optionIds.filter((id): id is string => typeof id === 'string');
      out.push(text ? { optionId, optionIds, answerText: text } : { optionId, optionIds });
      continue;
    }
    // An empty `answerText` is the same as absent: telling the engine the user
    // answered with nothing is not what happened (the M4.4 rule, per entry).
    if (!optionId && !text) return undefined;
    out.push(text ? { optionId, answerText: text } : { optionId });
  }
  return out;
}
