// acpTaskTokens.ts — the SUB-AGENT token rider, `_meta.origami_task_tokens`.
//
// Its own file, not four more lines of acpTaskMeta.ts: that file was at 68/80
// when this landed, and a rider with its OWN SHAPE (six named counters, each
// optional, each independently junk-checked) is a different kind of thing from
// the flat string/boolean/stamp riders beside it.
//
// FAIL-OPEN IS THE WHOLE POINT. The engine lane that writes this key
// (t-dcl8fe) ships separately from this UI, and the installed engine is
// routinely older than the extension. A missing key, a key of the wrong type
// and a key holding junk all decode to `undefined`, which the drawer draws as
// nothing at all — never as `0 / 0`, which would read as "this agent spent
// nothing" rather than "nobody told us".

/** The child's spend so far. Every field is optional on the wire AND here:
 *  a provider that reports no reasoning split must not blank the two counts
 *  that matter. `cost` is the provider's own figure in USD, never derived
 *  here — this side has no price table and must not invent one. */
export interface TaskTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** USD, as the engine reported it. */
  cost?: number;
  /** t-ru1i84. USD DERIVED on this side, from the engine's own provider catalogue
   *  (dashboard/subagentCost.ts) — a separate field from `cost` above precisely so a
   *  computed figure can never be mistaken for a provider's measured one. Absent when
   *  the child's model is unknown or carries no price. */
  costUsd?: number;
  /** t-ffziaz. Model calls behind the sums above — a 38k spend over 2 steps was
   *  read as a 38k context, and this is what tells the two apart. */
  steps?: number;
  /** t-ffziaz. The LAST step's context, cached prefix included: the only
   *  non-additive number here, and the one the chat's pill also shows. */
  context?: number;
}

/** The field names, in the order a breakdown prints them. Exported because the
 *  mirror in the webview (panes/subagentTokens.ts) declares the same ones and a
 *  drift guard reads both files. */
export const TASK_TOKEN_FIELDS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cost', 'costUsd', 'steps', 'context'] as const;

/** A finite, non-negative number, or undefined. Unlike a STAMP (acpTaskMeta.ts)
 *  `0` is kept: a child that has emitted nothing yet really has 0 output, and
 *  printing that is honest. Negatives are junk, not a direction. */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** The token rider on a task update, or undefined when it carried none worth
 *  printing. An object whose every field is junk decodes to undefined rather
 *  than `{}`, so the row prints nothing instead of an empty breakdown. */
export function taskTokensOf(value: unknown): TaskTokens | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: TaskTokens = {};
  for (const key of TASK_TOKEN_FIELDS) {
    const n = count(raw[key]);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
