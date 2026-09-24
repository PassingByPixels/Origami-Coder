// The map's palette: kind colours, pillar/flow tints, and the shade() helper. Data encoding,
// not theme chrome — a box's colour is its data key, so these are literal hexes in both
// renderers, never --og-* theme variables. Mirrored into
// webview/dashboard/components/repoMapPillars.ts (the webview can't import a src/ runtime
// value), with a test that fails if the two tables drift.

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

/** Darken/lighten a hex toward black/white by plain sRGB channel scaling — deliberately
 *  identical to `color-mix(in srgb, ...)`, so the in-editor stage gets the same tones from
 *  CSS without mirroring this arithmetic too. */
export function shade(hex: string, f: number): string {
  const ch = (at: number): number => parseInt(hex.slice(at, at + 2), 16);
  const mix = (v: number): number => Math.max(0, Math.min(255, Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1))));
  const hh = (v: number): string => mix(v).toString(16).padStart(2, '0');
  return `#${hh(ch(1))}${hh(ch(3))}${hh(ch(5))}`;
}

/** The kinds a legend should list: the known ones, then anything else the map actually used,
 *  sorted — so a cartographer-invented kind still gets a swatch and a working filter. */
export function kindsIn(kinds: Iterable<string>): string[] {
  const seen = new Set(kinds);
  const known = KIND_ORDER.filter((k) => seen.has(k));
  const extra = [...seen].filter((k) => !KIND_ORDER.includes(k)).sort();
  return [...known, ...extra];
}
