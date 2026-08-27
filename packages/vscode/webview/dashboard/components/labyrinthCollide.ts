// THE anti-collision rule for the flight strip's labels — one implementation,
// used by every row of text the strip prints.
//
// Generalised out of labyrinthCaptions.ts when the owner's UAT showed the
// TIME-AXIS failing exactly as the captions had: "11:57:17:43   11:57:46", two
// clocks drawn straight through each other into nonsense. The captions were
// already gated; the clock row is a DIFFERENT render path (LabyrinthNode draws
// it at a fixed y under the lowest lane, not on the marker's own lane) and was
// never covered. Two independent rules that can disagree about the same strip
// is the outcome this file exists to prevent — so the caption rule moved here
// rather than being copied.
//
// GREEDY, not pairwise. Pairwise drops BOTH halves of every colliding pair, so
// a dense strip ends up with no labels at all; greedy keeps the leftmost of a
// crowd and then the next one that CLEARS it, which yields a monotone set whose
// density follows the room actually available.
//
// DROP, not stagger and not shorten. Staggering onto a second row only doubles
// the density a collision needs, and two steps in the same millisecond share an
// x exactly — they would collide on whichever row they were staggered onto.
// Shortening cannot help either: at |dx| = 0 any width above zero overlaps.
// Dropping is the only rule that is correct at arbitrary density.

/** One candidate label. */
export interface Label {
  /**
   * Labels collide only within a row. Captions use the marker's own lane y, so
   * two steps at the same instant on different lanes both print; the clock row
   * is ONE row whatever the lane, because that is where it is drawn.
   */
  row: number;
  x: number;
  /** Half the label's real drawn width — it is anchored on its middle. */
  half: number;
  /**
   * false for a candidate that would print nothing anyway (a step with no
   * timestamp has no clock). It counts as hidden, but must NOT reserve space
   * and push a label that does print off the strip.
   */
  printed?: boolean;
}

/**
 * Per-label: must this one be dropped to keep the strip readable?
 *
 * Nothing is claimed by the absence — the marker is still drawn, still
 * hoverable (its <title> carries the full text), still clickable, and the
 * inspector still shows every field.
 */
export function collisionHidden(labels: readonly Label[]): boolean[] {
  const hidden = labels.map((l) => l.printed === false);
  const rows = new Map<number, number[]>();
  labels.forEach((l, i) => {
    if (hidden[i]) return;
    const row = rows.get(l.row);
    if (row) row.push(i);
    else rows.set(l.row, [i]);
  });
  for (const row of rows.values()) {
    // List order need not be x order: a background sub-agent's steps are
    // inlined at its spawn but placed by their own, much later, clock.
    row.sort((a, b) => labels[a]!.x - labels[b]!.x || a - b);
    let kept = -1;
    for (const i of row) {
      const clear = kept < 0 || labels[i]!.x - labels[kept]!.x >= labels[i]!.half + labels[kept]!.half;
      if (clear) kept = i;
      else hidden[i] = true;
    }
  }
  return hidden;
}
