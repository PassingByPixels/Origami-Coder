// subagentRowControls.ts — WHICH controls one drawer row gets.
//
// EXTRACTED from SubagentRow.svelte at 151/150 when the per-row Stop landed
// (t-q910fo). The markup already deferred the DRAWING of the controls to
// SubagentRowActions.svelte; this is the other half — the four rules that say
// whether each one exists at all — and they are exactly the kind of thing that
// was being asserted through a render because it had nowhere else to live.
//
// Pure and DOM-free, like its siblings subagentFormat.ts and subagentTokens.ts.
import type { SubagentRow } from './subagentRows';

export interface RowControls {
  /** The child has a session of its own, so there is a transcript to open. */
  canOpen: boolean;
  /** The row has an activity tail worth folding. */
  canFold: boolean;
  /** Only a FAILED spawn — it never settles on its own, so it needs a way out. */
  canDismiss: boolean;
  /** t-q910fo. RUNNING, with a session to address, on a surface that offers the
   *  act at all. A settled child has no job left to abort and a spawn that never
   *  reached a session was never registered as one, so a Stop on either would be
   *  a button that does nothing — worse than no button. */
  canStop: boolean;
}

export function rowControls(row: SubagentRow, stoppable: boolean): RowControls {
  return {
    canOpen: !!row.taskSessionId,
    canFold: !!row.activity,
    canDismiss: row.state === 'failed',
    canStop: stoppable && row.state === 'running' && !!row.taskSessionId,
  };
}
