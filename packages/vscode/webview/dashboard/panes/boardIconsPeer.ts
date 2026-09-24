// boardIconsPeer.ts — the rail glyphs for the two views that reach OFF this
// machine: Remote (a paired phone) and Flock (a friend's Origami).
//
// A second icons file, not two more lines in boardIcons.ts, for the reason that
// file's own header states: it was at its architecture cap, and per the ratchet
// the module comes out rather than the number going up. The split is by SUBJECT
// and not by arrival date — every glyph next door names something inside this
// editor, and these two name something outside it.
//
// Same contract as boardIcons.ts: inline SVG CHILD markup for a 24x24 viewBox,
// stroke=currentColor, static and never user-derived, rendered by BoardShell
// via {@html} inside its own <svg> wrapper.

// A phone with a signal arc. Deliberately NOT a QR square: the QR is one screen
// inside the pane, and naming the rail entry after its first step would read
// wrongly the moment a phone is already paired.
export const REMOTE_ICON =
  '<rect x="7" y="2.5" width="10" height="19" rx="2"/><line x1="10.5" y1="18.5" x2="13.5" y2="18.5"/><path d="M19.5 6.5a5 5 0 0 1 0 5.4"/><path d="M22 4.5a8.5 8.5 0 0 1 0 9.4"/>';

// Two birds in flight. Distinct from boardIcons.ts's FLOCK_ICON, which is the
// historical id of the FOLDS view and draws worktree columns — the two share a
// word and nothing else. The birds belong here because this is the only view
// that is about other people.
export const FLOCK_FRIENDS_ICON =
  '<path d="M2.5 9c1.7 0 2.5-2.2 4.2-2.2S9.2 9 10.9 9"/><path d="M6.7 6.8v4.4"/><path d="M13.1 15.6c1.7 0 2.5-2.2 4.2-2.2s2.5 2.2 4.2 2.2"/><path d="M17.3 13.4v4.4"/>';
