// chatDensityClass.ts — t-qn0wj5, proposal 26 (port of Mock-Redesign
// CHANGES.md #39). Pure so it's testable with no render; ChatPane.svelte
// (at its line cap) calls this once and binds the result to a class.
export function chatDensityCompactFromGlobal(win: unknown): boolean {
  return (win as { __ORIGAMI_CHAT_DENSITY_COMPACT__?: boolean } | undefined)?.__ORIGAMI_CHAT_DENSITY_COMPACT__ === true;
}
