// claudeCodeTaskStrip.test.ts — the live todo strip of a passthrough cell, fed
// by the CLI's OWN Task tools instead of TodoWrite.
//
// WHY THIS EXISTS. Claude Code 2.1.198 does not ship TodoWrite. The strip was
// mapped to that tool alone, so a live session's todos never reached it — the
// defect two haiku UAT runs showed, and the reason every fixture below is real.
//
// FIXTURES ARE DERIVED, and say where from. The tool ids, subjects, statuses and
// result WORDING are quoted verbatim out of the captured session
// `898d9e7c-b1cf-41f4-94cf-39c0796ec2b6` (CLI 2.1.198, this machine). They are
// carried here as literals — the test never reads that file, or any other path
// outside the repo, at run time. The FRAME around them is a captured wire line
// with its content block substituted, which is the technique
// claudeCodeSubagentBeat.test.ts and claudeCodeAdversarial.test.ts already use:
// the CLI's persistence log is not the stream-json wire, so only the parts that
// ARE the same on both (the blocks) are taken from it.
//
// Everything is driven through `translate` — the dispatch, never an inner
// helper — because the bug was that the dispatch never called the strip at all.

import { describe, expect, it } from 'vitest';
import { newTranslatorState, translate, type TranslatorState, type WebviewPost } from '../../../src/claudeCode/translator';
import { RUN2_ASSISTANT_TOOL_USE, RUN2_USER_TOOL_RESULT } from './claudeCodeFixtures';

const SID = 'claude-cell-1';
const ev = (line: string) => JSON.parse(line) as Record<string, unknown> & { type: string };

/** The captured `assistant` frame with its ONE block replaced. Model, usage and
 *  the null parent stay exactly as the CLI sent them. */
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  const frame = ev(RUN2_ASSISTANT_TOOL_USE);
  (frame.message as Record<string, unknown>).content = [
    { type: 'tool_use', id, name, input, caller: { type: 'direct' } },
  ];
  return frame;
}

/** The captured tool_result frame, re-addressed and re-texted. `is_error` is the
 *  CLI's own field on that block — the same one the card reads to draw red. */
function toolResult(id: string, content: string, isError = false) {
  const frame = ev(RUN2_USER_TOOL_RESULT);
  (frame.message as Record<string, unknown>).content = [
    { tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) },
  ];
  return frame;
}

/** The three TaskCreate calls of the captured run, and what each result said. */
const CREATED = [
  ['toolu_01CXcydvVF2cg2yyeYowcVko', 'Test task 1 - cycle 1', 'This is the first task for the agent to complete in cycle 1'],
  ['toolu_01WKKFscApawBgdGf3ADvVSM', 'Test task 2 - cycle 2', 'This is the second task for the agent to complete in cycle 2'],
  ['toolu_013Mq89raeoiccbb8ZUJcHCt', 'Test task 3 - cycle 3', 'This is the third task for the agent to complete in cycle 3'],
] as const;
const CREATE_RESULT = (n: number) => `Task #${n} created successfully: ${CREATED[n - 1]![1]}`;

/** The three TaskUpdate calls, in the captured order. */
const UPDATED = ['toolu_01Awyo7YpwKsV7eVgP3nHf2U', 'toolu_01SPZtbn3oZrbEUd4ikcWGCW', 'toolu_01P2yKtQbUpNqQummsTk8fWx'] as const;

const strips = (posts: WebviewPost[]) => posts.filter((p) => p.type === 'todoUpdate');
const rows = (post: WebviewPost) => post.todos as Array<{ content: string; status: string; activeForm: string; depth: number }>;

/** One TaskCreate, whole: the call and the result that names its task id. */
function create(st: TranslatorState, n: number, now = 1_000): WebviewPost[] {
  const [id, subject, description] = CREATED[n - 1]!;
  return [
    ...translate(toolUse(id, 'TaskCreate', { subject, description }), st, now),
    ...translate(toolResult(id, CREATE_RESULT(n)), st, now),
  ];
}

/** One TaskUpdate, whole. The strip moves on the CALL — the result ("Updated
 *  task #1 status") carries no status of its own to move it with. */
function update(st: TranslatorState, n: number, status = 'completed', now = 2_000): WebviewPost[] {
  return [
    ...translate(toolUse(UPDATED[n - 1]!, 'TaskUpdate', { taskId: String(n), status }), st, now),
    ...translate(toolResult(UPDATED[n - 1]!, `Updated task #${n} status`), st, now),
  ];
}

