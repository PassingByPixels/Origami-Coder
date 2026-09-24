// subagentLabel — what a sub-agent is CALLED, and the number it is called by.
//
// The owner's defect on 0.4.139: every sub-agent row, tab and card read `task`,
// because each surface printed the tool call's own header and that header IS the
// tool name on the pending frame. The fix is one identity, derived from facts the
// engine already sends (`rawInput.description`, `rawInput.subagent_type`), and
// used everywhere.
//
// The case worth the most here is the ORDINAL across a RELOAD: a T-number that
// renumbered when a chat was reopened would be worse than no number, because the
// user would be pointing at T2 and getting a different agent. It survives for a
// structural reason — a recalled chat replays its message log in write order —
// so the test replays a log through the real restore path rather than asserting
// the numbers a second time in the same shape the code computes them.

import { describe, expect, it } from 'vitest';
import { restoreLog, type RestoredEntry } from './chatRestore';
import { subagentRows, type SubagentMessage } from './subagentRows';
import {
  subagentIdentity,
  subagentKey,
  subagentLabel,
  subagentOrdinals,
  subagentShort,
  taskIdentity,
} from './subagentLabel';

const NOW = 1_700_000_100_000;
const card = (over: Partial<SubagentMessage> = {}): SubagentMessage => ({
  taskSessionId: 'child-1',
  label: 'task',
  toolName: 'task',
  toolStatus: 'in_progress',
  timestamp: NOW - 5_000,
  ...over,
});

describe('taskIdentity — reading the identity off the wire', () => {
  it('takes the description and the agent type from a task call input', () => {
    expect(taskIdentity('task', { description: 'audit the bundle', subagent_type: 'Explore', prompt: 'go' }))
      .toEqual({ taskDescription: 'audit the bundle', taskAgentType: 'Explore' });
  });

  it('reads NOTHING from any other tool, however its input is shaped', () => {
    // The fields are generic words. A `bash` call carrying `description` must
    // not turn an ordinary tool card into a sub-agent's name.
    expect(taskIdentity('bash', { description: 'run the tests' })).toEqual({});
    expect(taskIdentity('task_parallel', { description: 'fan out' })).toEqual({});
  });

  it('returns an empty object rather than empty strings for a missing input', () => {
    // Spread onto a card by both the pending frame and every later update, so
    // "nothing here" must not overwrite what an earlier frame already knew.
    expect(taskIdentity('task', undefined)).toEqual({});
    expect(taskIdentity('task', null)).toEqual({});
    expect(taskIdentity('task', { description: '   ', subagent_type: '' })).toEqual({});
  });
});

describe('subagentLabel — one name on every surface', () => {
  it('prints `<type> · T<n> · <description>`', () => {
    expect(subagentLabel({ ordinal: 2, agentType: 'Explore', description: 'audit the bundle' }))
      .toBe('Explore · T2 · audit the bundle');
  });

  it('drops a MISSING TYPE rather than inventing one', () => {
    // An older engine rides no `subagent_type`. `general-purpose · T1` would be
    // a claim about routing that nobody made.
    expect(subagentLabel({ ordinal: 1, description: 'audit the bundle' })).toBe('T1 · audit the bundle');
  });

  it('drops a MISSING DESCRIPTION rather than falling back to the card header', () => {
    // Falling back is the defect: that header is the word `task`. A bare
    // `Explore · T3` still names an agent the user can point at.
    expect(subagentLabel({ ordinal: 3, agentType: 'Explore' })).toBe('Explore · T3');
    expect(subagentLabel({ ordinal: 3 })).toBe('T3');
  });

  it('says T? for a row that was never numbered, not T0', () => {
    // `T0` reads as a real ordinal. A blank would leave an unclickable tab.
    expect(subagentShort({ ordinal: 0 })).toBe('T?');
    expect(subagentShort({ ordinal: 2 })).toBe('T2');
  });

  it('is IDEMPOTENT over the identity, so a second caller gets the same string', () => {
    // The agent map (a separate surface) calls this on the same row the drawer
    // already labelled. Two calls, one answer.
    const row = { ordinal: 2, agentType: 'Explore', description: 'audit the bundle' };
    expect(subagentLabel(row)).toBe(subagentLabel(row));
  });
});

