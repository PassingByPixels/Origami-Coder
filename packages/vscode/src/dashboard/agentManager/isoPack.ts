// SHELF PACKING for the isometric floor plan — how a bag of square footprints is
// arranged into the tightest rectangle, and nothing else. Pure numbers in, pure
// numbers out; it never sees a node, a colour or a pillar.
//
// Split out of isoLayout.ts on arrival rather than grown inside it: the packer is
// a search (it tries many orderings and many wrap widths and keeps the best), and
// a search wants its own tests — "does it actually find a smaller box than the
// naive order" is a question about THIS module, not about where flows go.
//
// WHY W+D IS THE SCORE, and not area or aspect. An iso rectangle of W x D cells
// projects to a screen box of exactly (W + D) * HX wide by (W + D) * HY tall —
// the diamond's two half-diagonals both run on the sum. So W + D IS the picture's
// size in pixels, and minimising it is literally minimising the drawing. `ratio`
// then biases the SHAPE of the cell rectangle: ratio > 1 prefers a wide slab
// (what the pillar districts want, so they sit under the streets), ratio = 1 a
// square one.

/** One item to place: a `w` x `d` cell rectangle carrying whatever the caller
 *  needs back out of `placed`. */
export interface PackItem {
  w: number;
  d: number;
}

export interface Placed<T> {
  it: T;
  x: number;
  y: number;
}

export interface PackResult<T> {
  placed: Placed<T>[];
  /** Extent of the packing in cells — the two numbers the score is built from. */
  w: number;
  d: number;
}

/**
 * Lay items left to right, wrapping to a new shelf when the next one would pass
 * `targetW`. The FIRST item on a shelf is always placed, even when it is wider
 * than the target — otherwise an item wider than the wrap width would loop
 * forever or be dropped, and one very wide section is a completely ordinary map.
 */
export function shelfPack<T extends PackItem>(items: readonly T[], targetW: number, gap: number): PackResult<T> {
  const placed: Placed<T>[] = [];
  let x = 0;
  let shelfTop = 0;
  let shelfD = 0;
  let width = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > targetW) {
      shelfTop += shelfD + gap;
      x = 0;
      shelfD = 0;
    }
    placed.push({ it, x, y: shelfTop });
    x += it.w + gap;
    width = Math.max(width, x - gap);
    shelfD = Math.max(shelfD, it.d);
  }
  return { placed, w: width, d: shelfTop + shelfD };
}

/** Every permutation of a list, in a fixed order — the exhaustive branch of the
 *  ordering search. Only ever called on <= 6 items (720 orders). */
function permutations<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [list.slice()];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const sub of permutations(rest)) out.push([list[i], ...sub]);
  }
  return out;
}

/** Shelf packing is order-sensitive, so the ORDER is searched too: exhaustively
 *  while that is cheap, and by a spread of size heuristics beyond it. Sorting is
 *  stable and every comparator is total on the keys it reads, so the candidate
 *  list is the same on every run — which is what keeps the whole layout a pure
 *  function of the map. */
export function orderings<T extends PackItem>(items: readonly T[]): T[][] {
  if (items.length <= 6) return permutations(items);
  const by = (cmp: (a: T, b: T) => number): T[] => [...items].sort(cmp);
  return [
    by((a, b) => b.d - a.d),
    by((a, b) => b.w - a.w),
    by((a, b) => b.w * b.d - a.w * a.d),
    by((a, b) => a.d - b.d),
    by((a, b) => b.w + b.d - (a.w + a.d)),
    [...items],
  ];
}

/**
 * The tightest packing this search can find: sweep the wrap width from "one item
 * per shelf" up to "everything on one shelf", over every candidate ordering, and
 * keep the smallest W + D (nudged toward `ratio` by a light shape term).
 *
 * An EMPTY bag returns an empty packing of zero extent rather than a degenerate
 * one — a pillar every flow already covers has nothing left to dock, and that is
 * an ordinary map, not an error.
 */
export function bestPack<T extends PackItem>(items: readonly T[], gap: number, ratio = 1): PackResult<T> {
  if (items.length === 0) return { placed: [], w: 0, d: 0 };
  let best: PackResult<T> | null = null;
  let bestScore = Infinity;
  for (const order of orderings(items)) {
    let maxW = 0;
    let totalW = 0;
    for (const it of order) {
      maxW = Math.max(maxW, it.w);
      totalW += it.w + gap;
    }
    for (let t = maxW; t <= Math.max(maxW, totalW); t += 0.5) {
      const r = shelfPack(order, t, gap);
      const score = r.w + r.d + Math.abs(r.w - r.d * ratio) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
  }
  return best ?? { placed: [], w: 0, d: 0 };
}
