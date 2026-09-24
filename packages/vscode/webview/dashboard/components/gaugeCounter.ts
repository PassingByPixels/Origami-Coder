// GAUGE COUNTER — the rolling percentage on the context gauge
// (CHANGES.md round 2, change 27).
//
// One column of ten digits per place. A column shows the digit it is parked
// on; the other nine sit above and below it, and a change slides the column
// so the new digit lands on the line. Ported from react-bits
// Components/Counter, with the reference's Motion spring replaced by a CSS
// transition — no dependency, same reading.
//
// THE SHORT WAY ROUND: a raw `(10 + i - value) % 10` offset makes 9 -> 0 roll
// nine places forward. Anything past five is wrapped by a full ten, so the
// column turns whichever way is nearer.

/** Digits in the number's decimal expansion — `88` is two places, `5` one. */
export function placesOf(value: number): number {
  return String(Math.max(0, Math.trunc(value))).length;
}

/** The digit shown in `place` (0 = most significant of `places`). */
export function digitAt(value: number, place: number, places: number): number {
  const scale = Math.pow(10, places - place - 1);
  return Math.floor(Math.max(0, Math.trunc(value)) / scale) % 10;
}

/**
 * Pure: the translateY, in px, for each of the ten numbers in one column.
 * Index is the number itself (0..9); the digit on the line reads 0.
 */
export function columnOffsets(digit: number, height: number): number[] {
  return Array.from({ length: 10 }, (_, i) => {
    const steps = (10 + i - digit) % 10;
    return (steps > 5 ? steps - 10 : steps) * height;
  });
}
