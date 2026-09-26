// Settle a finished agent run: run the single prompt, guard against the engine dying as the
// run ends, persist the done marker, and patch the row idle. Both runCreate and runStart call
// this, so there is one completion call site.

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

/** Run the task's single prompt to completion and settle the row; a throw (engine death)
 *  propagates to the caller's catch, which errors the row. */
export async function completeRun(
  ctx: RunContext, root: string, id: string, sessionId: string, prompt: string,
): Promise<void> {
  const stopReason = await ctx.host.promptSession(sessionId, prompt);
  // A dead session at resolution means the engine died as the run ended — fail it rather than
  // freeze a fake 'idle'.
  if (!ctx.host.sessionAlive(sessionId)) throw new Error('engine died as the run ended');
  persistDone(root, id, stopReason); // stays 'idle' across a reload, not 'detached'
  // The agent finished its turn: the linked ticket is Done, NOT Merged - nothing
  // has reached main yet (apply.ts stamps merged on a clean apply).
  stampFold(root, id, 'done', `fold finished (${stopReason})`);
  ctx.patch(id, { state: 'idle', stopReason });
  // t-w2txb2 (owner decision 2026-09-24): a finished fold's engine closes instead of idling until
  // Cancel / Delete / window close; t-wdyi2t: as soon as no view shows the chat (ParkHost.finished). The session stays, so Chat opens the same transcript and its next
  // message starts the engine again. Refused while the engine still runs work (a background sub-agent or
  // job); the elastic tracker parks it later. Never fails the run.
  void ctx.host.parkSession?.(sessionId).catch(() => undefined);
}
