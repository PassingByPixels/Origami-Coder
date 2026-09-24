// claudeCodeBackgroundAgent.test.ts — the `Agent` tool: a sub-agent that is
// still out when its own tool card says `completed`.
//
// THE DEFECT. On CLI 2.1.198 `Agent` launches a BACKGROUND child. Its
// tool_result comes back in the same second ("Async agent launched
// successfully… agentId: <id>"), the child's frames never return tagged with
// `parent_tool_use_id`, and the completion arrives much later as a `system`
// frame of its own. The drawer opened on `Task` only, and would have retired an
// `Agent` row on the launch result even if it had not — so a background agent
// was invisible from the moment it started.
//
// FIXTURES ARE DERIVED FROM TWO SOURCES, and each says which. The tool id, the
// description, the launch result text and the agent id come from the captured
// session `898d9e7c-b1cf-41f4-94cf-39c0796ec2b6`; the three `system` frames
// come from live PROBES of the same CLI through this extension's own spawn
// recipe. Both are carried as literals — this test reads no path outside the
// repo at run time — and the frame around a substituted block is always a
// captured stream-json line, the technique claudeCodeSubagentBeat.test.ts uses.
//
// The probes are why the settle path here is a `system` frame and not the
// injected `user` turn an earlier cut parsed: that turn is in the CLI's
// persistence log and NOT on stdout. The exit sweep at the bottom of this file
// stays all the same — a killed child sends no notification at all.

