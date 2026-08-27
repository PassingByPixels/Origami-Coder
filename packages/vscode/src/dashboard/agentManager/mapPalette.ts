// The map's PALETTE — the colour a component kind is drawn in, the colour a
// pillar district and a flow street are tinted with, and the one-line shade()
// that makes three faces out of one hue.
//
// THIS IS DATA ENCODING, NOT THEME CHROME. A box is orange because its `kind` is
// "entrypoint", the same way a bar chart's series has a colour: change it per
// theme and the reader loses the only key the picture has. So these are literal
// hexes on purpose, in BOTH renderers, and neither one reads --og-* for them.
// (The chrome around the picture — panels, borders, text — does follow the theme
// in the webview, and follows the artifact's own fixed sheet in map.html.)
//
// MIRRORED into webview/dashboard/components/repoMapPillars.ts, because
// tsconfig.webview.json pins rootDir to `webview/` and the webview cannot import
// a runtime value out of src/. That mirror carries the house obligation:
// repoMapPillars.test.ts reads BOTH files and fails if the tables drift.

/** One hue per component kind, carried from the cartographer mockups. */
export const KIND_COLOR: Readonly<Record<string, string>> = {
  entrypoint: '#f97316',
  service: '#22c55e',
  build: '#a855f7',
  renderer: '#ec4899',
  runtime: '#06b6d4',
  validation: '#eab308',
  interface: '#3b82f6',
  external: '#64748b',
};

/** Legend order — grouped by how often a reader looks for them, not alphabetical. */
export const KIND_ORDER: readonly string[] = [
  'entrypoint', 'service', 'renderer', 'validation', 'interface', 'external', 'build', 'runtime',
];

/** `kind` is a FREE STRING in the schema, so a map may legitimately use a word
 *  this table has never heard of. It gets the neutral slate rather than nothing. */
export const KIND_FALLBACK = '#64748b';

export const PILLAR_COLOR: Readonly<Record<number, string>> = {
  1: '#f97316', 2: '#ec4899', 3: '#eab308', 4: '#64748b', 5: '#3b82f6',
};

/** Street tints, one per flow, cycled when a map records more than six. */
export const FLOW_COLOR: readonly string[] = ['#38bdf8', '#f97316', '#22c55e', '#a855f7', '#ec4899', '#eab308'];

export function colourOf(kind: string): string {
  return KIND_COLOR[kind] ?? KIND_FALLBACK;
}

/** Darken (`f` < 1) or lighten (`f` > 1) a #rrggbb toward black or white.
 *
 *  Plain sRGB channel scaling, deliberately: `shade(c, 0.5)` is exactly
 *  `color-mix(in srgb, c 50%, black)`, which is how the in-editor stage gets the
 *  same three tones out of CSS without mirroring this function as well. Only the
 *  TABLES above are mirrored; the arithmetic stays here. */
export function shade(hex: string, f: number): string {
  const ch = (at: number): number => parseInt(hex.slice(at, at + 2), 16);
  const mix = (v: number): number => Math.max(0, Math.min(255, Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1))));
  const hh = (v: number): string => mix(v).toString(16).padStart(2, '0');
  return `#${hh(ch(1))}${hh(ch(3))}${hh(ch(5))}`;
}

/** The kinds a legend should list: the known ones in KIND_ORDER, then anything
 *  else the map actually used, sorted. A cartographer writing `kind: "gate"` must
 *  still get a swatch and a working filter, or the legend quietly lies about how
 *  many components the map has. */
export function kindsIn(kinds: Iterable<string>): string[] {
  const seen = new Set(kinds);
  const known = KIND_ORDER.filter((k) => seen.has(k));
  const extra = [...seen].filter((k) => !KIND_ORDER.includes(k)).sort();
  return [...known, ...extra];
}
