// The supervision vocabulary (W3 wave 3, report 2.4 / F13).
//
// Four claims are asserted here rather than through a render, because each one
// is a JUDGEMENT the surface would otherwise make three times in three files:
//
//   1. WHEN A RING SAYS "error". F13: a failed agent falls back to a blank ring
//      plus a 14px `!`. An error ring must therefore exist — and must never
//      overwrite what the agent is doing RIGHT NOW, or a re-queued agent would
//      look broken while it works.
//   2. WHEN STOP IS OFFERED. `collab_stop_agent` on an idle agent is a call
//      that can only answer "nothing happened".
//   3. WHAT THE STOP OUTCOME SAYS. The engine answers `{interrupted, dequeued}`
//      and NEVER a bare ok (runner.ts: StopAgentResult). An agent that was
//      neither has to be reported as already idle, not as "stopped".
//   4. WHICH task_done ROWS TAKE A VERDICT. `collab_review` refuses anything
//      that is not a completed task, so a button offered on one is a control
//      that only ever errors.

import { describe, expect, it } from 'vitest';
import {
  agentFailures,
  canStopAgent,
  reviewableTaskId,
  ringState,
  stopOutcomeText,
} from './collabSupervision';

describe('ringState — the error kind (F13)', () => {
  it('draws error for an idle agent whose last turn failed', () => {
    expect(ringState({ slug: 'crane', state: 'idle', lastError: 'boom' })).toBe('error');
  });

  it('draws nothing for an idle agent that never failed', () => {
    expect(ringState({ slug: 'crane', state: 'idle' })).toBe('idle');
  });

  // The runner CARRIES lastError forward across a re-queue (runner.ts's
  // `lastErrorOf` on every queued/settled transition), so "it failed once" and
  // "it is working now" are both true at the same time. What it is doing now
  // wins the ring; the failure keeps its own row in the stream.
  it('lets running and queued win over a carried-forward failure', () => {
    expect(ringState({ slug: 'crane', state: 'running', lastError: 'boom' })).toBe('running');
    expect(ringState({ slug: 'crane', state: 'queued', lastError: 'boom' })).toBe('queued');
  });

  it('reads an absent status as idle rather than guessing', () => {
    expect(ringState(undefined)).toBe('idle');
  });
});

describe('canStopAgent', () => {
  it('offers Stop for a turn in flight and for a turn waiting in the queue', () => {
    expect(canStopAgent('running')).toBe(true);
    expect(canStopAgent('queued')).toBe(true);
  });

  it('offers nothing for an idle agent — there is no turn to end', () => {
    expect(canStopAgent('idle')).toBe(false);
  });
});

describe('stopOutcomeText — the engine answers what it DID', () => {
  it('names both halves when a turn was cut and a queued turn dropped', () => {
    const text = stopOutcomeText('Crane', { interrupted: true, dequeued: true });
    expect(text).toMatch(/interrupted/i);
    expect(text).toMatch(/queue/i);
    expect(text).toContain('Crane');
  });

  it('names only the interrupt when nothing was queued behind it', () => {
    const text = stopOutcomeText('Crane', { interrupted: true, dequeued: false });
    expect(text).toMatch(/interrupted/i);
    expect(text).not.toMatch(/queue/i);
  });

  it('names only the queue when there was no turn in flight', () => {
    const text = stopOutcomeText('Crane', { interrupted: false, dequeued: true });
    expect(text).toMatch(/queue/i);
    expect(text).not.toMatch(/interrupted/i);
  });

  // The honest case, and the one a bare "Stopped." would lie about: a nested
  // ask has no turn of its own to interrupt, and an idle agent has nothing at
  // all (runner.ts: stopAgent answers `interrupted: false` for both).
  it('reports an agent that was neither as already idle', () => {
    const text = stopOutcomeText('Crane', { interrupted: false, dequeued: false });
    expect(text).toMatch(/already idle/i);
    expect(text).not.toMatch(/stopped/i);
  });

  it('carries a refusal through verbatim instead of claiming an outcome', () => {
    expect(stopOutcomeText('Crane', { interrupted: false, dequeued: false, error: 'no engine' }))
      .toBe('no engine');
  });
});

describe('agentFailures — the failure gets a row, not just a 14px badge', () => {
  it('names every agent carrying a last-turn failure, in roster order', () => {
    expect(
      agentFailures([
        { slug: 'crane', state: 'idle', lastError: '@crane has no model — pick one in its agent definition' },
        { slug: 'heron', state: 'running' },
        { slug: 'fox', state: 'idle', lastError: 'provider refused' },
      ]),
    ).toEqual([
      { slug: 'crane', text: '@crane has no model — pick one in its agent definition' },
      { slug: 'fox', text: 'provider refused' },
    ]);
  });

  it('says nothing about a room where nothing has failed', () => {
    expect(agentFailures([{ slug: 'crane', state: 'running' }])).toEqual([]);
  });

  it('reads an absent statuses array as no failures, never as an error', () => {
    expect(agentFailures(undefined)).toEqual([]);
  });
});

describe('reviewableTaskId — which task_done row takes a verdict', () => {
  const DONE = { id: 'clbt_1', state: 'done' as const };
  const ACCEPTED = { id: 'clbt_2', state: 'accepted' as const };

  it('names the task of a task_done row whose task is still awaiting a verdict', () => {
    expect(reviewableTaskId({ kind: 'task_done', taskId: 'clbt_1' }, [DONE])).toBe('clbt_1');
  });

  // `collab_review` refuses a task that is not completed ("only a COMPLETED
  // task can take a verdict"), so offering the buttons on one is a control
  // that can only ever error.
  it('offers nothing once the task has been accepted', () => {
    expect(reviewableTaskId({ kind: 'task_done', taskId: 'clbt_2' }, [ACCEPTED])).toBeNull();
  });

  it('offers nothing on any other kind of row', () => {
    expect(reviewableTaskId({ kind: 'task_open', taskId: 'clbt_1' }, [DONE])).toBeNull();
    expect(reviewableTaskId({ kind: 'say' }, [DONE])).toBeNull();
  });

  // An older engine sends no board at all. ABSENT tasks means "this build has
  // no board", so a verdict button would post into nothing.
  it('offers nothing when the engine sent no board', () => {
    expect(reviewableTaskId({ kind: 'task_done', taskId: 'clbt_1' }, undefined)).toBeNull();
  });

  it('offers nothing for a row naming a task the board does not have', () => {
    expect(reviewableTaskId({ kind: 'task_done', taskId: 'clbt_9' }, [DONE])).toBeNull();
  });
});