import { beforeEach, describe, expect, it } from 'vitest';
import { newTranslatorState, translate, type TranslatorState, type WebviewPost } from '../../../src/claudeCode/translator';
import { EXIT_ENDED } from '../../../src/claudeCode/subagentClose';
import {
  __resetClaudeCodeForTests, handleClaudeCodeMessage, type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import type { SpawnChild } from '../../../src/claudeCode/driver';
import { applyToolCall, applyToolResult, type ToolCardMsg } from '../panes/chatToolMsg';
import { groupSubagents, subagentRows } from '../panes/subagentRows';
import { BACKGROUND_NOTE, type RosterMessage } from '../panes/subagentPassthrough';
import { FakeChild } from './claudeCodeFakeChild';
import {
  RUN1_RESULT, RUN2_ASSISTANT_TOOL_USE, RUN2_BLOCK_START_TOOL_USE, RUN2_USER_TOOL_RESULT,
} from './claudeCodeFixtures';

const SID = 'claude-cell-1';
const CAPTURED_ID = 'toolu_01Tam2qmJwK1fMj1GQHUYkSF';
/** The captured `Agent` call and the id the CLI handed back for its child. */
const LAUNCH_ID = 'toolu_01QdWaS7JvXA7e4mySf7fqQy';
const AGENT_ID = 'a69447879ff4489db';
const BRIEF = 'Test agent: count and mark tasks done';

/** The launch tool_result, verbatim. The CLI asks that none of it be surfaced,
 *  which is one reason the settle update replaces it rather than leaving it. */
const launchText = (agentId = AGENT_ID) => [
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
  `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent.)`,
  'The agent is working in the background. You will be notified automatically when it completes.',
  "Do not duplicate this agent's work — avoid working with the same files or topics it is using.",
  `output_file: C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\c--Users-dev-Downloads-Origami-UAT\\898d9e7c-b1cf-41f4-94cf-39c0796ec2b6\\tasks\\${agentId}.output`,
].join('\n');

// THE SETTLE FRAMES, verbatim off the live probes — two throwaway haiku
// sessions run through this extension's own spawn recipe (CLI 2.1.198, this
// machine), with the flags we already pass and no --replay-user-messages.
//
// They are what corrected this feature's design. An earlier cut settled on an
// injected `user` turn carrying <task-notification>…</task-notification>, read
// out of the CLI's persistence log; the probes show that turn NEVER reaches
// stdout, and that these three `system` frames do. The probe's own ids are
// substituted below — one field of a real line, the technique this suite uses
// throughout — and the `output_file` path is the only value elided, as the
// capture itself elided it. Nothing reads it.
const PROBE_TASK_STARTED = '{"type":"system","subtype":"task_started","task_id":"aa110f9237860e61e","tool_use_id":"toolu_01Chce3rq6bFqYcBU94Fzo69","description":"Simple test","subagent_type":"general-purpose","task_type":"local_agent","prompt":"Reply with the single word done.","uuid":"bff8323f-23b4-4bc2-9a10-1731805275ad","session_id":"6bbb22b3-e681-41d8-86e8-7d92c6ffa5b5"}';
const PROBE_TASK_UPDATED = '{"type":"system","subtype":"task_updated","task_id":"aa110f9237860e61e","patch":{"status":"completed","end_time":1788218513200},"uuid":"81a2ea7c-7f07-42d6-93d9-28425bef9556","session_id":"6bbb22b3-e681-41d8-86e8-7d92c6ffa5b5"}';
const PROBE_TASK_NOTIFICATION = '{"type":"system","subtype":"task_notification","task_id":"aa110f9237860e61e","tool_use_id":"toolu_01Chce3rq6bFqYcBU94Fzo69","status":"completed","output_file":"C:\\\\...\\\\tasks\\\\aa110f9237860e61e.output","summary":"done","usage":{"total_tokens":21442,"tool_uses":0,"duration_ms":1196},"uuid":"060d5979-74bc-4794-b7b2-f886db54d3bf","session_id":"6bbb22b3-e681-41d8-86e8-7d92c6ffa5b5"}';

const ev = (line: string) => JSON.parse(line) as Record<string, unknown> & { type: string };

/** The captured `content_block_start`, renamed to `Agent` — the frame the card
 *  itself opens on. */
const agentBlockStart = (id = LAUNCH_ID) =>
  ev(RUN2_BLOCK_START_TOOL_USE.split(CAPTURED_ID).join(id).replace('"name":"Write"', '"name":"Agent"'));

/** The captured `assistant` frame carrying the real `Agent` call. */
function agentAssistant(id = LAUNCH_ID, description = BRIEF) {
  const frame = ev(RUN2_ASSISTANT_TOOL_USE);
  (frame.message as Record<string, unknown>).content = [{
    type: 'tool_use', id, name: 'Agent',
    input: { description, prompt: 'Your job is to repeat this cycle 3 times:\n1. Count to 200 (print each number)' },
    caller: { type: 'direct' },
  }];
  return frame;
}

/** The captured tool_result frame carrying the real launch text, as the CLI
 *  sends it: a list of text blocks, not a bare string. */
function launchResult(id = LAUNCH_ID, agentId = AGENT_ID) {
  const frame = ev(RUN2_USER_TOOL_RESULT);
  (frame.message as Record<string, unknown>).content = [
    { tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: launchText(agentId) }] },
  ];
  return frame;
}

/** The probe's `task_notification`, re-addressed to the agent this test
 *  launched. `toolUseId: null` drops the field entirely — the second probe's
 *  own `task_updated` carried none, so absence is a real shape, not a guess. */
function notificationEvent(taskId = AGENT_ID, status = 'completed', toolUseId: string | null = LAUNCH_ID) {
  const frame = ev(PROBE_TASK_NOTIFICATION);
  frame.task_id = taskId;
  frame.status = status;
  if (toolUseId === null) delete frame.tool_use_id; else frame.tool_use_id = toolUseId;
  return frame;
}

/** The transcript ChatPane would hold, built with the pane's own reducers. */
function transcript(posts: WebviewPost[]): RosterMessage[] {
  let messages: ToolCardMsg[] = [];
  let id = 1;
  for (const post of posts) {
    if (post.type === 'toolCall') messages = applyToolCall(messages, post, id++);
    if (post.type === 'toolResult') messages = applyToolResult(messages, post, id++);
  }
  return messages as RosterMessage[];
}

/** Launch the captured agent: the card opens, the call lands, the launch
 *  result comes back. */
function launch(st: TranslatorState, now = 1_000): WebviewPost[] {
  return [
    ...translate(agentBlockStart(), st, now),
    ...translate(agentAssistant(), st, now),
    ...translate(launchResult(), st, now),
  ];
}

