// claudeCodeSubagentBeat.test.ts — the sub-agent HEARTBEAT of a passthrough
// cell, end to end: CLI frames the translator drops → the tally rider → the
// tool card → the roster rows the existing left-edge drawer already renders.
//
// WHY THE WHOLE CHAIN IS IN ONE FILE. The count crosses a wire (`taskBeat` is
// an untyped payload on a `toolResult` post) and the two sides are declared
// separately — src/claudeCode/subagentBeat.ts builds it, panes/
// subagentPassthrough.ts shapes it back. A unit test either side would pass
// while the two disagreed. Running the real posts through the real card merge
// and the real derivation is the drift guard.
//
// FIXTURES ARE DERIVED, and say so per case: the two captured live runs
// (claudeCodeFixtures.ts, CLI 2.1.198) spawned no sub-agent, so the child
// frames are made the SAME way the existing drop tests make theirs — one field
// of a real line substituted (`"parent_tool_use_id":null` → an id) — and the
// `Task` blocks by replacing the content of a real `assistant` frame, the
// technique claudeCodeAdversarial.test.ts already uses for its usage shapes.

import { describe, expect, it } from 'vitest';
import { newTranslatorState, translate, type TranslatorState, type WebviewPost } from '../../../src/claudeCode/translator';
import { BEAT_MS } from '../../../src/claudeCode/subagentBeat';
import { applyToolCall, applyToolResult, type ToolCardMsg } from '../panes/chatToolMsg';
import { groupSubagents, subagentRows } from '../panes/subagentRows';
import { rosterSummary } from '../panes/subagentFormat';
import { NO_STREAM_NOTE, type RosterMessage } from '../panes/subagentPassthrough';
import {
  RUN1_ASSISTANT_TEXT_BLOCK, RUN1_RESULT, RUN1_TEXT_DELTA,
  RUN2_ASSISTANT_TOOL_USE, RUN2_BLOCK_START_TOOL_USE, RUN2_USER_TOOL_RESULT,
} from './claudeCodeFixtures';

const SID = 'claude-cell-1';
const PARENT = 'toolu_01TaskParent';
const CAPTURED_ID = 'toolu_01Tam2qmJwK1fMj1GQHUYkSF';

const ev = (line: string) => JSON.parse(line) as Record<string, unknown> & { type: string };

/** A CHILD frame: exactly the substitution the existing drop tests use. */
const asChild = (line: string, parent = PARENT) =>
  ev(line.replace('"parent_tool_use_id":null', `"parent_tool_use_id":"${parent}"`));

/** The captured `content_block_start` for a tool, renamed to `Task`. */
const taskBlockStart = (id = PARENT) =>
  ev(RUN2_BLOCK_START_TOOL_USE.split(CAPTURED_ID).join(id).replace('"name":"Write"', '"name":"Task"'));

/** The captured `assistant` tool_use frame with its ONE block replaced by a
 *  `Task`. Everything around it (model, usage, the null parent) stays real. */
function taskAssistant(description: string, id = PARENT): Record<string, unknown> & { type: string } {
  const frame = ev(RUN2_ASSISTANT_TOOL_USE);
  (frame.message as Record<string, unknown>).content = [
    { type: 'tool_use', id, name: 'Task', input: { description, prompt: 'do the thing' }, caller: { type: 'direct' } },
  ];
  return frame;
}

/** The captured tool_result frame, re-addressed to the Task's own id. */
const taskResult = (id = PARENT) => ev(RUN2_USER_TOOL_RESULT.split(CAPTURED_ID).join(id));

const beatOf = (post: WebviewPost) => post.taskBeat as { name: string; tools: number; msgs: number } | undefined;

