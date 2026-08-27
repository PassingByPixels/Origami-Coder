// What a turn's terminal `stop_reason` MEANS, and what the transcript calls it.
//
// Lifted VERBATIM out of ChatPane.svelte, which was sitting at 2699/2700 when
// the image lightbox needed a mount line there — the ratchet's own remedy
// (extract, never raise). This is the honest piece to take: two pure switches
// over a wire taxonomy, with two call sites in the pane and one type reference,
// and no DOM anywhere in them. Inline they could only be checked by driving a
// whole `origami/turnEnd` message through a rendered pane; here "an unknown
// label is never promoted to a benign verdict" is one assertion.
//
// The thesis it carries: a budget-walled / no-progress / errored / parked-infra
// turn must NOT read as benign "Continue". `success` is the only verified-done.

export type TurnVerdictKind = 'done' | 'incomplete' | 'parked' | 'unknown';

export interface TurnVerdict {
  kind: TurnVerdictKind;
  /** Raw taxonomy label carried verbatim from the wire. */
  reason: string;
}

// Map a terminal `stop_reason` taxonomy label onto an honest verdict.
// `success` is the only verified-done; `asked_user` parked on a question;
// every error/park terminal is INCOMPLETE (the turn did NOT reach done).
// An empty/unknown label stays `unknown` — it is NEVER silently promoted
// to a benign verdict.
export function verdictForStopReason(stopReason: string): TurnVerdict {
  switch (stopReason) {
    case 'success':
      return { kind: 'done', reason: stopReason };
    case 'asked_user':
      return { kind: 'parked', reason: stopReason };
    case 'error_max_turns':
    case 'error_max_budget':
    case 'error_no_progress':
    case 'error_during_execution':
    case 'park_infra':
      return { kind: 'incomplete', reason: stopReason };
    default:
      return { kind: 'unknown', reason: stopReason };
  }
}

// Human-readable verdict label rendered inline at the end of a turn.
export function verdictLabel(v: TurnVerdict): string {
  switch (v.kind) {
    case 'done':
      return 'Verified done';
    case 'incomplete':
      return `Incomplete: ${v.reason}`;
    case 'parked':
      return 'Parked: awaiting your answer';
    default:
      return v.reason ? `Ended: ${v.reason}` : 'Ended';
  }
}
