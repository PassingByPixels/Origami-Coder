// permissionSettle.ts — a permission ask can be resolved from somewhere OTHER
// than this bar's own click: a phone approves it (a signed approve, or a
// signed YOLO that flips the session to bypass and releases every ask parked
// on it — attention.ts's releaseBypassedPermissions), or a sibling popped-out
// tab answers the SAME sub-agent-forwarded ask. Either way the host posts
// `permissionAudit` — the SAME message sessionRowState.ts already reads to
// clear a chat row's waiting dot — and ChatPane had no handler for it at all:
// the bar sat on an ask someone else had already answered until the owner
// clicked it themselves.
//
// `permissionAudit` carries NO sessionId (DashboardPanel.ts posts it as a
// global audit-feed entry, same fact sessionRowState.ts's own comment
// records), so the caller offers the toolCallId to EVERY session; a miss
// here — this session never held it, or the LOCAL click already promoted
// past it — is a no-op, so settling the same audit twice can never
// double-promote the queue.
//
// enqueuePermission/promoteNextPermission moved in from ChatPane.svelte
// verbatim (no behaviour change) so settlePermissionAudit could reuse the
// exact promotion it mirrors, and to pay ChatPane's line cap for the new
// case this file exists to serve.

/** The ask itself — one bar prompt. */
export interface PermissionAsk {
  toolCallId: string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
  /** Ground-truth target (path / dir / url / command) + action kind, shown
   *  on the bar so the user approves with context, not a bare title. */
  target?: string;
  action?: string;
  /** The literal shell command for an execute ask, shown verbatim (monospace,
   *  wrap/scroll) so the user sees exactly what they're approving. */
  command?: string;
}

/** The two fields this rule owns on a chat session, and nothing else. */
export interface PermissionQueueTarget {
  /** The ask currently ON the permission bar — the HEAD of the queue below. */
  permission: PermissionAsk | null;
  /** Asks that arrived while another was still on the bar, arrival order. */
  permissionQueue: PermissionAsk[];
}

/** Park a newly-arrived ask: straight onto the bar if it's free, else queued.
 *  Re-delivery of an ask already known (same toolCallId) is ignored, so a
 *  repeat can't stack a second copy of a prompt the user still hasn't answered. */
export function enqueuePermission(s: PermissionQueueTarget, ask: PermissionAsk): void {
  if (s.permission?.toolCallId === ask.toolCallId) return;
  if (s.permissionQueue.some((q) => q.toolCallId === ask.toolCallId)) return;
  if (s.permission) s.permissionQueue = [...s.permissionQueue, ask];
  else s.permission = ask;
}

/** Clear the answered ask and promote the next one — never leave the bar empty
 *  while asks are still waiting, which is the whole stall. */
export function promoteNextPermission(s: PermissionQueueTarget): void {
  s.permission = s.permissionQueue[0] ?? null;
  s.permissionQueue = s.permissionQueue.slice(1);
}

/** A `permissionAudit` for `toolCallId` reaching a session that may not be the
 *  one that resolved it: if it is the bar's own ask, promote exactly like a
 *  local click; if it is queued, drop it from the queue with NO promotion —
 *  the bar is still waiting on whatever is already on it; otherwise this
 *  session has nothing to do — its own click already settled it, or the
 *  ask belongs to a different session entirely. */
export function settlePermissionAudit(s: PermissionQueueTarget, toolCallId: string): void {
  if (s.permission?.toolCallId === toolCallId) {
    promoteNextPermission(s);
    return;
  }
  if (s.permissionQueue.some((q) => q.toolCallId === toolCallId)) {
    s.permissionQueue = s.permissionQueue.filter((q) => q.toolCallId !== toolCallId);
  }
}
