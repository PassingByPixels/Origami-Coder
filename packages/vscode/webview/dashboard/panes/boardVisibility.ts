// boardVisibility.ts — WHICH RAIL ROWS EXIST, split from boardViews.ts (at its
// cap) so BoardShell.svelte asks here instead of filtering VIEWS inline.
//
// BOTH ROWS ARE ALWAYS ON THE RAIL, Remote and Flock alike: a row you cannot
// see is a feature nobody turns back on, and each switch now lives ON its own
// row (RemoteStory.svelte, FlockFrontDesk.svelte), not beside a rail button
// that hides itself. Their SETTINGS still gate what costs something (no
// socket, no lease, no pane), never the row. Flock's id is `friends`, not
// `flock` — that word is the FOLDS view's persisted id (boardViews.ts says why).

import { DEFAULT_VIEW, VIEWS, type NavEntry, type ViewId } from './boardViews';

/** The rail rows to draw. Both params stay in the signature so callers that
 *  pass them keep compiling; neither hides a row any more. */
export function visibleViews(_remoteEnabled: boolean, _flockEnabled = false): NavEntry[] {
  return VIEWS;
}

/** A saved or requested view id, resolved against what is visible RIGHT NOW. */
export function resolveView(id: unknown, remoteEnabled: boolean, flockEnabled = false): ViewId {
  const visible = visibleViews(remoteEnabled, flockEnabled);
  return typeof id === 'string' && visible.some((v) => v.id === id) ? (id as ViewId) : DEFAULT_VIEW;
}
