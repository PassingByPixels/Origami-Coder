// The geometry of the context sparkline (t-ru1i84) — pure, so the two things that can
// actually be wrong about it are testable without a render: where the points land, and
// what happens when there is only one of them.
//
// jsdom has no layout, so a component test could never check a polyline's shape. This is
// the file that can.

export const TREND_W = 100;
export const TREND_H = 18;
const PAD = 1.5;

/** The polyline's `points`, oldest at the left.
 *
 *  SCALED FROM ZERO, not from the smallest reading: a series that climbed 40k to 42k is a
 *  conversation growing slowly, and a floor at its own minimum would draw that as a cliff.
 *
 *  ONE READING IS A FLAT LINE ACROSS THE CARD, not a dot at the left edge and not nothing:
 *  the card is saying "this is where it stands, and there is no history yet", which is
 *  true and is what one point means. */
export function trendPoints(series: readonly number[] | undefined): string {
  const values = (series ?? []).filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (values.length === 0) return '';
  const top = Math.max(...values, 1);
  const y = (v: number) => TREND_H - PAD - (v / top) * (TREND_H - PAD * 2);
  if (values.length === 1) return `${PAD},${round(y(values[0]))} ${TREND_W - PAD},${round(y(values[0]))}`;
  const step = (TREND_W - PAD * 2) / (values.length - 1);
  return values.map((v, i) => `${round(PAD + i * step)},${round(y(v))}`).join(' ');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
