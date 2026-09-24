// pickerHint.ts — the ONE line under the model list that explains why the list
// is shorter than the provider's catalog.
//
// Two reasons exist and neither was said out loud before (t-ry6ecn). (1) The
// render cap: 60 of N rows, filter to narrow. (2) A keyless-catalog gateway
// (OpenCode Zen/Go) whose rows were PRUNED — its GET /models is a menu, and the
// entitlement sweep drops what this key cannot call. A pruned row just vanished,
// so "mimo-v2.6-flash-free is gone" read as a picker bug rather than the
// provider's answer, and cost a full investigation to tell apart.
//
// A pure LEAF: no DOM, no host wiring. The host counts (it is the only side that
// saw the catalog), this file words it, the component renders one <span>.

/** What the host saw for one keyless-catalog gateway on its last sweep. */
export interface GatewayNote {
  /** Catalog ids this key could NOT call. */
  hidden: number;
  /** Of those, ids whose name ends in `-free` — Zen's client-locked free tier. */
  hiddenFree: number;
  /** False when the provider block holds no API key at all. */
  keyed: boolean;
}

export interface HintInput {
  /** Rows actually rendered. */
  shown: number;
  /** Rows the filter left, before the render cap. */
  total: number;
  cap: number;
  /** Absent for a provider that is not a keyless-catalog gateway. */
  note?: GatewayNote;
}

/** Why the free-tier ids are missing. Named as the gateway names it, so a user
 *  who searches the phrase finds OpenCode's own answer rather than ours. */
const FREE_TIER = 'the free tier works only inside the OpenCode client';

/**
 * The hint line, or '' when the list needs no explanation.
 *
 * The cap and the prune are reported TOGETHER when both apply: a user looking at
 * 60 of 310 rows with 12 pruned needs both halves, and two stacked lines in a
 * popover that already scrolls is worse than one sentence.
 */
export function hintLine(input: HintInput): string {
  const parts: string[] = [];
  if (input.total > input.cap) parts.push(`Showing ${input.shown} of ${input.total} — filter to narrow.`);
  const note = input.note;
  if (note && !note.keyed) {
    parts.push('No API key set for this provider — add one in Settings to see what it serves.');
  } else if (note && note.hidden > 0) {
    const models = note.hidden === 1 ? '1 model' : `${note.hidden} models`;
    parts.push(
      note.hiddenFree > 0
        ? `${models} hidden: not entitled on this key — ${FREE_TIER}.`
        : `${models} hidden: not entitled on this key.`,
    );
  }
  return parts.join(' ');
}
