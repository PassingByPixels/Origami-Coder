// boardIcons.ts — the board rail's glyphs, extracted from BoardShell.svelte
// when the Crons view was added and the shell was one line under its
// architecture cap. Per the ratchet, the module comes out rather than the
// number going up.
//
// Each value is inline SVG CHILD markup for a 24x24 viewBox, stroke=currentColor
// — static, never user-derived. BoardShell renders them via {@html} inside its
// own <svg> wrapper, the same pattern MessageRow.svelte / ReadFileCard.svelte use.

export const FLOCK_ICON =
  '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="10" rx="1"/><rect x="16" y="4" width="5" height="13" rx="1"/>';

export const SKILLS_ICON =
  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>';

// A repeat glyph — chasing arrows, for a prompt re-run on an interval.
export const LOOPS_ICON =
  '<polyline points="17 2 21 6 17 10"/><path d="M3 12v-2a4 4 0 0 1 4-4h14"/><polyline points="7 22 3 18 7 14"/><path d="M21 12v2a4 4 0 0 1-4 4H3"/>';

// A clock — a cron fires at a WALL-CLOCK time, with the editor shut. Deliberately
// distinct from the Loops repeat-arrows, because the two are easy to confuse and
// only one of them survives closing VS Code.
export const CRONS_ICON =
  '<circle cx="12" cy="12" r="9"/><polyline points="12 6.5 12 12 15.5 14"/>';

// A walked path: a spine with markers on it, in the map's own idiom.
export const LABYRINTH_ICON =
  '<polyline points="5 3 5 9 19 9 19 15 5 15 5 21"/><circle cx="5" cy="3" r="1.7"/><circle cx="19" cy="9" r="1.7"/><circle cx="5" cy="15" r="1.7"/><circle cx="5" cy="21" r="1.7"/>';

// Two overlapping speech bubbles — a shared room, not a single thread.
// Deliberately not another bird: the rail says WHAT the view is, and the birds
// are the agents' own identities inside it.
export const COLLAB_AGENTS_ICON =
  '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h7A2.5 2.5 0 0 1 15 6.5v3A2.5 2.5 0 0 1 12.5 12H7l-4 3z"/><path d="M9 15.5h5.5l4 3v-3A2.5 2.5 0 0 0 21 13v-2.5A2.5 2.5 0 0 0 18.5 8H18"/>';

// A stacked document set — the files prepended to every prompt.
export const INSTRUCTIONS_ICON =
  '<rect x="7" y="3" width="13" height="15" rx="1.5"/><path d="M4 6.5v12A2.5 2.5 0 0 0 6.5 21H16"/><line x1="10" y1="7.5" x2="17" y2="7.5"/><line x1="10" y1="11" x2="17" y2="11"/><line x1="10" y1="14.5" x2="14" y2="14.5"/>';

// A spanner over a magnifier — a tool, and the search that finds one. The
// magnifier is the point of the view: most tools here are behind the catalog.
export const TOOLS_ICON =
  '<circle cx="10" cy="10" r="6"/><line x1="14.5" y1="14.5" x2="20.5" y2="20.5"/><path d="M12.4 7.6a2.6 2.6 0 0 1-3.4 3.4l-2 2a1.2 1.2 0 0 1-1.7-1.7l2-2a2.6 2.6 0 0 1 3.4-3.4L9.2 7.4l1.4 1.4z"/>';

// A power plug — an agent-plugins.org package, socketed in.
export const PLUGINS_ICON =
  '<path d="M9 2v4"/><path d="M15 2v4"/><path d="M6 9h12v3a6 6 0 0 1-12 0V9z"/><path d="M12 18v4"/>';
export const MCP_ICON = '<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="4" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 6v3.4M10.7 14.2 6.3 17.3M13.3 14.2l4.4 3.1"/>'; // three nodes on one hub, not another socket: MCP servers are dialled OUT to, a plugin is loaded IN
