// boardIconsNests.ts — the rail glyphs for the two views t-s9jr6u adds: Nests
// (after Remote) and Settings (at the rail's foot, above Docs).
//
// A fourth icons file on the boardIconsArtifacts.ts ruling: the siblings sit at
// or near their caps. Same contract: inline SVG CHILD markup for a 24x24
// viewBox, stroke=currentColor, static, rendered by the rail via {@html}.

// The nest glyph has ONE source (t-sc093o), shared/nestGlyph.ts: the rail
// draws this string, the chat side draws shared/NestGlyph.svelte over it.
export { NESTS_ICON } from '../../shared/nestGlyph';

// A plain gear: ring, hub and eight teeth. Deliberately NOT the dock's Manager
// cog (the Lucide settings outline), so the two never read as one control.
export const SETTINGS_ICON =
  '<circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="2.4"/>' +
  '<path d="M12 2.5v3.3M12 18.2v3.3M2.5 12h3.3M18.2 12h3.3M5.3 5.3l2.3 2.3M16.4 16.4l2.3 2.3M5.3 18.7l2.3-2.3M16.4 7.6l2.3-2.3"/>';
