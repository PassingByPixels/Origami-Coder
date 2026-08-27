// chatToolTitle.ts — what the COLLAPSED chat row SAYS, split out of
// chatToolMsg.ts (180/180) when apply_patch's row had to heal mid-flight.
//
// The row is built from the PENDING frame, and apply_patch has no input on that
// frame (the part is created with `input: {}`), so its title is the bare tool
// name and a GPT-family edit read "Edit: apply_patch" for the life of the card —
// the user had to expand the row to learn which file was touched. The engine now
// derives a ONE-LINE title from `patchText` (the single path, or "N files") on
// the running and completed frames, so the row must be allowed to ADOPT it.
//
// Adoption is scoped to apply_patch ON PURPOSE; every other tool keeps the
// existing freeze. A completed frame's title is the TOOL's own result text, and
// only apply_patch's is flattened to one line (acp/tool.ts does that for that
// tool alone). `browser` titles itself "browser open: failed" on a call the
// engine still completes, and `task` retitles to prose — adopting either would
// put a worse header on cards that have read correctly for months.
//
// A webview leaf may not import from src/ (TS6059), and nothing here needs to.

import type { ToolShell } from './chatToolMeta';

/** Tools whose row is a file EDIT, so the label carries the prefix. `edit`'s
 *  title is already the relative path and apply_patch's now is too, so
 *  "Edit: src/foo.ts" reads identically for both; a multi-file patch reads
 *  "Edit: 3 files", the same sentence with a count where the name would be.
 *  Lower-cased before the lookup, mirroring acp/tool.ts's own comparison. */
const EDIT_TOOLS = new Set(['edit', 'apply_patch']);

/** The only tool allowed to REPLACE its label from a later frame. */
const ADOPTING_TOOLS = new Set(['apply_patch']);

function toolKey(toolName: unknown): string {
  return typeof toolName === 'string' ? toolName.toLocaleLowerCase() : '';
}

/** The label a NEW card shows — today's rule, moved here whole. `rawTitle` is
 *  the wire's untyped `title`. */
export function toolCardTitle(toolName: unknown, rawTitle: unknown): string {
  const text = (typeof rawTitle === 'string' && rawTitle ? rawTitle : undefined) ?? '(tool call)';
  return EDIT_TOOLS.has(toolKey(toolName)) ? `Edit: ${text}` : text;
}

/** The label an UPDATE may install, or undefined to KEEP the one already on the
 *  card. Two rules: a shell's `explanation` (behind its display prefix) has
 *  always won, and apply_patch now adopts the engine's derived path/count.
 *
 *  A candidate is refused when it is EMPTY, when it is only the tool's own name
 *  (that is the placeholder the pending row already shows), or when it spans
 *  more than one line. The last guard is not theory: apply_patch's own result
 *  title is the multi-line "Success. Updated the following files:..." summary,
 *  and extension and engine ship on separate release lines — against an engine
 *  that predates the flattening, a header is better left frozen than filled
 *  with a blob or with the one line of it that happened to come first. */
export function updatedToolTitle(
  toolName: unknown,
  rawTitle: unknown,
  shell: ToolShell | undefined,
): string | undefined {
  if (shell?.explanation) return shell.display ? `${shell.display}: ${shell.explanation}` : shell.explanation;
  const key = toolKey(toolName);
  if (!ADOPTING_TOOLS.has(key) || typeof rawTitle !== 'string') return undefined;
  const text = rawTitle.trim();
  if (!text || text === key || /[\r\n]/.test(text)) return undefined;
  return toolCardTitle(key, text);
}
