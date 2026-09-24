// ledgerResetCopy.ts — what the sub-agent ledger's two reset dialogs SAY.
//
// Extracted from SubagentLedger.svelte (t-fisfs5 R5) when the per-column reset
// gained its own ConfirmModal and the sheet went over its cap: the sheet is
// markup and CSS, and this is prose two dialogs must not let drift apart.

/** The half both dialogs must carry. `removeSubagentToolOverrides`
 *  (src/dashboard/subagentToolReset.ts) deletes every `permission.<tool>` entry
 *  whose value is a plain action STRING, and nothing on disk marks which of
 *  them this sheet wrote — so one the user typed by hand goes with them. A
 *  path-scoped OBJECT rule, and the block's other keys, survive. */
export const RESET_CAVEAT =
  'A plain tool: action rule you wrote by hand in origami.json is removed too — nothing marks which of them this sheet wrote. Your other keys — model, prompt, description, and any path-scoped rule — are left alone.';

/** The whole sheet: every agent type at once. */
export const resetAllBody = (): string =>
  `This removes the overrides this sheet wrote for every agent type, so each one goes back to what its own definition says. ${RESET_CAVEAT}`;

/** One column. `agent` is null only while the dialog is shut. */
export const resetColumnBody = (agent: string | null): string =>
  `This removes the overrides this sheet wrote for ${agent ?? 'this agent'}, so it goes back to what its own definition says. ${RESET_CAVEAT}`;
