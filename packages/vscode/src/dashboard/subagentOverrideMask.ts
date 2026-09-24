// The tools pane's session-length MASK of sub-agent cells: what the ledger has
// written that the running engine has not read yet. Split out of
// subagentPendingOverrides.ts (at 80/85 when the reset gained a memory), which
// keeps the PROJECTION onto a catalog payload; this keeps the store.
//
// Module state by design, like claudeCode/planUsage.ts's cache: it lives exactly
// as long as the extension host does, which is exactly how long the mask needs
// to hold — a window reload restarts this module along with the engine that
// finally catches up.

import type { ToolState } from './toolDeferConfig';

/** One masked cell. `before` is the state the ENGINE reported before the ledger
 *  first wrote this cell THIS session, kept so "Reset to defaults" has somewhere
 *  to put the cell back to (t-fiszlv R13). Absent when nobody recorded one. */
export interface MaskedCell {
  state: ToolState;
  before?: ToolState;
}

const mask = new Map<string, MaskedCell>();
// A NUL-code separator built at runtime, never typed as an escape in this source file: an agent
// name can contain a hyphen or underscore but never a control character, so this can never collide
// with either half of the key. A literal escape here once put a raw NUL byte in the file itself,
// which made git treat the whole thing as a binary file.
const SEP = String.fromCharCode(0);
const maskKey = (agent: string, id: string) => `${agent}${SEP}${id}`;

/** Called by writeSubagentToolState (subagentToolConfig.ts) once its write is confirmed on disk —
 *  never before, so a throw (a bad agent name) cannot mask a cell that was never actually written.
 *  `before` is the engine's own reading of the cell at that moment; the FIRST one recorded wins, so
 *  a cell cycled twice still remembers where the ledger found it rather than its own last step. */
export function recordSubagentOverride(agent: string, id: string, state: ToolState, before?: ToolState): void {
  const key = maskKey(agent, id);
  const held = mask.get(key)?.before ?? before;
  mask.set(key, { state, ...(held ? { before: held } : {}) });
}

/** Every masked cell, as `[agent, id, state]`. */
export function maskedCells(): Array<[string, string, ToolState]> {
  return [...mask].map(([k, cell]) => [k.slice(0, k.indexOf(SEP)), k.slice(k.indexOf(SEP) + 1), cell.state]);
}

/**
 * "Reset to defaults" for ONE agent (t-fiszlv R13): hold every reset cell at its
 * new value rather than dropping the mask.
 *
 * Dropping it was the bug. The engine only re-reads an agent's permission rules
 * when its registry is rebuilt, so an override the reset removed from the file
 * is still in the verdict it answers with — an unmasked post redrew, as the
 * engine's own truth, the very overrides the click had just deleted. The mask
 * now holds the reset value until the window reload takes this module and that
 * engine together.
 *
 * Two sources, in this order. A cell this session wrote goes back to where the
 * ledger FOUND it, which is exact. Everything else takes `reverted`
 * (subagentResetStates.ts), which answers for the overrides that were already
 * live when the engine started — the class no mask could have covered, and the
 * one the finding was filed for. A cell with neither is dropped: the engine's
 * verdict is at least its own.
 */
export function resetSubagentOverrides(agent: string, reverted: Record<string, ToolState> = {}): void {
  const prefix = `${agent}${SEP}`;
  for (const [key, cell] of [...mask]) {
    if (!key.startsWith(prefix)) continue;
    const back = cell.before ?? reverted[key.slice(prefix.length)];
    if (back) mask.set(key, { state: back });
    else mask.delete(key);
  }
  for (const [id, state] of Object.entries(reverted)) {
    if (!mask.has(maskKey(agent, id))) mask.set(maskKey(agent, id), { state });
  }
}

/** Test seam — the mask is module state by design (see the header comment). */
export function __resetPendingSubagentOverridesForTests(): void {
  mask.clear();
}
