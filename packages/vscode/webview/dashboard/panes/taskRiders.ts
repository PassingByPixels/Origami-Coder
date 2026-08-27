// taskRiders.ts — the `task` riders a tool card carries, and the one rule for
// merging them: WRITE IF PRESENT, NEVER OVERWRITE.
//
// The engine only learns a sub-agent's session id, background flag, model and
// terminal state once the CHILD SESSION EXISTS — which is after the pending
// `tool_call` for the spawning `task` already went out. So none of these arrive
// on the call; they land on later updates, in no guaranteed order, and an update
// carrying none of them must not erase what an earlier one delivered.
//
// EXTRACTED from chatToolMsg.ts, which was at 180/180 when `taskDone` had to
// join the set, and kept OUT of subagentInbox.ts because that file owns where a
// side-channel event GOES, not what a card's fields mean.
//
// `taskDone` is the one that bites. The drawer retires a BACKGROUND row on that
// field ALONE (subagentEntry.ts `stillOut`: `if (m.taskBackground === true)
// return !m.taskDone`), so a marker that fails to reach the card is a sub-agent
// shown as "running" forever. Both the live stream and the reload replay run
// through this function, which is why the rule lives in exactly one place.

import type { SubagentCard } from './subagentInbox';

/** The rest of the task riders a tool card carries. Separate from SubagentCard
 *  because the drawer never reads these — only the merge below writes them. */
export interface TaskRiderCard extends SubagentCard {
  taskResumed?: boolean;
  taskBackground?: boolean;
  taskModel?: string;
}

/** A finite, positive epoch-ms stamp, or undefined for anything else. Mirrors
 *  acpTaskMeta.ts's own guard because the RESTORE path replays a logged payload
 *  rather than a decoded one, so the wire's junk reaches this side too. */
function stamp(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** A terminal marker, or undefined for anything that is not one. Anything the
 *  engine has not settled leaves the card's existing value alone. */
export function taskDoneOf(value: unknown): 'completed' | 'error' | undefined {
  return value === 'completed' || value === 'error' ? value : undefined;
}

/** Merge the task riders an UPDATE carries onto the card they belong to. */
export function mergeTaskRiders<T extends TaskRiderCard>(
  messages: readonly T[],
  existing: T,
  msg: Record<string, unknown>,
): void {
  const taskSessionId = typeof msg.taskSessionId === 'string' ? msg.taskSessionId : '';
  if (taskSessionId) {
    // The continuation check reruns here, against every OTHER card in this chat.
    existing.taskResumed = messages.some((mm) => mm !== existing && mm.taskSessionId === taskSessionId);
    existing.taskSessionId = taskSessionId;
  }
  if (msg.taskBackground === true) existing.taskBackground = true;
  if (typeof msg.taskModel === 'string' && msg.taskModel) existing.taskModel = msg.taskModel;
  const done = taskDoneOf(msg.taskDone);
  if (done) existing.taskDone = done;
  // The child's own span, from the engine's stored tool state. WRITE-IF-PRESENT
  // like the rest — but the END is write-ONCE, because a detached child's
  // marker can be re-emitted (the injected turn's part updates more than once
  // live) and each re-emission stamps a LATER `Date.now()`. First wins keeps a
  // finished sub-agent's total from creeping upward as the parent turn runs on.
  const startedAt = stamp(msg.taskStartedAt);
  if (startedAt) existing.taskStartedAt = startedAt;
  const endedAt = stamp(msg.taskEndedAt);
  if (endedAt && existing.taskEndedAt === undefined) existing.taskEndedAt = endedAt;
}
