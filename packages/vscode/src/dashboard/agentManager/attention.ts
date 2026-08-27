// Agent Manager - attention.ts (S7, 2026-07-22): the pure, vscode-free decision
// leaves for the "needs you" attention surface. A background agent that asks a
// QUESTION while no view is mounted for it must be flagged on the board (a row
// chip + a toast + the status-bar aggregate) instead of the run hanging silently;
// and a mounted agent's permission ask must be FORWARDED to that surface rather
// than auto-answered. These helpers are the testable cores the DashboardPanel
// wiring threads together; keeping them here (not in the panel) makes each
// decision a unit test instead of a full panel/host harness.

/** A view is mounted for `sessionId` when the main panel is showing it, a solo
 *  editor tab exists for it, OR the sidebar is in grid layout (which tiles EVERY
 *  session as a visible cell). Inputs are cheap host-side reads, so this stays a
 *  pure boolean. soloPanels is anything with a `.has` (real Map, a Set in tests);
 *  gridActive is the sidebar's last-reported grid state. */
export function isSessionMounted(
  sessionId: string,
  activeSessionId: string | null,
  soloPanels: { has(key: string): boolean },
  gridActive = false,
): boolean {
  return gridActive || activeSessionId === sessionId || soloPanels.has(sessionId);
}

/** Collapse whitespace and clip a question to a board-legible preview (default 80
 *  chars, ellipsised). Used for the row-chip tooltip and the toast body. */
export function questionPreview(question: string, max = 80): string {
  const q = (question ?? '').replace(/\s+/g, ' ').trim();
  return q.length <= max ? q : `${q.slice(0, max - 1).trimEnd()}…`;
}

export interface AggregateCounts { running: number; needYou: number; }

/** Count live work across every repo column: `running` = provisioning/working rows;
 *  `needYou` = rows carrying a needsYou attention (a pending question). A row's
 *  needsYou is projected only WHILE the row is in progress (rows.ts), so an
 *  answered / completed run contributes 0 without any extra bookkeeping here. */
export function boardAggregate(
  repos: ReadonlyArray<{ rows?: ReadonlyArray<{ state: string; needsYou?: unknown }> }> | undefined,
): AggregateCounts {
  let running = 0;
  let needYou = 0;
  for (const repo of repos ?? []) {
    for (const row of repo.rows ?? []) {
      if (row.state === 'working' || row.state === 'provisioning') running++;
      if (row.needsYou) needYou++;
    }
  }
  return { running, needYou };
}

/** The status-bar label, or null to HIDE the item. Shown only while the board has
 *  live work (running > 0); the `- M need you` half is omitted when M is 0. */
export function aggregateText(c: AggregateCounts): string | null {
  if (c.running === 0) return null;
  const base = `Agents: ${c.running} running`;
  return c.needYou > 0 ? `${base} · ${c.needYou} need you` : base;
}

/** onPermissionRequest composition (S7): a MOUNTED asking view FORWARDS; an unmounted one falls
 *  to the S6e auto decision. Pure so a test pins the real branch (autoDecide is a thunk). */
export function resolvePermission<T extends { action: string }>(mounted: boolean, autoDecide: () => T): { action: 'forward' } | T {
  return mounted ? { action: 'forward' } : autoDecide();
}

/** Resolve every pending permission ask as cancelled (deny) so a Stop, or a closed
 *  forward-surface, never leaves an agent hanging on an unanswered respond(). */
export function drainPermissions(pending: Map<string, (optionId: string | null) => void>): void {
  for (const [id, respond] of pending) { respond(null); pending.delete(id); }
}
