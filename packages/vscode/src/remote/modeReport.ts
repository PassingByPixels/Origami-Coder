// Origami Remote — THE DESK TELLING THE PHONE WHAT ITS OWN RECORDS SAY.
//
// `privilege.ts` holds a `ModeRecord` per escalated chat and persists nothing,
// so a restarted app came back with an empty map over a desk still in bypass.
// `remote/mode-state` closes that, once per hydration.
//
// IT IS A REPORT, NOT A GRANT. A grant must carry a signature over a challenge
// this desk minted (`authority.ts`); this says what the desk already decided.
// The phone adopts it whole and drops any bypass it is NOT named in.
//
// WHICH CHATS: the ones `Privilege.outbound` has NAMED to the phone;
// `sessionClosed` takes one back out.

/** The two the phone will adopt; `pending` is the phone's own in-flight state. */
export type ReportedMode = 'ask' | 'yolo';

export interface ModeStateFrame {
  type: 'remote/mode-state';
  v: 1;
  modes: Record<string, ReportedMode>;
}

export class ModeReport {
  private readonly named = new Set<string>();

  /** Every desk -> phone message, read for one fact and consuming none of it. */
  public note(msg: unknown): void {
    const m = msg as { type?: unknown; sessionId?: unknown } | null;
    if (typeof m?.sessionId !== 'string' || !m.sessionId) return;
    if (m.type === 'sessionClosed') this.named.delete(m.sessionId);
    else this.named.add(m.sessionId);
  }

  /** `yolo` is the caller's own session records, keyed by sessionId — the
   *  authority. A chat in bypass is reported even if never named to the phone:
   *  a MISSING entry is a chip that goes on lying until the next hydration. */
  public frame(yolo: ReadonlyMap<string, unknown>): ModeStateFrame {
    const modes: Record<string, ReportedMode> = {};
    for (const sessionId of this.named) modes[sessionId] = yolo.has(sessionId) ? 'yolo' : 'ask';
    for (const sessionId of yolo.keys()) modes[sessionId] = 'yolo';
    return { type: 'remote/mode-state', v: 1, modes };
  }
}