describe('the Task tools ARE the todo strip on CLI 2.1.198', () => {
  it('folds the captured TaskCreate x3 / TaskUpdate x3 run into one completed list', () => {
    const st = newTranslatorState(SID);
    const snapshots: WebviewPost[] = [];
    for (const n of [1, 2, 3]) snapshots.push(...strips(create(st, n)));
    for (const n of [1, 2, 3]) snapshots.push(...strips(update(st, n)));

    // SIX changes, six snapshots: three rows appearing, then three completing.
    expect(snapshots).toHaveLength(6);
    expect(snapshots.map((s) => rows(s).length)).toEqual([1, 2, 3, 3, 3, 3]);
    expect(snapshots.map((s) => rows(s).map((r) => r.status).join(','))).toEqual([
      'pending',
      'pending,pending',
      'pending,pending,pending',
      'completed,pending,pending',
      'completed,completed,pending',
      'completed,completed,completed',
    ]);

    const last = snapshots[5]!;
    expect(last).toMatchObject({ type: 'todoUpdate', sessionId: SID, source: 'claude-code' });
    expect(rows(last)).toEqual([
      { id: 0, content: 'Test task 1 - cycle 1', activeForm: 'Test task 1 - cycle 1', status: 'completed', depth: 0 },
      { id: 1, content: 'Test task 2 - cycle 2', activeForm: 'Test task 2 - cycle 2', status: 'completed', depth: 0 },
      { id: 2, content: 'Test task 3 - cycle 3', activeForm: 'Test task 3 - cycle 3', status: 'completed', depth: 0 },
    ]);
  });

  it('carries in_progress through, and clamps a status the strip cannot draw', () => {
    const st = newTranslatorState(SID);
    create(st, 1);
    expect(rows(strips(update(st, 1, 'in_progress'))[0]!)[0]!.status).toBe('in_progress');
    // Not a strip status. The row must LOSE its state, never itself — the same
    // rule acpTodoWrite.todosFromUpdate keeps for the TodoWrite path.
    expect(rows(strips(update(st, 1, 'blocked'))[0]!)[0]!.status).toBe('pending');
  });

  it('removes a deleted task instead of drawing it forever', () => {
    const st = newTranslatorState(SID);
    create(st, 1);
    create(st, 2);
    const after = strips(update(st, 1, 'deleted'))[0]!;
    expect(rows(after).map((r) => r.content)).toEqual(['Test task 2 - cycle 2']);
  });

  it('ignores a task id it never saw, rather than crashing or inventing a row', () => {
    const st = newTranslatorState(SID);
    create(st, 1);
    // A resumed conversation can update a task created before this binding.
    expect(strips(update(st, 9))).toEqual([]);
    expect(st.tasks).toHaveLength(1);
    expect(st.tasks[0]!.status).toBe('pending');
  });

  it('does not move a row until its create result has bound the task id', () => {
    const st = newTranslatorState(SID);
    const [id, subject] = CREATED[0]!;
    // The call only — the CLI has not answered with "Task #1 created" yet.
    translate(toolUse(id, 'TaskCreate', { subject }), st, 1_000);
    expect(strips(translate(toolUse(UPDATED[0]!, 'TaskUpdate', { taskId: '1', status: 'completed' }), st, 1_100))).toEqual([]);
    expect(st.tasks[0]!.status).toBe('pending');
    // ...and once it binds, the very same update lands.
    translate(toolResult(id, CREATE_RESULT(1)), st, 1_200);
    expect(rows(strips(update(st, 1))[0]!)[0]!.status).toBe('completed');
  });

  it('drops a provisional row when its own TaskCreate FAILED, keeping the rest', () => {
    const st = newTranslatorState(SID);
    create(st, 1); // one that really was created…
    const [id, subject] = CREATED[1]!; // …and one the CLI refuses
    translate(toolUse(id, 'TaskCreate', { subject }), st, 2_000);
    expect(st.tasks).toHaveLength(2);

    const dropped = strips(translate(toolResult(id, 'Error: task store unavailable', true), st, 2_100));
    // The strip REDRAWS without it. A row that stays pending for the rest of
    // the session is a lie; the failure is on the tool card, in the CLI's words.
    expect(dropped).toHaveLength(1);
    expect(rows(dropped[0]!).map((r) => r.content)).toEqual(['Test task 1 - cycle 1']);
    expect(st.tasks).toHaveLength(1);
    // The survivor still answers to its own task id, unshifted by the removal.
    expect(rows(strips(update(st, 1))[0]!)[0]!.status).toBe('completed');
  });

  it('leaves a BOUND row alone when a later result on its card errors', () => {
    const st = newTranslatorState(SID);
    create(st, 1);
    // Not a create failure — the task exists; this is some other tool's error.
    expect(strips(translate(toolResult(CREATED[0]![0], 'Error: something else', true), st, 3_000))).toEqual([]);
    expect(st.tasks).toHaveLength(1);
    expect(st.tasks[0]!.taskId).toBe('1');
  });

  it('adds no second row when the CLI re-sends a completed TaskCreate block', () => {
    const st = newTranslatorState(SID);
    create(st, 1);
    const [id, subject] = CREATED[0]!;
    expect(strips(translate(toolUse(id, 'TaskCreate', { subject }), st, 3_000))).toEqual([]);
    expect(st.tasks).toHaveLength(1);
  });

  it('says nothing on the READ tools — a strip that re-posted on TaskList would flicker', () => {
    const st = newTranslatorState(SID);
    create(st, 1);
    expect(strips(translate(toolUse('toolu_read1', 'TaskGet', { taskId: '1' }), st, 4_000))).toEqual([]);
    expect(strips(translate(toolUse('toolu_read2', 'TaskList', {}), st, 4_000))).toEqual([]);
  });

  it('leaves the TodoWrite path alone — same post, and no Task row created', () => {
    const st = newTranslatorState(SID);
    const posts = translate(
      toolUse('toolu_todo1', 'TodoWrite', { todos: [{ content: 'ship it', activeForm: 'shipping it', status: 'in_progress' }] }),
      st, 5_000,
    );
    expect(strips(posts)).toHaveLength(1);
    expect(rows(strips(posts)[0]!)).toEqual([
      { id: 0, content: 'ship it', activeForm: 'shipping it', status: 'in_progress', depth: 0 },
    ]);
    expect(st.tasks).toEqual([]);
  });

  it('keeps the strips of two passthrough cells apart', () => {
    const a = newTranslatorState('session-a');
    const b = newTranslatorState('session-b');
    create(a, 1);
    create(b, 2);
    expect(a.tasks.map((t) => t.subject)).toEqual(['Test task 1 - cycle 1']);
    expect(b.tasks.map((t) => t.subject)).toEqual(['Test task 2 - cycle 2']);
    // Completing A's task 1 must not touch B, whose own task 1 does not exist.
    update(a, 1);
    expect(a.tasks[0]!.status).toBe('completed');
    expect(b.tasks[0]!.status).toBe('pending');
  });
});
