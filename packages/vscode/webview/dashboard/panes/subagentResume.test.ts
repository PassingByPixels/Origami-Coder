// t-v5qi8q: a RESUMED sub-agent in the drawer. One child session, many `task`
// cards (each resume with `task_id` writes a new card), one terminal marker per
// run. The drawer row reads the LATEST card (subagentRows.ts), so the side
// channel must land there too, or the row stays RUNNING after the child is done.
//
// The event order is the owner's stress test, read from the stored session
// (parent ses_f2d31f036ffejGNkRqJuSmwBs6): 12 background `task` calls for child
// ses_f2d31869bffe36xBN6c9R0S7oo, 1 launch + 11 resumes, and after EACH run an
// injected `<task state="completed">` turn, the source of the `origami_task_state`
// marker. Every resume came after the previous run settled (the restart path).

import { describe, expect, it } from 'vitest';
import { cardForChild, settleChild } from './subagentInbox';
import { subagentRows } from './subagentRows';
import type { RosterMessage } from './subagentPassthrough';
import { logSubagentDone } from '../../../src/dashboard/sessionLogSubagent';
import type { SessionMessage } from '../../../src/dashboard/sessionLog';

const CHILD = 'ses_f2d31869bffe36xBN6c9R0S7oo';
const CALLS = [
  'call_function_veu2v4ncj07b_1', 'call_function_1xihiapxm8v3_1', 'call_function_i5tsaieev9za_1',
  'call_function_l9tk0vl6hc3w_1', 'call_function_4rju0vxxlfn2_1', 'call_function_64lf3fpzd1uz_1',
  'call_function_lg63mi1e99zp_1', 'call_function_mb9q5uox0lzb_1', 'call_function_p7uyftvnxbrt_1',
  'call_function_rvpn2plvga0b_1', 'call_function_dgee9tbjlnve_1', 'call_function_4jj7kz2kknmz_1',
];
const T0 = 1_790_243_141_991;

/** A background launcher card as the pane holds it: `completed` at spawn. */
function launcher(callId: string, i: number): RosterMessage {
  return {
    toolName: 'task', toolCallId: callId, toolStatus: 'completed', taskBackground: true,
    taskSessionId: CHILD, label: `task ${i}`, taskStartedAt: T0 + i * 60_000, timestamp: T0 + i * 60_000,
  };
}

const rowState = (messages: RosterMessage[]) => {
  const rows = subagentRows(messages, T0 + 3_600_000);
  expect(rows).toHaveLength(1); // one child = one row, however many resumes
  return rows[0]!.state;
};

describe('t-v5qi8q — a resumed sub-agent is RUNNING only while a run is out', () => {
  it('replays the stress-test order: running after each card, done after each marker', () => {
    const messages: RosterMessage[] = [];
    CALLS.forEach((callId, i) => {
      messages.push(launcher(callId, i));
      expect(rowState(messages)).toBe('running');
      expect(settleChild(messages, CHILD, 'completed', T0 + i * 60_000 + 30_000)).toBeDefined();
      expect(rowState(messages)).toBe('done');
    });
  });

  it('a resume made while the child still runs (the extend path) settles on its ONE marker', () => {
    const messages = [launcher(CALLS[0]!, 0), launcher(CALLS[1]!, 1)];
    expect(rowState(messages)).toBe('running');
    settleChild(messages, CHILD, 'completed', T0 + 90_000);
    expect(rowState(messages)).toBe('done');
  });

  it('an error marker ends the row in error, not done', () => {
    const messages = [launcher(CALLS[0]!, 0)];
    settleChild(messages, CHILD, 'completed', T0 + 1);
    messages.push(launcher(CALLS[1]!, 1));
    settleChild(messages, CHILD, 'error', T0 + 2);
    expect(rowState(messages)).toBe('error');
  });

  it('the live chunk and token riders land on the card the row reads', () => {
    const messages = [launcher(CALLS[0]!, 0), launcher(CALLS[1]!, 1)];
    expect(cardForChild(messages, CHILD)).toBe(messages[1]);
  });
});

describe('t-v5qi8q — the host log and the pane stamp the SAME card', () => {
  it('a reload restores the row the live pane showed', () => {
    // The host writes the marker into the message log, which a reopened chat is
    // rebuilt from; the pane writes it on its own cards. Both must pick the same
    // card, or the reload and the live view disagree on whether the child is out.
    const log: SessionMessage[] = [];
    const pane: RosterMessage[] = [];
    CALLS.slice(0, 3).forEach((callId, i) => {
      log.push({ kind: 'tool', text: '', timestamp: T0 + i, tool: { call: { toolCallId: callId, taskSessionId: CHILD }, result: {} } } as unknown as SessionMessage);
      pane.push(launcher(callId, i));
      logSubagentDone(log, CHILD, 'completed', T0 + i + 1);
      settleChild(pane, CHILD, 'completed', T0 + i + 1);
    });
    const stamped = log.map((m) => (m.tool?.result as { taskDone?: string } | undefined)?.taskDone ?? null);
    expect(pane.map((m) => m.taskDone ?? null)).toEqual(stamped);
  });
});
