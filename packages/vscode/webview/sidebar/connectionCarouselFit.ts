// CONNECTIONS CAROUSEL — the fit arithmetic and the tile naming.
//
// (Mock-Redesign/CHANGES.md change 4, react-bits Components/Carousel. The
// DEVIATION from the reference is deliberate: a scroll-snap track with arrows,
// not the reference's 3D coverflow. Coverflow suits large slides; these are
// 26px tiles.)
//
// NO CLIPPED TILE is the whole requirement, and it is arithmetic, not CSS.
// Fixed-width tiles leave a sliver of the next one showing at almost every
// sidebar width. So the track is measured and the tile width is SOLVED for:
// take as many ideal-width tiles as fit, then share the track between them
// exactly. The fraction is kept — rounding to whole pixels is what puts the
// end of the scroll half a tile out.
//
// Pure, because jsdom has no layout: these numbers are the only part of the
// carousel that can be proven in a unit test.

export const CONN_GAP = 6;
// 56 -> 40 (owner, 2026-09-21, t-qhzy4k): at 56 only THREE cards reached the
// default ~350px sidebar and the strip read as zoomed in. 40 puts five in the
// same track. The tile HEIGHT went back to the 26px square these cards
// replaced — see ConnectionPill.svelte's `.grid-square.named`.
export const CONN_IDEAL_W = 40;
export const CONN_MIN_W = 32;

export interface ConnFit {
  /** Whole tiles that fit the track — also the page size for an arrow. */
  count: number;
  /** Tile width, fraction kept, such that `count` of them span the track. */
  width: number;
}

export function fitTiles(trackW: number, ideal = CONN_IDEAL_W, gap = CONN_GAP): ConnFit {
  if (!(trackW > 0)) return { count: 1, width: ideal };
  const count = Math.max(1, Math.floor((trackW + gap) / (ideal + gap)));
  const width = Math.max(CONN_MIN_W, (trackW - (count - 1) * gap) / count);
  return { count, width };
}

/**
 * The furthest scroll offset that still rests on a tile start. Fractional tile
 * borders make `scrollWidth` round differently from the arithmetic above, so
 * without this clamp the end of the scroll lands mid-tile and clips one.
 */
export function maxTileStart(scrollWidth: number, clientWidth: number, step: number): number {
  if (!(step > 0)) return 0;
  return Math.max(0, Math.floor(Math.max(0, scrollWidth - clientWidth) / step) * step);
}

/** Where an arrow (`dir` -1/+1) should land from `scrollLeft`. */
export function pageTarget(scrollLeft: number, dir: number, fit: ConnFit, scrollWidth: number, clientWidth: number, gap = CONN_GAP): number {
  const step = fit.width + gap;
  const page = Math.max(1, fit.count) * step;
  return Math.max(0, Math.min(scrollLeft + dir * page, maxTileStart(scrollWidth, clientWidth, step)));
}

/** Where a released drag should settle, so it never rests mid-tile. */
export function settleTarget(scrollLeft: number, fit: ConnFit, scrollWidth: number, clientWidth: number, gap = CONN_GAP): number {
  const step = fit.width + gap;
  if (!(step > 0)) return scrollLeft;
  return Math.min(Math.round(scrollLeft / step) * step, maxTileStart(scrollWidth, clientWidth, step));
}

/**
 * A tile shows the provider NAME on two short centred lines, not initials plus
 * the full name (too wide at 56px). The name is the part before the status
 * clause, minus a trailing version. Split at the first space, else before an
 * inner capital, else leave it whole.
 */
export function nameLines(full: string): string[] {
  const name = full
    .split('—')[0]
    .split(' - ')[0]
    .trim()
    .replace(/\s+v?\d[\w.-]*$/, '')
    .trim();
  if (!name) return [];
  const sp = name.indexOf(' ');
  if (sp > 0) return [name.slice(0, sp), name.slice(sp + 1)];
  // Not in a short name like "xAI": start looking past the third character.
  for (let i = 3; i < name.length - 1; i++) {
    const ch = name.charAt(i);
    if (ch >= 'A' && ch <= 'Z') return [name.slice(0, i), name.slice(i)];
  }
  return [name];
}
