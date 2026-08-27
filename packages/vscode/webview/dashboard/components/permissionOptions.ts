// permissionOptions.ts — the three rules the permission bar reads an option set
// with. Pure and DOM-free, because each of them decides something the user
// cannot undo, and "does this bar know a question from a permission?" has to be
// answerable without rendering anything.
//
// MIRRORED, not imported. The host already owns these rules — isQuestionShaped
// in src/dashboard/agentManager/questionRouting.ts and pickAllowOption in
// src/dashboard/agentManager/permissions.ts — but tsconfig.webview.json pins
// rootDir to `webview/`, so a webview .ts cannot reach into src/ (the
// convention collabPersonaSeed.ts and collabKinds.ts already follow).
// permissionOptions.test.ts reads both host modules and asserts the mirrors
// still agree, so the copies cannot drift apart in silence.

export interface PermOption { optionId: string; name: string; kind: string; }

/**
 * A requestPermission ask is QUESTION-shaped when it offers NO allow_always.
 *
 * The engine builds one PermissionOption per choice for ask_user_question and
 * for plan_exit (acp/question.ts), while a REAL permission ask always carries
 * the fixed allow_once / allow_always / reject_once triple (acp/permission.ts).
 * That absence is the safe discriminator — disjoint in both directions and
 * immune to title/kind ambiguity — and it is what keeps a "yolo" control off a
 * bar that is asking the user a question rather than asking for consent.
 */
export function isQuestionShaped(options: ReadonlyArray<{ kind: string }>): boolean {
  return !options.some((o) => o.kind === 'allow_always');
}

/**
 * The option id to answer an ask with when the USER has said "just do it":
 * allow_once first (least-privilege positive consent — exactly what pressing
 * Approve would have selected), then allow_always, then any option that is not
 * a rejection. `null` when the ask carries no permissive option at all, and the
 * caller must then leave the bar alone rather than invent consent or deny.
 *
 * The preference order is the host's (agentManager/permissions.ts) verbatim: a
 * yolo click that escalated to allow_always where Approve would have picked
 * allow_once would be a wider grant than the button says it makes.
 */
export function pickAllowOption(options: ReadonlyArray<PermOption>): string | null {
  const byKind = (k: string) => options.find((o) => o.kind === k);
  const allow = byKind('allow_once')
    ?? byKind('allow_always')
    ?? options.find((o) => !o.kind.startsWith('reject'));
  return allow ? allow.optionId : null;
}

/** The engine appends this option, LAST, on question-shaped asks (M4.4). */
export const OTHER_OPTION_NAME = 'Other';

/**
 * The "Other" option, if this engine offers one.
 *
 * Matched by NAME because that is what the engine contract specifies, and
 * matched only on a question-shaped ask: "Other" is a free-text answer to a
 * question, and a tool-approval bar that grew an option with that name must not
 * turn into a text box the user can type consent into.
 *
 * `null` on an engine that does not send it — which is the whole defensive
 * point: the bar then draws exactly what it drew before.
 */
export function otherOption(options: ReadonlyArray<PermOption>): PermOption | null {
  if (!isQuestionShaped(options)) return null;
  return options.find((o) => o.name.trim() === OTHER_OPTION_NAME) ?? null;
}
