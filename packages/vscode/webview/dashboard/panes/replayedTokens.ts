// replayedTokens.ts — t-q910fo: the one thing a RESTORED tool result is read
// differently for, and the reason it is read differently only there.
//
// Chats recorded before 0.4.140 have a `0 / 0` sub-agent token rider stored in
// their log: back then the engine posted whatever summing the child's stored
// messages gave, and an assistant message is written with a ZEROED tokens object
// the moment its turn starts. Replaying one prints `0 tokens` on the row — a
// claim that the agent spent nothing, when nobody ever measured it. The drawer's
// own rule (subagentTokens.ts) is that BLANK is the honest answer there.
//
// NO MIGRATION. The stored logs are not rewritten: the fix is a filter at the one
// place the old shape is read, so a chat recorded today and a chat recorded in
// August both render the truth, and nothing has to walk anyone's history.
//
// LIVE UPDATES ARE UNTOUCHED, deliberately. A child mid-first-step is the case
// the engine's own `taskTokensMeasured` already covers on the wire; whatever a
// live `0 / 0` does today it must keep doing, because this lane changed nothing
// about the live path and a filter here would be a second, invisible opinion on
// it. `chatRestore.ts` is the only caller.

import type { SubagentTokens } from './subagentTokens';

/**
 * t-q910fo. Does this rider say anything? MIRROR of the engine's own
 * `taskTokensMeasured` (packages/engine/src/session/task-result.ts), and true for
 * the same reason: an assistant message is written with a ZEROED tokens object the
 * moment a turn starts, so summing the stored messages of a child that was never
 * billed gives a perfectly well-formed `0 / 0`. A real round trip always costs
 * input, so all-zero means "created, not billed" — not "spent nothing".
 *
 * The engine has refused to SEND such a rider since 0.4.140. Chats recorded before
 * it have one stored in their log, and this is what the replay reads it with.
 */
function tokensMeasured(t: SubagentTokens | undefined): boolean {
  if (!t) return false;
  return (t.input ?? 0) > 0 || (t.output ?? 0) > 0;
}


/** The two counters that decide, off an unverified logged payload. Anything that
 *  is not a finite number is left out, so a junk field reads as absent rather
 *  than as zero. Mirrors the host decoder's own `count` rule (acpTaskTokens.ts). */
function counters(value: unknown): SubagentTokens | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return { ...{ input: num(raw.input) }, ...{ output: num(raw.output) } };
}

/** A stored tool-result payload with a never-billed token rider removed. Returns
 *  the SAME object when there is nothing to drop, so a restore of a modern chat
 *  copies nothing. */
export function replayedResult(result: Record<string, unknown>): Record<string, unknown> {
  if (!('taskTokens' in result)) return result;
  const tokens = counters(result.taskTokens);
  // A rider with NEITHER counter readable is not the stored-zero case — it is an
  // unknown shape, and dropping it would be this file guessing. Only a rider that
  // states a spend, and states zero, is refused.
  if (tokens === undefined || (tokens.input === undefined && tokens.output === undefined)) return result;
  if (tokensMeasured(tokens)) return result;
  // The KEY goes, not a zeroed value: `mergeTaskRiders` writes if present, so an
  // empty object would still land on the card and still print a figure.
  const { taskTokens: _dropped, ...rest } = result;
  return rest;
}
