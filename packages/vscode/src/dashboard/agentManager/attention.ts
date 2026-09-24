// Pure, vscode-free decision helpers for the "needs you" attention surface: a background
// agent's question with no mounted view must be flagged (chip/toast/status-bar), and a
// mounted agent's permission ask must forward to that surface rather than auto-answer.

import { pickAllowOption, type PermOption } from './permissions';

/** A view is mounted for `sessionId` when the main panel shows it, a solo tab exists, or the
 *  sidebar grid tiles it. Pure boolean over cheap host-side reads. */
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

/** Count live work per repo column: running = provisioning/working rows; needYou = rows with
 *  a pending question, projected only while in progress. */
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
export function drainPermissions(pending: Map<string, { respond: (optionId: string | null) => void }>): void {
  for (const [id, entry] of pending) { entry.respond(null); pending.delete(id); }
}

/** A session entering YOLO (bypass) doesn't leave its open asks hanging: the engine already
 *  re-evaluates every pending ask against the new ruleset and releases them all. This answers
 *  each with its own allow option (never `respond(null)`, which the engine reads as reject
 *  and would cascade-reject every other pending ask on the session) — the same audit event an
 *  explicit click posts. */
export function releaseBypassedPermissions(
  pending: Map<string, { respond: (optionId: string | null) => void; options: ReadonlyArray<PermOption> }>,
  post: (msg: { type: 'permissionAudit'; toolCallId: string; action: 'approved' | 'denied'; optionId: string; timestamp: string }) => void,
): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    const optionId = pickAllowOption(entry.options);
    entry.respond(optionId);
    post({ type: 'permissionAudit', toolCallId: id, action: optionId ? 'approved' : 'denied', optionId: optionId ?? 'cancelled', timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) });
  }
}
