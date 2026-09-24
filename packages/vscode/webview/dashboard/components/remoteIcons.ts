// One icon family for the Remote pane: a 24-unit box, stroke 1.5, round caps,
// currentColor, no fills. Static markup, rendered with {@html} inside an <svg>
// wrapper — the same pattern boardIcons.ts / boardLinkIcons.ts already use, and
// never anything a user, a relay or a phone supplied.
//
// A module rather than an SVG <defs> sprite because a Svelte component tree has
// no single document head to hang a sprite off: each pane leaf would have to
// reach for an id defined by a sibling, and a leaf rendered alone in a test
// would draw nothing at all.

export const REMOTE_ICON_DESKTOP =
  '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>';

export const REMOTE_ICON_RELAY =
  '<rect x="6" y="8" width="12" height="8" rx="2" stroke-dasharray="3 2"/><path d="M2 12h4M18 12h4M20 12l-2-2M20 12l-2 2"/>';

export const REMOTE_ICON_PHONE =
  '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10.5 18.5h3"/>';

export const REMOTE_ICON_SHIELD =
  '<path d="M12 3l7 3v6c0 4.2-3 7.4-7 8.5-4-1.1-7-4.3-7-8.5V6z"/><path d="M9.5 12l1.8 1.8L15 10"/>';

export const REMOTE_ICON_CHECK = '<path d="M4 12.5l5 5L20 6.5"/>';

/** Rename. The one icon the mock does not carry: naming a device is the part
 *  of this pane the mock predates. */
export const REMOTE_ICON_COPY =
  '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>';

export const REMOTE_ICON_PENCIL = '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>';

// The story card's four glyphs, the relay diagram's blind middle box, and the
// hairline link mark beside an off-board destination. Same family, same box.
export const REMOTE_ICON_LOCK = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
export const REMOTE_ICON_KEY = '<circle cx="8.5" cy="15.5" r="3.5"/><path d="M11 13L19.5 4.5M17 7l2 2M15 9l2 2"/>';
export const REMOTE_ICON_HAND = '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 12V4.5a1.5 1.5 0 0 1 3 0V12M14 12V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a5 5 0 0 1-5-5v-2.5a1.5 1.5 0 0 1 3 0"/>';
export const REMOTE_ICON_SERVER = '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>';
export const REMOTE_ICON_LINK = '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>';
