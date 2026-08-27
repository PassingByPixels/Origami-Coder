// loopReopen.ts unit tests — bringing a persistent loop's CHAT back after it
// was closed. The bugs these exist to catch are all about IDENTITY and ORDER:
//
//  - reopening onto a NEW engine session instead of the one the loop has been
//    writing to, which silently loses every accumulated turn;
//  - opening the chat while the headless client is still live, which puts two
//    clients on one engine session and TWO timers on one loop;
//  - a failed recall taking the persisted record (and the prompt) with it.
//
// The plan is pure; the enactment is driven through the exact ReopenHost
// DashboardPanel implements, so call ORDER and arm COUNT are asserted rather
// than read off the source.

import { describe, it, expect, vi } from 'vitest';
import {
  planLoopReopen, reopenLoopChat,
  type ReopenHost, type ReopenPlan, type ReopenSessionSource,
} from '../../../src/dashboard/agentManager/loopReopen';
import type { PersistedLoop } from '../../../src/dashboard/agentManager/loopPersistence';

const loop = (over: Partial<PersistedLoop> = {}): PersistedLoop => ({
  sessionId: 'eng-A', intervalMs: 1_800_000, prompt: 'poll the deploy', runs: 7, createdAt: 1000, persistent: true, ...over,
});

const headless = (over: Partial<ReopenSessionSource> = {}): ReopenSessionSource => ({
  kind: 'agent',
  client: { currentSessionId: 'eng-A' },
  loopSchedule: { intervalMs: 1_800_000, prompt: 'poll the deploy', runs: 9, createdAt: 1000, persistent: true },
  ...over,
});

const chat = (engineId: string | null = 'eng-A'): ReopenSessionSource => ({
  kind: 'chat',
  client: { currentSessionId: engineId },
  loopSchedule: { intervalMs: 60_000, prompt: 'check CI', runs: 2, createdAt: 1, persistent: true },
});

/** A recording host. `calls` is the ORDERED transcript — the double-arm and
 *  two-clients bugs are both order bugs, so order is the assertion. `openResult`
 *  null stands for "the engine session would not load"; the recording is built
 *  in rather than overridable, so a failure-case host still logs its own calls. */
function fakeHost(opts: { openResult?: string | null } = {}) {
  const calls: string[] = [];
  const armed: Array<{ localId: string; loop: PersistedLoop }> = [];
  const reports: string[] = [];
  const openChat = vi.fn(async (engineId: string) => {
    calls.push(`openChat:${engineId}`);
    return opts.openResult === undefined ? 'session-9' : opts.openResult;
  });
  const host: ReopenHost = {
    detach: (localId) => { calls.push(`detach:${localId}`); },
    openChat,
    arm: (localId, l) => { calls.push(`arm:${localId}`); armed.push({ localId, loop: l }); },
    recallHeadless: async (l) => { calls.push(`recallHeadless:${l.sessionId}`); },
    reveal: (localId) => { calls.push(`reveal:${localId}`); },
    report: (m) => { calls.push('report'); reports.push(m); },
  };
  return { host, calls, armed, reports, openChat };
}

describe('planLoopReopen — which id space the row came from, and what reopening it means', () => {
  it('a HEADLESS row (local id) plans a detach carrying its ENGINE session id', () => {
    const plan = planLoopReopen('session-3', new Map([['session-3', headless()]]), []);
    expect(plan.kind).toBe('detach');
    expect(plan).toMatchObject({ localId: 'session-3', engineId: 'eng-A' });
  });

  it('the detach carries the LIVE run count, not the staler persisted one', () => {
    // `runs` is only flushed to storage after each tick, so mid-interval the
    // persisted copy is behind. Re-arming from it would silently rewind the count.
    const plan = planLoopReopen('session-3', new Map([['session-3', headless()]]), [loop({ runs: 7 })]);
    expect(plan.kind === 'detach' && plan.loop.runs).toBe(9);
  });

  it('a NEEDS-ATTENTION row (engine id, no live session) plans a recall from the persisted record', () => {
    const plan = planLoopReopen('eng-A', new Map(), [loop()]);
    expect(plan).toEqual({ kind: 'recall', engineId: 'eng-A', loop: loop() });
  });

  it('a row whose chat is ALREADY OPEN plans a reveal — never a teardown and rebuild', () => {
    const plan = planLoopReopen('session-1', new Map([['session-1', chat()]]), []);
    expect(plan).toEqual({ kind: 'already-open', localId: 'session-1' });
  });

  it('an id in neither space plans nothing at all', () => {
    expect(planLoopReopen('session-gone', new Map(), [loop({ sessionId: 'eng-A' })])).toEqual({ kind: 'unknown' });
  });

  it('a headless session that never got an engine id has nothing to reopen ONTO', () => {
    const src = headless({ client: { currentSessionId: null } });
    expect(planLoopReopen('session-3', new Map([['session-3', src]]), [loop()])).toEqual({ kind: 'unknown' });
  });

  it('a headless session whose loop stopped between broadcast and click falls back to the persisted record', () => {
    const src = headless({ loopSchedule: undefined });
    const plan = planLoopReopen('session-3', new Map([['session-3', src]]), [loop({ runs: 7 })]);
    expect(plan.kind === 'detach' && plan.loop.runs).toBe(7);
  });

  it('...and with no persisted record either, there is genuinely nothing to re-arm', () => {
    const src = headless({ loopSchedule: undefined });
    expect(planLoopReopen('session-3', new Map([['session-3', src]]), [])).toEqual({ kind: 'unknown' });
  });
});

