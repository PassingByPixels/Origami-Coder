// claudeCodePill.ts — putting an ACCOUNT-wide headroom reading onto one
// bound cell's badge.
//
// Fixes: the badge was fed only by `rate_limit_event`, sent once an account
// is NEAR a limit, so a plan with headroom showed no badge at all. A live
// `rate_limit_event` is this session's own measurement and always wins.

import { adoptAccountPill } from '../claudeCode/sessionState';
import { readPlanUsage, type PlanUsageDeps } from '../claudeCode/planUsage';
import { boundCell, boundCellIds } from './claudeCodeCells';

/** The slice a refresh needs — its own interface so `refreshAllPlanUsage`
 *  doesn't need a whole `ClaudeCodeHost`. */
export interface PlanUsageHost {
  post(msg: Record<string, unknown>): void;
  log(line: string): void;
    /**
     * The read's IO. Absent means NO READ — deliberately, unlike this
     * feature's other seams. A test host that forgets this would otherwise
     * open the user's real credential file and put a bearer token on a socket
     * from inside a green test run.
     */
  planUsage?: PlanUsageDeps;
}

/**
 * Fill this cell's headroom badge from the account read, if it still needs
 * one. Lazy — called on bind, at turn end, and when the model bar opens —
 * never on a timer. Fire and forget: a turn must not wait on a usage read.
 */
export function refreshPlanUsage(host: PlanUsageHost, sessionId: string): void {
  const deps = host.planUsage;
  if (!deps) return;
  const cell = boundCell(sessionId);
  if (!cell || cell.state.pillSource === 'event') return;
  void readPlanUsage(deps).then((pill) => {
    // Re-resolved rather than closed over: the read is asynchronous, and a cell
    // unbound while it was in flight has already had its badge RETRACTED
    // (claudeCodeCell.unbindCell). It must not come back on an engine chat.
    const live = boundCell(sessionId);
    if (!live) return;
    for (const post of adoptAccountPill(live.state, pill)) host.post(post);
  }).catch(() => undefined);
}

/** Every bound cell at once. The model-bar message carries no session id, and
 *  the reading is account-wide anyway, so one call answers for all of them. */
export function refreshAllPlanUsage(host: PlanUsageHost): void {
  for (const id of boundCellIds()) refreshPlanUsage(host, id);
}
