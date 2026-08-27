// The map's COLOUR TABLES for the in-editor screen, MIRRORED from
// src/dashboard/agentManager/mapPalette.ts.
//
// Mirrored rather than imported because tsconfig.webview.json pins rootDir to
// `webview/`, so the webview cannot import a runtime value out of src/ — the same
// reason repoMapPillars.ts beside this file mirrors the five pillars, and it
// carries the same obligation: repoMapPillars.test.ts reads BOTH files of the
// pair and fails if a table drifts.
//
// Its own file rather than more lines in repoMapPillars.ts: that leaf was named
// for the pillars and was at its cap, and a colour table is a different kind of
// thing from a grouping rule.
//
// THESE ARE LITERAL HEXES AND THEY DO NOT FOLLOW THE THEME, deliberately. A box is
// orange because its `kind` is "entrypoint", the way a chart's series has a
// colour; re-tint it per theme and the reader loses the picture's only key. The
// CHROME around the drawing — panels, borders, text — is --og-* tokens as usual.
//
// Only the TABLES are mirrored, never the arithmetic: the host shades a face by
// scaling the hue's channels, and this side gets the same three tones out of CSS
// color-mix(), which is the same operation in sRGB.

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

/** `kind` is a FREE STRING in the schema, so a map may use a word this table has
 *  never heard of. It gets the neutral slate rather than nothing. */
export const KIND_FALLBACK = '#64748b';

export const PILLAR_COLOR: Readonly<Record<number, string>> = {
  1: '#f97316', 2: '#ec4899', 3: '#eab308', 4: '#64748b', 5: '#3b82f6',
};

/** Street tints, one per flow, cycled when a map records more than six. */
export const FLOW_COLOR: readonly string[] = ['#38bdf8', '#f97316', '#22c55e', '#a855f7', '#ec4899', '#eab308'];

export const kindColour = (kind: string): string => KIND_COLOR[kind] ?? KIND_FALLBACK;
export const pillarColour = (n: number): string => PILLAR_COLOR[n] ?? KIND_FALLBACK;
/** Modulo that also handles a negative index, so a bad flow index tints rather
 *  than returning undefined and painting a box `none`. */
export const flowColour = (i: number): string => FLOW_COLOR[((i % FLOW_COLOR.length) + FLOW_COLOR.length) % FLOW_COLOR.length];