describe('reopenLoopChat — ONE client per engine session, ONE timer per loop', () => {
  const detachPlan = (): ReopenPlan => ({ kind: 'detach', localId: 'session-3', engineId: 'eng-A', loop: loop() });

  it('detaches the headless session BEFORE opening the chat — never two clients on one engine session', async () => {
    const { host, calls } = fakeHost();
    await reopenLoopChat(detachPlan(), host);
    expect(calls).toEqual(['detach:session-3', 'openChat:eng-A', 'arm:session-9']);
  });

  it('opens the chat on the SAME engine session id the loop has been writing to', async () => {
    const { host, openChat } = fakeHost();
    await reopenLoopChat(detachPlan(), host);
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith('eng-A');
  });

  it('arms the reopened chat EXACTLY ONCE, with the loop intact', async () => {
    // The double-arm bug: the headless timer left running plus a new chat timer,
    // both prompting the one engine session every interval.
    const { host, armed, calls } = fakeHost();
    await reopenLoopChat(detachPlan(), host);
    expect(armed).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('arm:'))).toHaveLength(1);
    expect(armed[0]).toEqual({ localId: 'session-9', loop: loop() });
  });

  it('a needs-attention recall opens the chat with NO detach — there is no live client to drop', async () => {
    const { host, calls } = fakeHost();
    await reopenLoopChat({ kind: 'recall', engineId: 'eng-A', loop: loop() }, host);
    expect(calls).toEqual(['openChat:eng-A', 'arm:session-9']);
  });

  it('an already-open row is revealed and nothing else — no close, no re-open, no second arm', async () => {
    const { host, calls } = fakeHost();
    const outcome = await reopenLoopChat({ kind: 'already-open', localId: 'session-1' }, host);
    expect(outcome).toBe('revealed');
    expect(calls).toEqual(['reveal:session-1']);
  });

  it('an unknown row says so instead of opening something arbitrary', async () => {
    const { host, calls, reports } = fakeHost();
    const outcome = await reopenLoopChat({ kind: 'unknown' }, host);
    expect(outcome).toBe('unknown');
    expect(calls).toEqual(['report']);
    expect(reports[0]).toContain('no chat to reopen');
  });
});

describe('reopenLoopChat — an engine session that will not load degrades honestly', () => {
  const gonePlan = (over: Partial<PersistedLoop> = {}): ReopenPlan =>
    ({ kind: 'detach', localId: 'session-3', engineId: 'eng-A', loop: loop(over) });

  it('never arms a timer on a chat whose recall failed', async () => {
    const { host, armed, reports } = fakeHost({ openResult: null });
    const outcome = await reopenLoopChat(gonePlan(), host);
    expect(outcome).toBe('unavailable');
    expect(armed).toEqual([]);
    expect(reports[0]).toContain('could not reopen');
    expect(reports[0]).toContain('eng-A');
  });

  it('says the schedule is KEPT — the prompt is the loop, and losing it silently is the failure mode', async () => {
    const { host, reports } = fakeHost({ openResult: null });
    await reopenLoopChat(gonePlan(), host);
    expect(reports[0]).toContain('schedule is kept');
  });

  it('puts a detached PERSISTENT loop back headless, so a failed reopen costs nothing that was running', async () => {
    const { host, calls } = fakeHost({ openResult: null });
    await reopenLoopChat(gonePlan(), host);
    expect(calls).toEqual(['detach:session-3', 'openChat:eng-A', 'report', 'recallHeadless:eng-A']);
  });

  it('does NOT recall a NON-persistent loop headlessly — that would promote it behind the user', async () => {
    // A headless row whose Persistent switch was flipped off. recallHeadless is
    // the persistent path (it re-arms with the flag set), so running this one
    // through it would silently turn the setting back on.
    const { host, calls } = fakeHost({ openResult: null });
    await reopenLoopChat(gonePlan({ persistent: false }), host);
    expect(calls).not.toContain('recallHeadless:eng-A');
  });

  it('a needs-attention recall that fails again touches nothing — no detach to undo', async () => {
    const { host, calls, armed } = fakeHost({ openResult: null });
    const outcome = await reopenLoopChat({ kind: 'recall', engineId: 'eng-A', loop: loop() }, host);
    expect(outcome).toBe('unavailable');
    expect(armed).toEqual([]);
    expect(calls).toEqual(['openChat:eng-A', 'report']);
  });
});