describe('subagentOrdinals — T-numbers in spawn order', () => {
  it('numbers from 1 in the order the cards appear', () => {
    const ordinals = subagentOrdinals([
      card({ taskSessionId: 'a' }),
      card({ taskSessionId: 'b' }),
      card({ taskSessionId: 'c' }),
    ]);
    expect([...ordinals]).toEqual([['a', 1], ['b', 2], ['c', 3]]);
  });

  it('keeps a RESUMED agent on its first number', () => {
    // A resumed sub-agent writes a second `task` card for the same child. It is
    // the same agent and must not jump to the end of the queue.
    const ordinals = subagentOrdinals([
      card({ taskSessionId: 'a' }),
      card({ taskSessionId: 'b' }),
      card({ taskSessionId: 'a', toolStatus: 'completed' }),
    ]);
    expect(ordinals.get('a')).toBe(1);
    expect(ordinals.get('b')).toBe(2);
  });

  it('ignores every message that is not a sub-agent', () => {
    const ordinals = subagentOrdinals([
      { label: 'read', toolName: 'read', toolStatus: 'completed' },
      card({ taskSessionId: 'a' }),
    ]);
    expect([...ordinals]).toEqual([['a', 1]]);
  });

  it('numbers by the SAME key the roster dedupes on', () => {
    // If the two rules ever disagreed, the drawer would print T2 for a card the
    // transcript printed T3 for.
    const denied = card({ taskSessionId: undefined, toolCallId: 'tc-9', toolStatus: 'failed' });
    expect(subagentKey(denied)).toBe('tc-9');
    expect(subagentOrdinals([denied]).get('tc-9')).toBe(1);
  });
});

describe('the T-number SURVIVES a webview reload', () => {
  /** One session-log entry as the host stores a `task` tool call. */
  const entry = (child: string, description: string): RestoredEntry => ({
    kind: 'tool',
    text: 'task',
    timestamp: NOW - 60_000,
    tool: {
      call: {
        toolCallId: `tc-${child}`,
        toolName: 'task',
        title: 'task',
        status: 'in_progress',
        taskSessionId: child,
        rawInput: { description, subagent_type: 'general-purpose', prompt: 'go' },
      },
    },
  });

  it('replays a stored chat and hands every agent back the number it had', () => {
    // The whole reload path: the host's message log -> chatRestore -> the rows
    // the drawer draws. Nothing here stamps a number; it falls out of the order.
    let id = 0;
    const restored = restoreLog<SubagentMessage & { id: number; kind: string; label: string; text: string }>(
      [],
      [entry('child-a', 'audit the bundle'), entry('child-b', 'map the routes'), entry('child-c', 'chase the leak')],
      () => ++id,
      'coder',
    );
    const rows = subagentRows(restored, NOW);

    expect(rows.map(subagentLabel)).toEqual([
      'general-purpose · T1 · audit the bundle',
      'general-purpose · T2 · map the routes',
      'general-purpose · T3 · chase the leak',
    ]);
    // The header the surfaces USED to print, still on the card and still useless.
    expect(rows.map((r) => r.title)).toEqual(['task', 'task', 'task']);
  });

  it('keeps T2 as T2 when the chat is reopened after T1 was dismissed', () => {
    // Dismissal retires a ROW, not a number: the roster is numbered over the
    // whole transcript before anything is filtered out.
    let id = 0;
    const restored = restoreLog<SubagentMessage & { id: number; kind: string; label: string; text: string }>(
      [],
      [entry('child-a', 'audit the bundle'), entry('child-b', 'map the routes')],
      () => ++id,
      'coder',
    );
    expect(subagentRows(restored, NOW, new Set(['child-a'])).map(subagentShort)).toEqual(['T2']);
  });
});

describe('subagentIdentity — one card, one identity', () => {
  it('carries the description and type the card was given', () => {
    expect(subagentIdentity(card({ taskDescription: 'audit the bundle', taskAgentType: 'Explore' }), 2))
      .toEqual({ ordinal: 2, description: 'audit the bundle', agentType: 'Explore' });
  });

  it('names a Claude passthrough child by its heartbeat brief', () => {
    // That path makes no `task` call at all, so it has no rawInput to read; the
    // brief on the beat is the only description it will ever have.
    expect(subagentIdentity(card({ taskBeat: { name: 'research detour', tools: 0, msgs: 0 } }), 1))
      .toEqual({ ordinal: 1, description: 'research detour' });
  });
});
