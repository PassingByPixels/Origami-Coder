// tabIcon.ts — chat editor-tab affordances.
// ICON: the crane brand, set ONCE at panel creation and never changed at runtime — every runtime
// icon-swap scheme was tried and falsified (a swap only renders already-fetched files, and nothing
// fetches a new one after creation). Do not re-attempt.
// TITLE: a blue dot prefixes the title while the session has a pending ask (a question or a
// permission approval), stripped when it resolves. Titles repaint reliably; an emoji was tried and
// rejected since it can't be tinted or mirrored.

export interface TabIconTarget {
  iconPath?: unknown;
}

/** The crane pair, set once at creation; a disposed panel's throw on the property set is swallowed.
 */
export function applyTabIcon(panel: TabIconTarget, joinMedia: (filename: string) => unknown): void {
  try {
    panel.iconPath = { light: joinMedia('origami-icon-light.svg'), dark: joinMedia('origami-icon-dark.svg') };
  } catch {
  }
}

export const WAITING_TITLE_PREFIX = '\u{1F535} '; // 🔵

/** Idempotent strip-then-add: safe on every sync and after renames. */
export function waitingTitleFor(currentTitle: string, pendingAskCount: number): string {
  const base = currentTitle.startsWith(WAITING_TITLE_PREFIX)
    ? currentTitle.slice(WAITING_TITLE_PREFIX.length)
    : currentTitle;
  return pendingAskCount > 0 ? WAITING_TITLE_PREFIX + base : base;
}
