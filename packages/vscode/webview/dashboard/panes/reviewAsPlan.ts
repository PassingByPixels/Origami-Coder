// reviewAsPlan.ts (t-xsufpe): the "Review as plan" action under a plan-mode
// answer that did not call plan_exit. Owner UAT 0.4.178: a model wrote the plan
// as chat text, so the plan review (approve / revise) never started.
//
// Pure rules only; ReviewAsPlan.svelte renders the button and ChatPane sends
// the prompt through the normal composer send path.

/** The row fields these rules read (a subset of chatMessage.ts `Message`). */
export interface PlanRow {
  kind?: string;
  text?: string;
  toolName?: string;
}

/** Modes where the offer applies. Deep plan delivers a folder, not one file. */
const PLAN_MODE = 'plan';

/**
 * The answer to offer as a plan: the agent text after the last user row, when
 * the chat is in plan mode, idle, and no plan_exit call happened in that turn.
 * Null when there is nothing to offer.
 */
export function planAnswer(rows: readonly PlanRow[], mode: string, inFlight: boolean): string | null {
  if (mode !== PLAN_MODE || inFlight) return null;
  let start = rows.length;
  while (start > 0 && rows[start - 1]?.kind !== 'user') start--;
  if (start === 0) return null;
  const turn = rows.slice(start);
  if (turn.some((row) => row.kind === 'tool' && row.toolName === 'plan_exit')) return null;
  const text = turn
    .filter((row) => row.kind === 'agent' && row.text?.trim())
    .map((row) => row.text!.trim())
    .join('\n\n');
  return text || null;
}

/**
 * The turn the action sends. It carries the answer itself, so the model does
 * not have to recall it, and names the two steps plan mode's review needs.
 */
export function reviewAsPlanPrompt(answer: string): string {
  return (
    'Turn your previous answer into the plan document: write the text below to the plan file, ' +
    'unchanged, then call plan_exit so I can approve or revise it. Do not answer in chat.\n\n' +
    '<plan>\n' + answer + '\n</plan>'
  );
}
