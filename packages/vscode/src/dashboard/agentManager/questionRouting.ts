// Pure decision leaves for routing an engine QUESTION. The engine emits no dedicated
// notification — both ask_user_question and plan_exit's build-agent switch surface as a
// standard permission ask — but a real permission ask always carries allow_always and a
// question never does, a proven, ambiguity-immune discriminator. A background agent's
// question must never be auto-answered (an earlier incident misfired the user's choice by
// auto-picking the first option).

import type { QuestionAsk } from '../../questionBatch';

/** A buffered, unanswered question-permission for a background agent with no view mounted;
 *  holds only what a later-mounting view needs to re-render. */
export interface BufferedQuestionPerm {
  toolCallId: string;
  title: string;
  kind: string;
  target?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** The whole batch (t-xum9v2), so a replay is not cut to the head question. */
  questions?: ReadonlyArray<QuestionAsk>;
}

/** A requestPermission ask is question-shaped when it offers no allow_always option —
 *  disjoint from a real permission ask in both directions. */
export function isQuestionShaped(options: ReadonlyArray<{ kind: string }>): boolean {
  return !options.some((o) => o.kind === 'allow_always');
}

/** Buffer this ask instead of the auto-decision only for a background agent's question with
 *  no view mounted; runs before the auto-decision so a question can never reach it. */
export function shouldBufferQuestion(
  kind: 'chat' | 'agent' | undefined,
  mounted: boolean,
  options: ReadonlyArray<{ kind: string }>,
): boolean {
  return kind === 'agent' && !mounted && isQuestionShaped(options);
}

/** What happens to a buffered question when a view mounts: post it while the turn is live,
 *  drop it (caller drains its respond) once ended, none if nothing is buffered. */
export function questionReplayAction(hasBuffer: boolean, turnBusy: boolean): 'post' | 'drop' | 'none' {
  if (!hasBuffer) return 'none';
  return turnBusy ? 'post' : 'drop';
}
