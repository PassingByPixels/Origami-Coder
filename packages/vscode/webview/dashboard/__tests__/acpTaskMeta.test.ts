// acpTaskMeta — the sub-agent `_meta` riders, and the guard that keeps them
// spelled the same on both sides of the wire.
//
// The decoders are fail-closed on purpose: a rider that half-arrives must leave
// the row alone. The wrong failure here is silent — a renamed key does not
// throw, it just leaves the drawer listing agents that finished an hour ago,
// with a green test suite. Hence the drift guard, which reads the ENGINE source
// and asserts every key this file looks for is still written there.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskDone, taskRiders } from '../../../src/acpTaskMeta';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, rel), 'utf8');

describe('acpTaskMeta — riders on a task tool update', () => {
  it('reads the child session, the detached flag and the routed model', () => {
    expect(
      taskRiders({
        _meta: {
          origami_task_session: 'ses_child',
          origami_task_background: true,
          origami_task_model: 'openrouter/qwen3-coder',
        },
      }),
    ).toEqual({
      taskSessionId: 'ses_child',
      taskBackground: true,
      taskModel: 'openrouter/qwen3-coder',
      taskStartedAt: undefined,
      taskEndedAt: undefined,
    });
  });

  it('reads the run SPAN the engine rides off its stored tool state', () => {
    // The reload defect in one assertion: a reopened chat rebuilds every card
    // with a fresh `Date.now()`, so the drawer aged an hour-long run from the
    // instant of the reload and printed `0s`. These two are the only start and
    // end that survive that, and they are useless if this decoder drops them.
    const riders = taskRiders({
      _meta: { origami_task_session: 'ses_child', origami_task_started: 1_700_000_000_000, origami_task_ended: 1_700_000_090_000 },
    });
    expect(riders.taskStartedAt).toBe(1_700_000_000_000);
    expect(riders.taskEndedAt).toBe(1_700_000_090_000);
  });

  it('refuses a junk or ZERO stamp rather than passing it to the clock', () => {
    // `0` is the one that bites: it is a number, it is finite, and it would
    // render as a sub-agent that has been out since 1970.
    const riders = taskRiders({
      _meta: { origami_task_session: 'ses_child', origami_task_started: 0, origami_task_ended: 'soon' },
    });
    expect(riders.taskStartedAt).toBeUndefined();
    expect(riders.taskEndedAt).toBeUndefined();
  });

  it('a plain tool update yields nothing to spread over the handler args', () => {
    // Spreading `{ taskSessionId: undefined }` over an earlier value would ERASE
    // it — the pending call has no id, and only the update carries one.
    expect(taskRiders({})).toEqual({});
    expect(taskRiders(undefined)).toEqual({});
    expect(taskRiders({ _meta: null })).toEqual({});
  });

  it('a FOREGROUND child reports no background flag at all, never false', () => {
    const riders = taskRiders({ _meta: { origami_task_session: 'ses_child' } });
    expect(riders.taskBackground).toBeUndefined();
    expect(riders.taskModel).toBeUndefined();
  });

  it('ignores wrong-typed riders rather than passing junk to the card', () => {
    const riders = taskRiders({
      _meta: { origami_task_session: 7, origami_task_background: 'yes', origami_task_model: '' },
    });
    expect(riders).toEqual({
      taskSessionId: undefined, taskBackground: undefined, taskModel: undefined,
      taskStartedAt: undefined, taskEndedAt: undefined,
    });
  });
});

describe('acpTaskMeta — the terminal marker', () => {
  it('reads a settled child, both ways it can end', () => {
    expect(taskDone({ _meta: { origami_task_session: 'ses_child', origami_task_state: 'completed' } }))
      .toEqual({ taskSessionId: 'ses_child', state: 'completed' });
    expect(taskDone({ _meta: { origami_task_session: 'ses_child', origami_task_state: 'error' } }))
      .toEqual({ taskSessionId: 'ses_child', state: 'error' });
  });

  it('carries WHEN the child settled — the only end a detached one ever gets', () => {
    // A background launcher's own tool state ended back at spawn (~12ms), so
    // without this the drawer has a start and no end and shows a finished
    // child ageing off the wall clock.
    expect(taskDone({
      _meta: { origami_task_session: 'ses_child', origami_task_state: 'completed', origami_task_ended: 1_700_000_090_000 },
    })).toEqual({ taskSessionId: 'ses_child', state: 'completed', endedAt: 1_700_000_090_000 });
  });

  it('a marker with no time is still a marker — the row retires, blank total', () => {
    // A replayed injected turn can carry no `time.created`. Refusing the whole
    // marker over a missing duration would resurrect a dead sub-agent.
    const done = taskDone({ _meta: { origami_task_session: 'ses_child', origami_task_state: 'error' } });
    expect(done).toEqual({ taskSessionId: 'ses_child', state: 'error' });
    expect(done && 'endedAt' in done).toBe(false);
  });

  it('a task tool update is NOT a marker — it carries the id but no state', () => {
    // Both ride `origami_task_session`; only the marker says how it ended, and
    // treating a live update as one would retire the row at spawn time.
    expect(taskDone({ _meta: { origami_task_session: 'ses_child', origami_task_background: true } }))
      .toBeUndefined();
  });

  it('refuses a half-formed marker — a wrongly retired row is an unwatched agent', () => {
    expect(taskDone({ _meta: { origami_task_state: 'completed' } })).toBeUndefined();
    expect(taskDone({ _meta: { origami_task_session: '', origami_task_state: 'completed' } })).toBeUndefined();
    expect(taskDone({ _meta: { origami_task_session: 'ses_child', origami_task_state: 'finished' } }))
      .toBeUndefined();
    expect(taskDone({})).toBeUndefined();
  });
});

// The mirror guard. The webview cannot import engine code (tsconfig.webview
// pins rootDir), so these key names are declared twice — the house rule is that
// every mirror is read by a test that fails when the two sides disagree.
describe('acpTaskMeta — drift guard against the engine', () => {
  const KEYS = [
    'origami_task_session',
    'origami_task_background',
    'origami_task_model',
    'origami_task_state',
    'origami_task_started',
    'origami_task_ended',
  ];

  it('every key this file decodes is still WRITTEN by acp/event.ts', () => {
    const engine = read('../../../../engine/src/acp/event.ts');
    const client = read('../../../src/acpTaskMeta.ts');
    for (const key of KEYS) {
      expect(engine, `engine no longer writes ${key}`).toContain(key);
      expect(client, `client no longer reads ${key}`).toContain(key);
    }
  });

  it('the engine writes no task rider this file has never heard of', () => {
    // The other direction: a NEW rider added engine-side that nothing decodes is
    // a fact the drawer is silently throwing away.
    const engine = read('../../../../engine/src/acp/event.ts');
    const found = new Set(engine.match(/origami_task_[a-z_]+/g) ?? []);
    expect([...found].sort()).toEqual([...KEYS].sort());
  });
});
