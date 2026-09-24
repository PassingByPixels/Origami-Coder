// glidepathDraw — two pieces of chart geometry worth testing on their
// own: the curve through the readings, and where the end labels sit.
//
// SEPARATE FROM glidepathMath.ts: that file decides what is TRUE, this
// one decides what is LEGIBLE. PURE — no DOM, no SVG, no measured text —
// so both are testable in jsdom.

export interface Point {
  readonly x: number;
  readonly y: number;
}

const f2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

/**
 * A monotone cubic through the points (Fritsch-Carlson): unlike an
 * ordinary Catmull-Rom, it cannot overshoot — dipping below a reading it
 * just passed, or bulging over 100%. Flat data stays flat; a rise only
 * rises.
 *
 * Empty string for no points, so the result can go straight to a `d`
 * attribute without a guard.
 */
export function monotonePath(pts: readonly Point[]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${f2(pts[0]!.x)},${f2(pts[0]!.y)}`;

  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = pts[i + 1]!.x - pts[i]!.x;
    m[i] = dx[i] === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / dx[i]!;
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i += 1) {
    // A sign change (or a flat) is a turning point: a zero tangent there is what
    // stops the curve overshooting the reading it turns on.
    if (m[i - 1]! * m[i]! <= 0) {
      t[i] = 0;
      continue;
    }
    const w1 = 2 * dx[i]! + dx[i - 1]!;
    const w2 = dx[i]! + 2 * dx[i - 1]!;
    const v = (w1 + w2) / (w1 / m[i - 1]! + w2 / m[i]!);
    t[i] = Number.isFinite(v) ? v : 0;
  }
  t[n - 1] = m[n - 2]!;

  let d = `M${f2(pts[0]!.x)},${f2(pts[0]!.y)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = dx[i]!;
    d +=
      `C${f2(pts[i]!.x + h / 3)},${f2(pts[i]!.y + t[i]! * h / 3)}` +
      ` ${f2(pts[i + 1]!.x - h / 3)},${f2(pts[i + 1]!.y - t[i + 1]! * h / 3)}` +
      ` ${f2(pts[i + 1]!.x)},${f2(pts[i + 1]!.y)}`;
  }
  return d;
}

export interface LabelSlot {
  /** Where the thing being labelled actually is. */
  readonly y: number;
  /** Where its label is drawn after the pass. */
  ly: number;
}

/**
 * Push a stack of end labels apart to `minGap`, inside [top, bottom], so
 * bunched connections don't smear into illegible overlap; a leader line
 * keeps each label tied to its dot.
 *
 * Three passes: pushing down to make room can push the last label off
 * the bottom, so the stack shifts back up and is re-separated upward.
 * Mutates and returns the SAME array, in the caller's order.
 */
export function layoutLabels<T extends LabelSlot>(
  items: T[],
  minGap: number,
  top: number,
  bottom: number,
): T[] {
  const byY = items.slice().sort((a, b) => a.y - b.y);
  for (const it of byY) it.ly = it.y;
  for (let i = 1; i < byY.length; i += 1) {
    if (byY[i]!.ly - byY[i - 1]!.ly < minGap) byY[i]!.ly = byY[i - 1]!.ly + minGap;
  }
  if (byY.length > 0) {
    const over = byY[byY.length - 1]!.ly - bottom;
    if (over > 0) for (const it of byY) it.ly -= over;
    for (let i = byY.length - 2; i >= 0; i -= 1) {
      if (byY[i + 1]!.ly - byY[i]!.ly < minGap) byY[i]!.ly = byY[i + 1]!.ly - minGap;
    }
    const under = top - byY[0]!.ly;
    if (under > 0) for (const it of byY) it.ly += under;
  }
  return items;
}
