// Board card status edge — round-2 proposal 18 / CHANGES.md change 35.
// Pure so it is unit-tested directly, without jsdom's layout gap (getComputedStyle
// on a scoped Svelte <style> returns '' in the test DOM — see
// docs/WORKING_ON_ORIGAMI_CODER.md part 6). Shared by TicketCard.svelte
// (triage/todo) and AgentCard.svelte (pending/doing/blocked/done), which is
// also what closes the porting trap: the In progress and Done columns render
// AgentCard's `.am-card`, not TicketCard's `.am-ticket` — a selector keyed
// only to `.am-ticket` misses them, as round-3 change 48 found out.
import type { ColumnId } from './boardBuckets';

const EDGE_TOKEN: Record<ColumnId, string> = {
  triage: '--og-text-muted',
  todo: '--og-chat',
  pending: '--og-accent',
  doing: '--og-warning',
  blocked: '--og-error',
  done: '--og-success',
  merged: '--og-success',
};

/** The CSS `var(...)` expression for a card's top-edge colour in this column. */
export function cardEdgeVar(status: ColumnId): string {
  return `var(${EDGE_TOKEN[status] ?? '--og-border'})`;
}
