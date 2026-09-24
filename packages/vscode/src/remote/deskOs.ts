// The OS family a desk announces in its group hello (t-s9jr6u, Nests L4b).
//
// The Desks card draws one glyph per desk; this is the word it draws from. A
// leaf of its own because groupMembers.ts (the roster) and groupWire.ts (the
// hello) both read it, and neither had room under its cap.

/** The three OS families the Desks card draws a glyph for. '' = not known. */
export type DeskOs = 'windows' | 'macos' | 'linux' | '';

/** `process.platform` to the word a desk announces. */
export function deskOs(platform: string): DeskOs {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : '';
}

/** Off the wire or out of globalState: anything else reads as not known. */
export function readDeskOs(raw: unknown): DeskOs {
  return raw === 'windows' || raw === 'macos' || raw === 'linux' ? raw : '';
}
