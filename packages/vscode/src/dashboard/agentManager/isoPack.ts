// Shelf packing for the isometric floor plan: how a bag of square footprints packs into the
// tightest rectangle. Pure numbers in, numbers out. W+D is the score because an iso
// rectangle of W x D cells projects to a screen box of exactly (W+D)*HX by (W+D)*HY —
// minimising W+D IS minimising the drawing's size; `ratio` biases the cell rectangle's shape
// (>1 = wide slab for pillar districts, =1 = square).

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

/** Lay items left to right, wrapping when the next one would pass `targetW`. The first item
 *  on a shelf is always placed even if wider than the target, so one very wide section never
 *  loops forever or gets dropped. */
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

/** Shelf packing is order-sensitive, so the order is searched too: exhaustively up to 6
 *  items, by size heuristics beyond that. Deterministic — same map always yields the same
 *  candidate list. */
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

/** The tightest packing found: sweep the wrap width from one-item-per-shelf to
 *  everything-on-one-shelf, over every candidate ordering, keeping the smallest W+D. An empty
 *  bag returns a zero-extent packing — a pillar every flow already covers has nothing left to
 *  dock, which is ordinary, not an error. */
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
