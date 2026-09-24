// sessionLogTitle.ts (t-q90p6v) — the two SHAPING rules a logged tool result applies before it is
// merged onto its entry, split out of sessionLog.ts (115/115 when they landed).
//
// Both exist because a card's identity arrives spread across frames: the PENDING frame has the bare
// tool name and a partial input, the RUNNING frame has the real title and the rawInput the shell
// card is drawn from, the COMPLETED frame has the resolved title but no input.

/** A rawInput value big enough to be CONTENT rather than identity — a patchText, an edit's
 *  oldString/newString, a task prompt. The restore reads rawInput for the card's title and shell
 *  fields only (command, explanation, cwd, description, subagent_type); a diff arrives on its own
 *  `diff` field. Keeping the big strings would put whole patches in every archive, and the history
 *  pane reads each archive back whole. */
const RAW_INPUT_VALUE_CAP = 2000;

export function trimRawInput(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > RAW_INPUT_VALUE_CAP) continue;
    out[key] = value;
  }
  return out;
}

/** The title the stored CALL may adopt, or undefined to keep the one it has — a restore builds the
 *  card's label from the call. The live card's own rule (webview/dashboard/panes/chatToolTitle.ts)
 *  refuses a candidate that is empty, that is only the tool's own name (the placeholder the pending
 *  frame already carries) or that spans more than one line — a completed apply_patch title is the
 *  multi-line "Success. Updated..." blob. A webview leaf may not be imported from src/ (TS6059), so
 *  the three guards are restated here; they must stay in step. */
export function betterStoredTitle(call: Record<string, unknown>, rawTitle: unknown): string | undefined {
  if (typeof rawTitle !== 'string') return undefined;
  const text = rawTitle.trim();
  const toolName = typeof call.toolName === 'string' ? call.toolName.toLocaleLowerCase() : '';
  if (!text || text.toLocaleLowerCase() === toolName || /[\r\n]/.test(text)) return undefined;
  return text === call.title ? undefined : text;
}