const beatOf = (p: WebviewPost) => p.taskBeat as { name: string; tools: number; msgs: number; background?: boolean; ended?: string } | undefined;

describe('an Agent launch opens a row that the launch result must NOT close', () => {
  it('rides a background tally and no end stamp, on a card that IS completed', () => {
    const st = newTranslatorState(SID);
    const posts = launch(st);
    const call = posts.find((p) => p.type === 'toolResult' && p.status === 'in_progress')!;
    expect(beatOf(call)).toEqual({ name: BRIEF, tools: 0, msgs: 0 });
    expect(call.taskStartedAt).toBe(1_000);

    const result = posts.at(-1)!;
    // The CARD is honestly finished: the launch tool did return. The ROW is not.
    expect(result.status).toBe('completed');
    expect(result.taskEndedAt).toBeUndefined();
    expect(beatOf(result)).toEqual({ name: BRIEF, tools: 0, msgs: 0, background: true });
    // The tally is KEPT, and it is where the CLI's own agent id is remembered.
    expect(st.agents.get(LAUNCH_ID)).toMatchObject({ background: true, agentId: AGENT_ID });
  });

  it('shows it in the drawer as RUNNING, named, ageing, with an honest note', () => {
    const st = newTranslatorState(SID);
    const rows = subagentRows(transcript(launch(st)), 5_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('running');
    expect(rows[0]!.title).toBe(BRIEF);
    expect(rows[0]!.activity).toBe(BACKGROUND_NOTE);
    // Ticking off the launch instant, not frozen and not zero.
    expect(rows[0]!.elapsedMs).toBe(4_000);
    expect(subagentRows(transcript(launch(newTranslatorState(SID))), 9_000)[0]!.elapsedMs).toBe(8_000);
    expect(groupSubagents(rows).running).toHaveLength(1);
    expect(groupSubagents(rows).complete).toEqual([]);
    // No child session ⇒ no transcript control, exactly as the foreground path.
    expect(rows[0]!.taskSessionId).toBeUndefined();
  });

  it('survives the TURN ending — a background agent outlives turns by design', () => {
    const st = newTranslatorState(SID);
    const posts = launch(st);
    const closing = translate(ev(RUN1_RESULT), st, 6_000);
    // settleOpenTools must not have touched it.
    expect(st.agents.size).toBe(1);
    expect(subagentRows(transcript([...posts, ...closing]), 9_000)[0]!.state).toBe('running');
  });
});

describe('the task_notification system frame settles the row it names', () => {
  it('ends the row on its tool_use_id, and renders NOT ONE WORD of what the child said', () => {
    const st = newTranslatorState(SID);
    const posts = launch(st);
    // The two frames that precede it on the wire move nothing: the row has been
    // open since the launch result, and `task_started` carries the child's own
    // prompt, which this boundary never renders.
    expect(translate(ev(PROBE_TASK_STARTED), st, 7_000)).toEqual([]);
    expect(translate(ev(PROBE_TASK_UPDATED), st, 7_500)).toEqual([]);
    const settle = translate(notificationEvent(), st, 8_000);

    expect(settle).toHaveLength(1);
    expect(settle[0]).toMatchObject({ type: 'toolResult', toolCallId: LAUNCH_ID, taskEndedAt: 8_000 });
    expect(beatOf(settle[0]!)).toEqual({ name: BRIEF, tools: 0, msgs: 0, background: true, ended: 'completed' });
    // Nothing the frames carry about the CHILD crosses: not its prompt, not its
    // summary, not its token count, not the transcript file it wrote.
    const all = JSON.stringify(settle);
    expect(all).not.toContain('Reply with the single word done');
    expect(all).not.toContain('21442');
    expect(all).not.toContain('output_file');
    expect(all).not.toContain('summary');
    expect(settle.some((p) => p.type === 'agentText' || p.type === 'agentThought')).toBe(false);

    const rows = subagentRows(transcript([...posts, ...settle]), 99_000);
    expect(rows[0]!.state).toBe('done');
    expect(groupSubagents(rows).running).toEqual([]);
    expect(groupSubagents(rows).complete).toHaveLength(1);
    // A settled total, frozen — 1_000 to 8_000.
    expect(rows[0]!.elapsedMs).toBe(7_000);
    expect(rows[0]!.activity).toBe(`${BACKGROUND_NOTE}\nended: completed`);
  });

  it('settles on the tool_use_id alone, when the task_id matches nothing', () => {
    // The two joins have to be INDEPENDENT, or only one of them is really
    // tested: every other case here has both agreeing. If the launch text ever
    // stops carrying a parsable agentId, this frame's own tool_use_id — which
    // IS the tally's key — still names the row.
    const st = newTranslatorState(SID);
    const posts = launch(st);
    const settle = translate(notificationEvent('no-such-task-id', 'completed', LAUNCH_ID), st, 8_000);
    expect(settle[0]).toMatchObject({ toolCallId: LAUNCH_ID, taskEndedAt: 8_000 });
    expect(subagentRows(transcript([...posts, ...settle]), 99_000)[0]!.state).toBe('done');
  });

  it('falls back to the task_id when the frame carries no tool_use_id', () => {
    // The second probe's `task_updated` had no `tool_use_id` at all, so every
    // field of this family is optional and the join cannot depend on one.
    const st = newTranslatorState(SID);
    const posts = launch(st);
    const settle = translate(notificationEvent(AGENT_ID, 'completed', null), st, 8_000);
    expect(settle[0]).toMatchObject({ toolCallId: LAUNCH_ID, taskEndedAt: 8_000 });
    expect(subagentRows(transcript([...posts, ...settle]), 99_000)[0]!.state).toBe('done');
  });

  it('calls an agent that did not finish an ERROR, not a quiet success', () => {
    const st = newTranslatorState(SID);
    const posts = launch(st);
    // `killed` is SYNTHESIZED onto the real frame: both probes ran to
    // completion, so no capture of a non-`completed` status exists. The field
    // itself, and everything around it, is the probe's own.
    const settle = translate(notificationEvent(AGENT_ID, 'killed'), st, 8_000);
    const rows = subagentRows(transcript([...posts, ...settle]), 99_000);
    expect(rows[0]!.state).toBe('error');
    expect(rows[0]!.activity).toContain('ended: killed');
  });

  it('ignores a task this cell never launched, and never notifies twice', () => {
    const st = newTranslatorState(SID);
    launch(st);
    // A resumed conversation can be told about an agent from before this bind:
    // neither join may match, on either field.
    expect(translate(notificationEvent('b00000000000000ff', 'completed', 'toolu_01Unknown'), st, 8_000)).toEqual([]);
    expect(st.agents.size).toBe(1);
    expect(translate(notificationEvent(), st, 8_000)).toHaveLength(1);
    // An agent that is messaged again notifies again; the second is a no-op.
    expect(translate(notificationEvent(), st, 9_000)).toEqual([]);
  });

  it('settles one agent of a fan-out and leaves its sibling out', () => {
    const st = newTranslatorState(SID);
    const second = 'toolu_01SecondLaunch';
    const secondAgent = 'ae6ec37cd11270016'; // the other captured session's own id
    const posts = [
      ...launch(st),
      ...translate(agentBlockStart(second), st, 1_000),
      ...translate(agentAssistant(second, 'Count and mark tasks complete'), st, 1_000),
      ...translate(launchResult(second, secondAgent), st, 1_000),
      ...translate(notificationEvent(secondAgent, 'completed', second), st, 4_000),
    ];
    const rows = subagentRows(transcript(posts), 9_000);
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      [BRIEF, 'running'],
      ['Count and mark tasks complete', 'done'],
    ]);
    expect(st.agents.size).toBe(1);
  });

  it('leaves the FOREGROUND Task path exactly as it was', () => {
    const st = newTranslatorState(SID);
    const frame = ev(RUN2_ASSISTANT_TOOL_USE);
    (frame.message as Record<string, unknown>).content = [
      { type: 'tool_use', id: CAPTURED_ID, name: 'Task', input: { description: 'Audit the parser' } },
    ];
    translate(frame, st, 1_000);
    const closing = translate(ev(RUN2_USER_TOOL_RESULT), st, 3_000);
    expect(closing[0]).toMatchObject({ taskEndedAt: 3_000 });
    expect(beatOf(closing[0]!)).toEqual({ name: 'Audit the parser', tools: 0, msgs: 0 });
    expect(st.agents.size).toBe(0);
  });

  it('closes a Task whose CHILD quoted the launch metadata — the launcher decides', () => {
    // The CLI tells a sub-agent not to repeat that text. It can anyway, and a
    // rule that read the text alone would mark this row background and never
    // settle it: a foreground agent, home, shown as running for the session.
    const st = newTranslatorState(SID);
    const frame = ev(RUN2_ASSISTANT_TOOL_USE);
    (frame.message as Record<string, unknown>).content = [
      { type: 'tool_use', id: CAPTURED_ID, name: 'Task', input: { description: 'Explain the Agent tool' } },
    ];
    translate(frame, st, 1_000);
    const result = ev(RUN2_USER_TOOL_RESULT);
    (result.message as Record<string, unknown>).content = [
      { tool_use_id: CAPTURED_ID, type: 'tool_result', content: `It answers:\n${launchText()}` },
    ];
    const closing = translate(result, st, 3_000);
    expect(closing[0]).toMatchObject({ taskEndedAt: 3_000 });
    expect(beatOf(closing[0]!)!.background).toBeUndefined();
    expect(st.agents.size).toBe(0);
  });

  it('settles an Agent call that FAILED, rather than waiting for a child that never spawned', () => {
    const st = newTranslatorState(SID);
    translate(agentBlockStart(), st, 1_000);
    translate(agentAssistant(), st, 1_000);
    const result = ev(RUN2_USER_TOOL_RESULT);
    (result.message as Record<string, unknown>).content = [
      { tool_use_id: LAUNCH_ID, type: 'tool_result', is_error: true, content: 'Error: unknown agent type' },
    ];
    const closing = translate(result, st, 3_000);
    expect(closing[0]).toMatchObject({ status: 'failed', taskEndedAt: 3_000 });
    expect(st.agents.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SETTLE PATH THAT CANNOT SILENTLY FAIL. Driven at the real seam — the
// manager's own handler, the real driver, a scripted child — because the whole
// point is what happens when the child GOES AWAY.
// ─────────────────────────────────────────────────────────────────────────────

const CELL = 'session-1';

function seam() {
  const posts: Array<Record<string, unknown>> = [];
  const children: FakeChild[] = [];
  const spawn: SpawnChild = () => { const c = new FakeChild(); children.push(c); return c; };
  const host: ClaudeCodeHost = {
    post: (m) => posts.push(m),
    cwd: 'C:\\repo',
    read: () => undefined,
    write: () => {},
    log: () => {},
    createCell: async () => CELL,
    redispatch: () => {},
    cli: async () => ({ binary: 'C:\\claude.exe', version: '2.1.198', source: 'probe' }),
    spawn,
  };
  return { host, posts, child: () => children[children.length - 1]! };
}

beforeEach(() => __resetClaudeCodeForTests());

describe('the child exiting settles every background agent still out', () => {
  it('ends the row rather than leaving it spinning for the life of the window', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, { type: 'newClaudeCodeSession' });
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: CELL });
    const lines = [agentBlockStart(), agentAssistant(), launchResult()].map((f) => JSON.stringify(f));
    s.child().say(`${lines.join('\n')}\n`);

    const before = s.posts.filter((p) => p.type === 'toolResult' && p.taskEndedAt !== undefined);
    expect(before).toEqual([]);

    // The child dies — a crash, not a park. Nothing will ever report on the
    // agent again, so this is the last chance to settle its row.
    s.child().emitExit(1, null);

    const settled = s.posts.filter((p) => p.type === 'toolResult' && p.taskEndedAt !== undefined);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ toolCallId: LAUNCH_ID, sessionId: CELL });
    expect((settled[0]!.taskBeat as { ended?: string }).ended).toBe(EXIT_ENDED);
    // Read back through the pane's own derivation: the row is off the running
    // list, and it says it did not finish.
    const rows = subagentRows(transcript(s.posts as WebviewPost[]), 99_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('error');
    expect(groupSubagents(rows).running).toEqual([]);
  });
});
