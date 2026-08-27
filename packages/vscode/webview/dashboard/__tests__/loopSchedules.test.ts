// Unit tests for the Loops pane's host-side data leaf: the pure Session-map ->
// LoopScheduleInfo[] projection behind listLoopSchedules/loopSchedulesData.
// Asserts the CONTRACT (which sessions surface, and what they carry), not the
// implementation — a session with no active /loop timer must never appear,
// and one that does must carry the real chat identity + a human interval.

import { describe, it, expect } from 'vitest';
import { collectLoopSchedules, toNeedsAttentionLoops } from '../../../src/dashboard/loopSchedules';

interface Fixture {
  number: number;
  agentName: string;
  title?: string;
  kind?: 'chat' | 'agent';
  loopSchedule?: {
    intervalMs: number; prompt: string; runs: number; stopped: boolean; persistent?: boolean;
    nextRunAt?: number; lastRunAt?: number; lastOutcome?: 'ok' | 'failed';
  };
}

describe('collectLoopSchedules', () => {
  it('an empty session map yields no schedules', () => {
    expect(collectLoopSchedules(new Map())).toEqual([]);
  });

  it('a session with no loopSchedule (an ordinary chat) is excluded', () => {
    const sessions = new Map<string, Fixture>([
      ['s1', { number: 1, agentName: 'Tsuru' }],
    ]);
    expect(collectLoopSchedules(sessions)).toEqual([]);
  });

  it('a session running an active /loop is projected with a human interval label', () => {
    const sessions = new Map<string, Fixture>([
      ['s1', {
        number: 1, agentName: 'Tsuru', title: 'triage CI',
        loopSchedule: { intervalMs: 1_800_000, prompt: 'check for newly failing tests', runs: 3, stopped: false },
      }],
    ]);
    expect(collectLoopSchedules(sessions)).toEqual([
      {
        sessionId: 's1', number: 1, agentName: 'Tsuru', title: 'triage CI', intervalLabel: '30m',
        prompt: 'check for newly failing tests', runs: 3, persistent: false, headless: false,
        nextRunAt: null, lastRunAt: null, lastOutcome: null,
      },
    ]);
  });

  it('a loop with no persistent flag projects as NOT persistent — absent never means yes', () => {
    // Every loop persisted before the flag existed must keep dying with its
    // chat. Defaulting the other way would silently promote a stranger's old
    // loops into ones that outlive the chat they were started from.
    const sessions = new Map<string, Fixture>([
      ['s1', { number: 1, agentName: 'Tsuru', loopSchedule: { intervalMs: 60_000, prompt: 'x', runs: 1, stopped: false } }],
    ]);
    expect(collectLoopSchedules(sessions)[0].persistent).toBe(false);
  });

  it('a headless session (a persistent loop pulled back up) is flagged as having no chat', () => {
    const sessions = new Map<string, Fixture>([
      ['s1', { number: 1, agentName: 'Tsuru', kind: 'agent', loopSchedule: { intervalMs: 60_000, prompt: 'x', runs: 4, stopped: false, persistent: true } }],
    ]);
    const [row] = collectLoopSchedules(sessions);
    expect(row.headless).toBe(true);
    expect(row.persistent).toBe(true);
  });

  it('a defensively-stopped schedule (stopped: true survives somehow) is excluded even though DashboardPanel normally clears it to undefined', () => {
    const sessions = new Map<string, Fixture>([
      ['s1', { number: 1, agentName: 'Tsuru', loopSchedule: { intervalMs: 60_000, prompt: 'x', runs: 1, stopped: true } }],
    ]);
    expect(collectLoopSchedules(sessions)).toEqual([]);
  });

  it('multiple active schedules across chats all surface, in session-map order', () => {
    const sessions = new Map<string, Fixture>([
      ['s1', { number: 1, agentName: 'Tsuru', loopSchedule: { intervalMs: 3_600_000, prompt: 'watch CI', runs: 0, stopped: false } }],
      ['s2', { number: 2, agentName: 'Tsuru', loopSchedule: { intervalMs: 45_000, prompt: 'poll spark', runs: 12, stopped: false } }],
    ]);
    const out = collectLoopSchedules(sessions);
    expect(out.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(out[0].intervalLabel).toBe('1h');
    expect(out[1].intervalLabel).toBe('45s');
  });
});

describe('collectLoopSchedules — the next-run instant comes off the ARMED TIMER', () => {
  const withSched = (over: Record<string, unknown>) => new Map<string, Fixture>([
    ['s1', { number: 1, agentName: 'Tsuru', loopSchedule: { intervalMs: 120_000, prompt: 'x', runs: 4, stopped: false, ...over } }],
  ]);

  it('a loop with a timer armed carries that exact instant', () => {
    expect(collectLoopSchedules(withSched({ nextRunAt: 1_800_000_000 }))[0].nextRunAt).toBe(1_800_000_000);
  });

  it('a loop with NO armed timer reports null — never createdAt + interval * runs', () => {
    // The drifting formula would answer here, and be wrong by however long the
    // four runs took. Between a tick starting and its next timer arming there
    // is genuinely no scheduled instant, and the pane must be told so.
    expect(collectLoopSchedules(withSched({}))[0].nextRunAt).toBeNull();
  });

  it('a completed run rides through as a time AND an outcome', () => {
    const [row] = collectLoopSchedules(withSched({ lastRunAt: 1_700_000_000, lastOutcome: 'failed' }));
    expect(row.lastRunAt).toBe(1_700_000_000);
    expect(row.lastOutcome).toBe('failed');
  });

  it('an outcome with no time is dropped whole — half a record is not a last run', () => {
    // The pane keys "has this loop run?" off lastRunAt. Letting a bare outcome
    // through would render an outcome for a run with no time attached to it.
    const [row] = collectLoopSchedules(withSched({ lastOutcome: 'ok' }));
    expect(row.lastRunAt).toBeNull();
    expect(row.lastOutcome).toBeNull();
  });

  it('a time with no outcome keeps the time and reports no outcome, never guessing "ok"', () => {
    const [row] = collectLoopSchedules(withSched({ lastRunAt: 1_700_000_000 }));
    expect(row.lastRunAt).toBe(1_700_000_000);
    expect(row.lastOutcome).toBeNull();
  });
});

describe('toNeedsAttentionLoops', () => {
  it('carries NO next-run field — nothing is armed for one of these at all', () => {
    // A persisted loop whose session never came back has no timer anywhere in
    // the process. Any next-run here would be pure invention, so the wire shape
    // does not have somewhere to put one.
    const [out] = toNeedsAttentionLoops([
      { sessionId: 'eng-A', intervalMs: 900_000, prompt: 'poll', runs: 7, createdAt: 1000 },
    ]);
    expect(out).not.toHaveProperty('nextRunAt');
    expect(out).not.toHaveProperty('lastRunAt');
  });

  it('projects persisted loops into wire data with a human interval label', () => {
    expect(toNeedsAttentionLoops([
      { sessionId: 'eng-A', intervalMs: 900_000, prompt: 'poll the deploy', runs: 7, createdAt: 1000 },
    ])).toEqual([
      { sessionId: 'eng-A', intervalLabel: '15m', prompt: 'poll the deploy', runs: 7, createdAt: 1000, persistent: false },
    ]);
  });

  it('carries the persistent flag through, so the pane can say WHY a recall was expected', () => {
    const [out] = toNeedsAttentionLoops([
      { sessionId: 'eng-B', intervalMs: 60_000, prompt: 'x', runs: 1, createdAt: 1, persistent: true },
    ]);
    expect(out.persistent).toBe(true);
  });

  it('an empty list yields an empty list', () => {
    expect(toNeedsAttentionLoops([])).toEqual([]);
  });
});
