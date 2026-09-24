// taskStrip.ts — the live todo strip of a passthrough cell, folded from the CLI's own Task tools
// (TaskCreate/TaskUpdate/TaskGet/TaskList), which replaced TodoWrite on current models. The
// TodoWrite path is kept byte-identical for a build that still has the tool.
// A Task tool carries one task at a time, and its real id is not in the call — it comes back in the
// create result's text. So a row opens provisionally on the tool_use, keyed by its tool_call id,
// and binds to the CLI's task id once that result lands; later updates address rows by task id. The
// wire is unchanged: every change posts the whole list as a `todoUpdate`.

import type { TodoRow } from '../acpTodoWrite';
import type { TranslatorState, WebviewPost } from './cellState';

/** One row of the strip as the Task tools describe it. */
export interface TaskRow {
  /** The CLI's own task id, from the create RESULT. `''` until that lands, so a
   *  row addressed before then simply does not match — which is the honest
   *  answer, not a crash. */
  taskId: string;
  /** The tool_use that created it: the only key the row has before it binds. */
  toolCallId: string;
  subject: string;
  status: TodoRow['status'];
}

/** The create result's own wording, and the one field of it we need. */
const CREATED = /Task #(\d+) created/;

/** The strip post: the WHOLE list, every time, in the TodoWrite path's shape.
 *  `activeForm` doubles the subject because the Task tools carry no "-ing" form
 *  of their own, and inventing one would put words in the model's mouth. */
function stripPosts(st: TranslatorState): WebviewPost[] {
  const todos: TodoRow[] = st.tasks.map((t, i) => ({
    id: i, content: t.subject, activeForm: t.subject, status: t.status, depth: 0,
  }));
  return [{ type: 'todoUpdate', sessionId: st.sessionId, source: 'claude-code', todos }];
}

/**
 * A Task tool_use block, folded into the strip. TaskCreate opens a row, TaskUpdate moves one;
 *  TaskGet/TaskList only read and stay silent, so the strip does not flicker on a read.
 */
export function taskUsePosts(
  st: TranslatorState,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): WebviewPost[] {
  if (name === 'TaskCreate') {
    // ALREADY OPEN wins: the CLI can re-send a completed block, and a second
    // row for it would say two tasks where there is one (subagentBeat.openAgent
    // keeps the same rule for the same reason).
    if (st.tasks.some((t) => t.toolCallId === toolCallId)) return [];
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    st.tasks.push({ taskId: '', toolCallId, subject: subject || 'task', status: 'pending' });
    return stripPosts(st);
  }
  if (name !== 'TaskUpdate') return [];
  const taskId = String((input as { taskId?: unknown }).taskId ?? '');
  const row = st.tasks.find((t) => t.taskId === taskId);
  // An id the strip never saw is a NO-OP. The CLI resumes conversations, so an
  // update can address a task created before this binding existed.
  if (!taskId || !row) return [];
  const status = String((input as { status?: unknown }).status ?? '');
  if (status === 'deleted') {
    st.tasks.splice(st.tasks.indexOf(row), 1);
    return stripPosts(st);
  }
  // Only the two the strip renders pass through; anything else CLAMPS to
  // pending rather than dropping the row — acpTodoWrite.ts's own rule, kept
  // here so the two sources of the same strip cannot disagree.
  row.status = status === 'in_progress' || status === 'completed' ? status : 'pending';
  return stripPosts(st);
}

/**
 * A tool result, folded into the strip — for a row still provisional; a bound row is untouched,
 *  since a later tool's failure is not the create's.
 *
 * A successful create binds the CLI's own task id. A failed create removes the row, since the tool
 *  card already shows the failure and a row stuck pending would be a lie.
 */
export function taskResultPosts(st: TranslatorState, toolCallId: string, text: string, isError = false): WebviewPost[] {
  const row = st.tasks.find((t) => t.toolCallId === toolCallId);
  if (!row || row.taskId) return [];
  if (isError) {
    st.tasks.splice(st.tasks.indexOf(row), 1);
    return stripPosts(st);
  }
  const created = CREATED.exec(text);
  if (created) row.taskId = created[1]!;
  return [];
}
