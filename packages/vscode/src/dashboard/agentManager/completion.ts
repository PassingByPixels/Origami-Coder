// Agent Manager - completion.ts: settle a finished agent run. Extracted from the
// now-deleted run-completion module, which used to own both a verified-loop
// completion and the plain single-prompt completion; only the plain path remains:
// run the one prompt, guard against an engine that died as the run ended, persist
// the done marker, and patch the row idle. run.ts calls this from both runCreate
// and runStart, so there is ONE completion call site per lifecycle.

import { loadState, saveState } from './state';
import { stampFold } from './tickets';
import type { RunContext } from './run';

/** Mark a record done (a run reached idle) so it seeds 'idle' - not 'detached' -
 *  across a window reload. Re-reads state immediately before the write. */
function persistDone(root: string, id: string, stopReason: string): void {
  const state = loadState(root);
  const rec = state.worktrees.find((r) => r.id === id);
  if (rec) { rec.done = { stopReason, at: Date.now() }; saveState(root, state); }
}

/**
 * Run the task's single prompt to completion and settle the row. A throw here
 * (engine death) propagates to the caller's catch, which errors the row.
 */
export async function completeRun(
  ctx: RunContext, root: string, id: string, sessionId: string, prompt: string,
): Promise<void> {
  const stopReason = await ctx.host.promptSession(sessionId, prompt);
  // Death-proof: a healthy finish leaves the child ALIVE at idle. A dead session
  // at resolution means the engine died as the run ended - fail it (no done
  // marker) rather than freeze a fake 'idle'.
  if (!ctx.host.sessionAlive(sessionId)) throw new Error('engine died as the run ended');
  persistDone(root, id, stopReason); // stays 'idle' across a reload, not 'detached'
  // The agent finished its turn: the linked ticket is Done, NOT Merged - nothing
  // has reached main yet (apply.ts stamps merged on a clean apply).
  stampFold(root, id, 'done', `fold finished (${stopReason})`);
  ctx.patch(id, { state: 'idle', stopReason });
}
