// boardLinkIcons.ts — the rail's NON-VIEW glyphs, extracted from boardIcons.ts
// when the MCP view was added and that file sat exactly on its 50-line cap.
// Per the ratchet, the module comes out rather than the number going up.
//
// The split is the one the board already asserts in two places (boardViews.ts's
// own comment, and boardShell.test.ts's "Docs is a LINK, not a view"): every
// glyph in boardIcons.ts belongs to a row of the VIEWS table, and Docs belongs
// to none — it sits after the flex spacer and opens the Origami website.
// BoardShell imports it directly, which it already did.

export const DOCS_ICON = // a globe - Docs opens the Origami WEBSITE (Skills already wears the book)
  '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z"/>';
