// OPENING A RUN — which directory it belongs to, which message asks the host
// for it, and the trail back out of a click-through.
//
// The first two are one question seen twice. A run in the index carries its own
// `cwd` (`folder` is only the basename); a COLLAB header carries none, because
// its members are the only rows with a directory; and a DELEGATED run is in
// neither, being a sub-agent's own session, so it inherits the directory of
// whatever was open when its chip was clicked. Get it wrong and the engine
// resolves the id against its own process cwd and answers with an empty run —
// which reads on screen as "this delegated run recorded nothing", the worst
// available failure, because it looks like an answer.
//
// The trail is the third: a click-through has to be walkable BACK, and what it
// must remember is exactly what this file already works out. The `cwd` is
// REMEMBERED rather than recomputed, because a nested click-through's parent is
// itself not in the index — recomputing would resolve it to '' and lose the run
// on the way home.
//
// Extracted from LabyrinthPane.svelte at its architecture cap. Pure — no DOM.

import { collabCwd, collabIdOf, type CollabRow } from './labyrinthCollabIndex';

/** One rung of the trail back: the run a click-through left, and the step that
 *  was open in it, so Back restores the view rather than merely the run. */
export interface NavPoint {
  sessionId: string;
  cwd: string;
  /** `null` when nothing was selected — restoring a step that was never open
   *  would be a different view from the one the reader left. */
  ordinal: number | null;
}

/** The directory a listed run belongs to; '' when the index does not have it. */
export function runCwd(runs: readonly CollabRow[], id: string): string {
  const collabId = collabIdOf(id);
  if (collabId) return collabCwd(runs, collabId);
  return runs.find((r) => r.sessionId === id)?.cwd ?? '';
}

/**
 * Does this key press mean "back one rung"?
 *
 * Escape, but NEVER while a field holds the key: Escape in the price panel's
 * input is "leave this input alone", and answering it by changing which run is
 * open moves the reader somewhere they did not ask to go. Nor at depth 0, where
 * there is no rung to walk — a shortcut that jumps to a run never visited is
 * worse than no shortcut.
 */
export function wantsBack(target: EventTarget | null, key: string, depth: number): boolean {
  if (key !== 'Escape' || depth <= 0) return false;
  const el = target as Element | null;
  return !(el && typeof el.closest === 'function'
    && el.closest('input, textarea, select, [contenteditable="true"]'));
}

/** The host request for one run's steps. A collab header maps its members
 *  MERGED, and the reply echoes `collab:<id>` rather than a session id. */
export function stepsRequest(id: string, cwd: string): Record<string, unknown> {
  const collabId = collabIdOf(id);
  return collabId
    ? { type: 'requestCollabSteps', collabId, cwd }
    : { type: 'requestRunSteps', sessionId: id, cwd };
}