describe('a passthrough cell counts its sub-agents without rendering them', () => {
  const open = (st: TranslatorState, now = 1_000) => translate(taskAssistant('Audit the parser', PARENT), st, now);

  it('opens a tally on the Task block, named from the model\'s own description', () => {
    const st = newTranslatorState(SID);
    const posts = open(st);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: 'toolResult', toolCallId: PARENT, sessionId: SID, taskStartedAt: 1_000 });
    expect(beatOf(posts[0]!)).toEqual({ name: 'Audit the parser', tools: 0, msgs: 0 });
    expect(st.agents.size).toBe(1);
  });

  it('names an unnamed Task rather than leaving the row blank', () => {
    const st = newTranslatorState(SID);
    const frame = taskAssistant('', PARENT);
    expect(beatOf(translate(frame, st, 1_000)[0]!)!.name).toBe('agent');
  });

  it('counts a child\'s messages and tools, and renders NOTHING it said', () => {
    const st = newTranslatorState(SID);
    open(st);
    const text = translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), st, 2_000);
    expect(beatOf(text[0]!)).toEqual({ name: 'Audit the parser', tools: 0, msgs: 1 });
    const tool = translate(asChild(RUN2_ASSISTANT_TOOL_USE), st, 4_000);
    expect(beatOf(tool[0]!)).toEqual({ name: 'Audit the parser', tools: 1, msgs: 2 });
    // The child SAID "PONG" and wrote a file. Neither reaches the transcript:
    // no post of any kind carries its prose, and the only posts at all are the
    // heartbeats, addressed to the PARENT's card.
    const all = JSON.stringify([...text, ...tool]);
    expect(all).not.toContain('PONG');
    expect(all).not.toContain('smoke.txt');
    expect([...text, ...tool].map((p) => p.type)).toEqual(['toolResult', 'toolResult']);
    expect([...text, ...tool].every((p) => p.toolCallId === PARENT)).toBe(true);
  });

  it('counts a child\'s streaming deltas ONCE — via its assistant frame only', () => {
    const st = newTranslatorState(SID);
    open(st);
    // The CLI sends every block twice. The delta half must move nothing, or a
    // 20-token reply would read as twenty messages.
    expect(translate(asChild(RUN1_TEXT_DELTA), st, 2_000)).toEqual([]);
    expect(beatOf(translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), st, 2_000)[0]!)!.msgs).toBe(1);
  });

  it('posts the first change at once, then at most one post per BEAT_MS', () => {
    const st = newTranslatorState(SID);
    open(st);
    // First change: posted immediately — a fan-out's rows must appear as the
    // work starts, not a second after it.
    expect(translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), st, 2_000)).toHaveLength(1);
    expect(translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), st, 2_000 + BEAT_MS - 1)).toEqual([]);
    const late = translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), st, 2_000 + BEAT_MS);
    // Throttled posts are not lost counts — the next post carries all three.
    expect(beatOf(late[0]!)!.msgs).toBe(3);
  });

  it('closes on the parent\'s tool_result, and stays closed', () => {
    const st = newTranslatorState(SID);
    open(st);
    translate(asChild(RUN2_ASSISTANT_TOOL_USE), st, 2_000);
    const closing = translate(taskResult(), st, 9_000);
    expect(closing[0]).toMatchObject({ toolCallId: PARENT, status: 'completed', taskEndedAt: 9_000 });
    expect(beatOf(closing[0]!)).toEqual({ name: 'Audit the parser', tools: 1, msgs: 1 });
    expect(st.agents.size).toBe(0);
    // MUTATION PROOF: remove `st.agents.delete(toolCallId)` from closeAgent and
    // this goes red — a late child frame re-posts `status: 'in_progress'` onto
    // a card that already finished, and the drawer row goes back to running.
    expect(translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), st, 10_000)).toEqual([]);
  });

  it('keeps a live tally when the CLI re-sends the same Task block', () => {
    const st = newTranslatorState(SID);
    open(st);
    translate(asChild(RUN2_ASSISTANT_TOOL_USE), st, 2_000);
    // Re-registering would zero a child that has been working for minutes.
    expect(translate(taskAssistant('Audit the parser', PARENT), st, 3_000)[0]!.taskBeat).toBeUndefined();
    expect(st.agents.get(PARENT)).toMatchObject({ tools: 1, msgs: 1, startedAt: 1_000 });
  });

  it('drops a frame whose parent it never saw, rather than inventing a row', () => {
    const st = newTranslatorState(SID);
    expect(translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK, 'toolu_unknown'), st, 1_000)).toEqual([]);
    expect(st.agents.size).toBe(0);
  });

  it('ends every tally when the turn ends', () => {
    const st = newTranslatorState(SID);
    open(st);
    translate(ev(RUN1_RESULT), st, 5_000);
    expect(st.agents.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The SEAM. Same posts, run through the card merge and the roster derivation
// the engine's own sub-agent drawer uses — no second surface, no second wire.
// ─────────────────────────────────────────────────────────────────────────────

/** The transcript ChatPane would hold after these posts, built with the pane's
 *  own reducers (chatToolMsg.ts) rather than a hand-written card. */
function transcript(posts: WebviewPost[]): RosterMessage[] {
  let messages: ToolCardMsg[] = [];
  let id = 1;
  for (const post of posts) {
    if (post.type === 'toolCall') messages = applyToolCall(messages, post, id++);
    if (post.type === 'toolResult') messages = applyToolResult(messages, post, id++);
  }
  return messages as RosterMessage[];
}

describe('the existing sub-agent drawer picks the tally up as a row', () => {
  const drive = (st: TranslatorState, ...frames: Array<[Record<string, unknown> & { type: string }, number]>) =>
    frames.flatMap(([frame, now]) => translate(frame, st, now));

  it('shows one RUNNING row per live agent, named and counted, with no transcript to open', () => {
    const st = newTranslatorState(SID);
    const posts = drive(st,
      [taskBlockStart(), 1_000],
      [taskAssistant('Audit the parser'), 1_000],
      [asChild(RUN2_ASSISTANT_TOOL_USE), 2_000],
    );
    const rows = subagentRows(transcript(posts), 5_000);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('running');
    expect(rows[0]!.title).toBe('Audit the parser');
    // The drawer's tab count and its header line — the numbers the owner asked
    // the mini tab to answer.
    expect(groupSubagents(rows).running).toHaveLength(1);
    expect(rosterSummary(rows)).toBe('1 running');
    // How busy, and why there is no stream under it.
    expect(rows[0]!.activity).toBe(`1 tool · 1 message\n${NO_STREAM_NOTE}`);
    // NO click-through: SubagentRow.svelte draws its "open transcript" control
    // only for a row with a child session, and this path never has one.
    expect(rows[0]!.taskSessionId).toBeUndefined();
    // Aged from the engine-free start stamp the rider carried, not from the
    // instant the card happened to be built.
    expect(rows[0]!.elapsedMs).toBe(4_000);
  });

  it('settles the row when the agent comes home, keeping its final counts', () => {
    const st = newTranslatorState(SID);
    const posts = drive(st,
      [taskBlockStart(), 1_000],
      [taskAssistant('Audit the parser'), 1_000],
      [asChild(RUN2_ASSISTANT_TOOL_USE), 2_000],
      [taskResult(), 8_000],
    );
    const rows = subagentRows(transcript(posts), 99_000);

    expect(rows[0]!.state).toBe('done');
    expect(groupSubagents(rows).running).toHaveLength(0);
    expect(rosterSummary(rows)).toBe('0 running · 1 done');
    expect(rows[0]!.activity).toContain('1 tool · 1 message');
    // A settled total, frozen — not still ageing off the wall clock.
    expect(rows[0]!.elapsedMs).toBe(7_000);
  });

  it('counts a FAN-OUT as many agents, each with its own name and tally', () => {
    const st = newTranslatorState(SID);
    const second = 'toolu_01TaskParentB';
    const posts = drive(st,
      [taskBlockStart(), 1_000],
      [taskAssistant('Audit the parser'), 1_000],
      [taskBlockStart(second), 1_000],
      [taskAssistant('Sweep the tests', second), 1_000],
      [asChild(RUN2_ASSISTANT_TOOL_USE), 2_000],
      [asChild(RUN1_ASSISTANT_TEXT_BLOCK, second), 2_000],
      [asChild(RUN1_ASSISTANT_TEXT_BLOCK, second), 4_000],
    );
    const rows = subagentRows(transcript(posts), 5_000);

    expect(rows.map((r) => r.title)).toEqual(['Audit the parser', 'Sweep the tests']);
    expect(rosterSummary(rows)).toBe('2 running');
    expect(rows[0]!.activity).toContain('1 tool · 1 message');
    expect(rows[1]!.activity).toContain('0 tools · 2 messages');
  });
});

describe('the tally is SHAPED off the wire, never trusted', () => {
  // The reload path replays a LOGGED payload rather than a decoded one, so junk
  // reaches the pane on this field exactly as it does on the task riders.
  const card = (taskBeat: unknown): RosterMessage[] => {
    const built = applyToolCall([] as ToolCardMsg[], { toolCallId: PARENT, toolName: 'Task', title: 'Task' }, 1);
    return applyToolResult(built, { toolCallId: PARENT, status: 'in_progress', taskBeat }, 2) as RosterMessage[];
  };

  it('refuses a non-object, so junk cannot admit a row', () => {
    for (const junk of ['hello', 42, null, [1, 2]]) expect(subagentRows(card(junk), 0)).toEqual([]);
  });

  it('floors missing and negative counts at zero rather than printing them', () => {
    const rows = subagentRows(card({ name: 'Half a beat', tools: -3, msgs: 'many' }), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Half a beat');
    expect(rows[0]!.activity).toBe(`0 tools · 0 messages\n${NO_STREAM_NOTE}`);
  });
});

describe('two passthrough cells counting at once share no tally', () => {
  it('keeps identically-named agents, and identically-keyed frames, apart', () => {
    const a = newTranslatorState('session-a');
    const b = newTranslatorState('session-b');
    // The SAME parent id in both cells — the worst case, and the one a module
    // level map would silently merge.
    translate(taskAssistant('Audit the parser'), a, 1_000);
    translate(taskAssistant('Sweep the tests'), b, 1_000);
    translate(asChild(RUN2_ASSISTANT_TOOL_USE), a, 2_000);
    const bPost = translate(asChild(RUN1_ASSISTANT_TEXT_BLOCK), b, 2_000);

    expect(beatOf(bPost[0]!)).toEqual({ name: 'Sweep the tests', tools: 0, msgs: 1 });
    expect(bPost[0]!.sessionId).toBe('session-b');
    // A's own tally moved only on A's frame.
    expect(a.agents.get(PARENT)).toMatchObject({ name: 'Audit the parser', tools: 1, msgs: 1 });
    expect(b.agents.get(PARENT)).toMatchObject({ name: 'Sweep the tests', tools: 0, msgs: 1 });
    // Closing A leaves B's agent out — MUTATION PROOF for the per-cell bag.
    translate(taskResult(), a, 3_000);
    expect(a.agents.size).toBe(0);
    expect(b.agents.size).toBe(1);
  });
});
