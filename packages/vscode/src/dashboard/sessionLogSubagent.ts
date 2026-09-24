// sessionLogSubagent.ts — the message log's two SUB-AGENT writes, split out of
// sessionLog.ts (at 92/115 when the token stamp landed).
//
// Both differ from the tool writes beside them in the same two ways: they find
// their entry by CHILD SESSION id rather than by tool-call id, and neither ever
// appends an entry. A background child's events arrive on their own channel,
// long after its launcher card was logged and completed.

import type { TaskTokens } from '../acpTaskTokens';
import type { SessionMessage } from './sessionLog';

/** The logged card a sub-agent event belongs to, newest first, or undefined.
 *  An event with no card is DROPPED by both writers below: stamping the newest
 *  card instead would mark the WRONG sub-agent, which is silent. */
function subagentCard(log: SessionMessage[], taskSessionId: string): SessionMessage | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind !== 'tool' || !entry.tool) continue;
    const id = entry.tool.call.taskSessionId ?? entry.tool.result?.taskSessionId;
    if (id === taskSessionId) return entry;
  }
  return undefined;
}

/**
 * `subagentDone`: stamp a background child's terminal marker onto its own
 * card. The marker arrives on its own channel, so a restore replayed a card
 * with no `taskDone` and treated a long-dead child as still running. Written
 * onto `result` and `endedAt` because that's what the restore's merge rules
 * read.
 *
 * `tokens` is the child's FINAL spend, off the same settling chunk (t-fdvr2a).
 * Stamped only when it arrived: a marker carrying none must keep the last live
 * figure already on the card, not blank it.
 */
export function logSubagentDone(
  log: SessionMessage[],
  taskSessionId: string,
  state: string,
  endedAt?: number,
  tokens?: TaskTokens,
): void {
  if (!taskSessionId) return;
  const entry = subagentCard(log, taskSessionId);
  if (!entry?.tool) return;
  const done = state === 'error' ? 'error' : 'completed';
  const ended = endedAt === undefined ? {} : { taskEndedAt: endedAt };
  const spend = tokens === undefined ? {} : { taskTokens: tokens };
  entry.tool.result = { ...entry.tool.result, taskSessionId, taskDone: done, ...ended, ...spend };
}

/**
 * `subagentTokens`: keep a RUNNING child's latest total on its card. One field
 * overwritten in place, never an appended entry — the engine re-sends the
 * counters per child step, and a fan-out would bloat every recalled transcript
 * (which is why the chunks themselves are still not logged). Without this a
 * child still working when the window reloads restores with no spend at all.
 */
export function logSubagentTokens(log: SessionMessage[], taskSessionId: string, tokens: TaskTokens): void {
  if (!taskSessionId || !tokens) return;
  const entry = subagentCard(log, taskSessionId);
  if (!entry?.tool) return;
  entry.tool.result = { ...entry.tool.result, taskSessionId, taskTokens: tokens };
}

