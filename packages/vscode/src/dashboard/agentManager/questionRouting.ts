// Agent Manager - questionRouting.ts (S7.1, 2026-07-22): the pure decision leaves
// for routing an engine QUESTION. The engine emits NO origami/question
// notification; ask_user_question AND plan_exit's "switch to build agent?" both
// surface as a standard session/request_permission ask (packages/engine/src/
// acp/question.ts builds one PermissionOption per choice). A REAL permission ask
// always carries the fixed allow_once / allow_always / reject_once triple
// (acp/permission.ts); a question never carries an allow_always. That absence is
// the safe discriminator - proven disjoint both directions and immune to
// title/kind ambiguity (external_directory also maps toolCall.kind 'other'). A
// background agent's question must NEVER be auto-answered (the S7.1 incident: the
// auto path picked the first option as "consent" and misfired the user's choice),
// so these keep the routing a unit test over the thin DashboardPanel wiring.

/** A buffered, still-unanswered question-permission for a background agent with no
 *  view mounted. The respond callback lives in session.pendingPermissions (keyed by
 *  toolCallId); this holds only what a later-mounting view needs to re-render the ask. */
export interface BufferedQuestionPerm {
  toolCallId: string;
  title: string;
  kind: string;
  target?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** A requestPermission ask is QUESTION-shaped when it offers NO allow_always option.
 *  Disjoint from a real permission ask (which always includes allow_always) in both
 *  directions; a one-option question (single choice) is still question-shaped. */
export function isQuestionShaped(options: ReadonlyArray<{ kind: string }>): boolean {
  return !options.some((o) => o.kind === 'allow_always');
}

/** Buffer (defer) this ask instead of letting it fall to the S6e auto-decision?
 *  TRUE only for a BACKGROUND agent (kind:'agent') whose QUESTION arrived with no
 *  view mounted. A mounted agent forwards to its view; a chat always forwards; a
 *  real permission (has allow_always) is not question-shaped and keeps the auto
 *  path. Runs BEFORE the auto-decision so a question can never reach it. */
export function shouldBufferQuestion(
  kind: 'chat' | 'agent' | undefined,
  mounted: boolean,
  options: ReadonlyArray<{ kind: string }>,
): boolean {
  return kind === 'agent' && !mounted && isQuestionShaped(options);
}

/** What replaySessionsTo does with a session's buffered question-permission when a
 *  view mounts: POST it to the new view while the turn is still live; DROP it (the
 *  caller then drains its respond so nothing hangs) once the turn ended; NONE when
 *  nothing is buffered. Mirrors the S7 turnBusy gate for the dead-notification buffer. */
export function questionReplayAction(hasBuffer: boolean, turnBusy: boolean): 'post' | 'drop' | 'none' {
  if (!hasBuffer) return 'none';
  return turnBusy ? 'post' : 'drop';
}
