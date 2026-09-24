// nestRelease.ts — t-sc093o: the OLD owner's side of a take-over (L5).
//
//   nest/release {sessionId, newOwner, seq} arrives from the desk that took it
//   -> nest_release {sessionId, owner: newOwner}: stop the turn, flip owner_id
//   -> the release says this desk's seq after the stop. Past the seq the new
//      owner took it at = this desk wrote on (a turn stop, or offline work):
//      nest_reconcile {sessionId, remoteSeq: seq, owner} saves those events as
//      a fork and cuts the original back to `have`; then the original is
//      pulled from the new owner from there, so the two desks hold the same.
//
// Nothing is deleted: the fork holds every local event (L5 report).

import type { NestReconcileResult, NestReleaseResult } from './nestContract';
import { pullSession, type NestPuller } from './nestPull';

export interface NestReleaseHost extends NestPuller {
  status?(text: string): void;
}

/** `released` runs right after the owner flip, before any reconcile or pull
 *  (t-t7lfho: an open pane of the chat shows the hand-over at once). */
export async function releaseHere(hub: NestReleaseHost, sessionId: string, newOwner: string, takenAt?: number, released?: () => void): Promise<void> {
  const r = await hub.call<NestReleaseResult>('nest_release', { sessionId, owner: newOwner });
  if ('refused' in r) {
    hub.status?.(`nest release: ${sessionId} ${r.refused}`);
    return;
  }
  released?.();
  if (takenAt === undefined || r.seq <= takenAt) return;
  const rec = await hub.call<NestReconcileResult>('nest_reconcile', { sessionId, remoteSeq: takenAt, owner: newOwner });
  if ('refused' in rec) {
    hub.status?.(`nest reconcile: ${sessionId} ${rec.refused}`);
    return;
  }
  if (rec.result === 'forked') await pullSession(hub, sessionId, rec.owner, rec.owner);
}
