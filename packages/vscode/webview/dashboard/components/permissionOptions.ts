// permissionOptions.ts — the three rules the permission bar reads an
// option set with. Pure and DOM-free, since each decides something the
// user cannot undo.
//
// Mirrored, not imported: the host owns these rules (questionRouting.ts,
// permissions.ts) but tsconfig.webview.json pins rootDir to `webview/`, so
// a webview .ts cannot reach into src/. permissionOptions.test.ts reads
// both host modules and asserts the mirrors still agree.

export interface PermOption { optionId: string; name: string; kind: string; }

/**
 * A requestPermission ask is question-shaped when it offers no
 * allow_always. The engine gives ask_user_question and plan_exit one
 * option per choice, while a real permission ask always carries the fixed
 * allow_once/allow_always/reject_once triple — a safe discriminator that
 * keeps a "yolo" control off a bar that is asking a question, not consent.
 */
export function isQuestionShaped(options: ReadonlyArray<{ kind: string }>): boolean {
  return !options.some((o) => o.kind === 'allow_always');
}

/**
 * The option id for "just do it": allow_once first (least-privilege,
 * exactly what Approve would pick), then allow_always, then any
 * non-rejection option. `null` when nothing permissive exists, so the
 * caller leaves the bar alone rather than inventing consent. The order is
 * the host's verbatim, so a yolo click never grants wider than Approve would.
 */
export function pickAllowOption(options: ReadonlyArray<PermOption>): string | null {
  const byKind = (k: string) => options.find((o) => o.kind === k);
  const allow = byKind('allow_once')
    ?? byKind('allow_always')
    ?? options.find((o) => !o.kind.startsWith('reject'));
  return allow ? allow.optionId : null;
}

/** The engine appends this option, last, on question-shaped asks. */
export const OTHER_OPTION_NAME = 'Other';

/**
 * The "Other" option, if this engine offers one. Matched by name, per the
 * engine contract, and only on a question-shaped ask — "Other" is a
 * free-text answer to a question, not something a tool-approval bar should
 * let become a text box for typing consent. `null` when the engine does not
 * send it, so the bar draws exactly what it drew before.
 */
export function otherOption(options: ReadonlyArray<PermOption>): PermOption | null {
  if (!isQuestionShaped(options)) return null;
  return options.find((o) => o.name.trim() === OTHER_OPTION_NAME) ?? null;
}
