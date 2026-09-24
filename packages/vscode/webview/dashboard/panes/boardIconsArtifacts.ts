// boardIconsArtifacts.ts — the rail glyph for the Artifacts view.
//
// A third icons file, not a line in boardIcons.ts: that file sits at its
// architecture cap (50 lines) and the ratchet says the module comes out rather
// than the number going up — the same ruling boardIconsPeer.ts records.
//
// Same contract as its two siblings: inline SVG CHILD markup for a 24x24
// viewBox, stroke=currentColor, static and never user-derived, rendered by
// BoardShell via {@html} inside its own <svg> wrapper.

// The stacked layers the sidebar dock's Artifacts pill already draws
// (sidebarDockItems.ts). ONE artifact is a bundle of files with a version on
// top of a version, and the two surfaces that open it must not carry two
// different pictures of it.
export const ARTIFACTS_ICON =
  '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>';
