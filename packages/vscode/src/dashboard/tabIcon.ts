// tabIcon.ts (t-q6jxrs) — the chat editor-tab affordances that SURVIVED the
// waiting-signal saga (0.3.69–0.3.74):
//
//   ICON — the crane brand, assigned ONCE at panel creation, never changed.
//   Every runtime iconPath swap scheme was falsified live on this workbench:
//   a swap renders only files already fetched, and nothing fetches a new
//   file after creation (plain swap 0.3.69, re-apply nudge 0.3.70,
//   cache-busted URIs 0.3.71, creation-prime warming 0.3.72 — all blanked
//   the icon). Do not re-attempt; the evidence trail lives on t-q6jxrs.
//
//   TITLE — the waiting signal. A blue dot prefixes the title while the
//   session has a pending ask (a question batch or a permission approval —
//   one plumbing, see onPermissionRequest), stripped when the last ask
//   resolves. Titles repaint reliably and emoji render in colour. A crane
//   emoji was tried (0.3.73) and the owner settled on the dot — emoji can
//   be neither tinted nor mirrored, so no brand-coloured crane exists as
//   text.
//
// vscode-free by design (a joinMedia thunk instead of vscode.Uri) so the
// rules are executable unit tests, same as agentManager/attention.ts.

export interface TabIconTarget {
  iconPath?: unknown;
}

/** The crane pair, set once at creation. A disposed panel throws on the
 *  property set; there is nothing left to paint, so it is swallowed. */
export function applyTabIcon(panel: TabIconTarget, joinMedia: (filename: string) => unknown): void {
  try {
    panel.iconPath = { light: joinMedia('origami-icon-light.svg'), dark: joinMedia('origami-icon-dark.svg') };
  } catch {
    // disposed panel — nothing left to paint.
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
