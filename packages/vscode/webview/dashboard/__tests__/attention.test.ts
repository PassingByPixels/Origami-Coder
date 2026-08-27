// Agent Manager S7 — the pure "needs you" decision leaves (attention.ts). A
// background agent that asks a QUESTION with no view mounted must be flagged on the
// board + status bar; a MOUNTED agent's permission ask must forward instead of
// auto-answering. Testing these pure keeps the DashboardPanel wiring thin over an
// asserted core (mirrors how permScope/agentPermissions test the decision, not the
// panel). The mounted-vs-unmounted permission COMPOSITION is modelled at the bottom.

import { describe, it, expect } from 'vitest';
import {
  isSessionMounted,
  questionPreview,
  boardAggregate,
  aggregateText,
  resolvePermission,
  drainPermissions,
} from '../../../src/dashboard/agentManager/attention';

describe('isSessionMounted', () => {
  const solo = new Set<string>(['s-solo']);
  it('is TRUE when the main panel is showing the session', () => {
    expect(isSessionMounted('s-active', 's-active', new Set())).toBe(true);
  });
  it('is TRUE when a solo editor tab exists for it', () => {
    expect(isSessionMounted('s-solo', null, solo)).toBe(true);
    expect(isSessionMounted('s-solo', 's-other', solo)).toBe(true);
  });
  it('is FALSE when neither the active session nor a solo tab matches', () => {
    expect(isSessionMounted('s-agent', 's-other', solo)).toBe(false);
    expect(isSessionMounted('s-agent', null, new Set())).toBe(false);
  });
  it('is TRUE for ANY session when the sidebar is in grid layout (every session tiled)', () => {
    // The grid renders every known session as a visible cell, so a background agent's
    // ask is on-screen even though it is neither the active cell nor a solo tab.
    expect(isSessionMounted('s-agent', 's-other', new Set(), true)).toBe(true);
    expect(isSessionMounted('s-agent', null, new Set(), false)).toBe(false);
  });
  it('accepts a Map (the real sessionPanels) as the solo source', () => {
    const panels = new Map<string, object>([['s-tab', {}]]);
    expect(isSessionMounted('s-tab', null, panels)).toBe(true);
    expect(isSessionMounted('s-none', null, panels)).toBe(false);
  });
});

describe('questionPreview', () => {
  it('collapses whitespace and returns short questions whole', () => {
    expect(questionPreview('  Which\n  branch?  ')).toBe('Which branch?');
  });
  it('clips over-long questions to <= max with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const p = questionPreview(long, 80);
    expect(p.length).toBe(80);
    expect(p.endsWith('…')).toBe(true);
  });
  it('never throws on empty / whitespace', () => {
    expect(questionPreview('')).toBe('');
    expect(questionPreview('   ')).toBe('');
  });
});

describe('boardAggregate', () => {
  const rows = (states: string[], needsAt: number[] = []) =>
    states.map((state, i) => ({ state, needsYou: needsAt.includes(i) ? { kind: 'question', preview: 'q' } : null }));
  it('counts provisioning + working as running, and needsYou rows as needYou', () => {
    const repos = [
      { rows: rows(['working', 'provisioning', 'idle'], [0]) },
      { rows: rows(['working', 'error'], [0]) },
    ];
    expect(boardAggregate(repos)).toEqual({ running: 3, needYou: 2 });
  });
  it('is {0,0} for an empty / undefined board', () => {
    expect(boardAggregate([])).toEqual({ running: 0, needYou: 0 });
    expect(boardAggregate(undefined)).toEqual({ running: 0, needYou: 0 });
    expect(boardAggregate([{ rows: rows(['idle', 'queued', 'detached']) }])).toEqual({ running: 0, needYou: 0 });
  });
});

describe('aggregateText — status-bar label derivation', () => {
  it('HIDES (null) when there is no live work', () => {
    expect(aggregateText({ running: 0, needYou: 0 })).toBeNull();
  });
  it('shows only the running half when nothing needs you', () => {
    expect(aggregateText({ running: 3, needYou: 0 })).toBe('Agents: 3 running');
  });
  it('appends the need-you half when M > 0', () => {
    expect(aggregateText({ running: 2, needYou: 1 })).toBe('Agents: 2 running · 1 need you');
  });
});

// The mounted-permission seam (DashboardPanel onPermissionRequest) is EXACTLY
// resolvePermission — imported here, not re-implemented — so inverting the branch, or
// running the auto path while a view is up, breaks this test and production together.
describe('resolvePermission — the onPermissionRequest composition (real production fn)', () => {
  it('FORWARDS when mounted and NEVER runs the auto decision (a visible ask must not be auto-answered)', () => {
    let autoRan = false;
    const d = resolvePermission(isSessionMounted('s', 's', new Set()), () => { autoRan = true; return { action: 'auto-allow' as const }; });
    expect(d).toEqual({ action: 'forward' });
    expect(autoRan).toBe(false); // the safety property: a mounted view is asked, not silently decided
  });
  it('runs the S6e auto decision (once) and returns it verbatim when unmounted', () => {
    let calls = 0;
    const d = resolvePermission(isSessionMounted('s', 'other', new Set()), () => { calls++; return { action: 'auto-allow' as const, optionId: 'allow-1' }; });
    expect(calls).toBe(1);
    expect(d).toEqual({ action: 'auto-allow', optionId: 'allow-1' });
  });
  it('forwards a grid-visible session so its ask is not auto-answered', () => {
    let autoRan = false;
    const d = resolvePermission(isSessionMounted('s-bg', 's-other', new Set(), true), () => { autoRan = true; return { action: 'auto-allow' as const }; });
    expect(d).toEqual({ action: 'forward' });
    expect(autoRan).toBe(false);
  });
});

describe('drainPermissions — cancel every pending ask so an agent never hangs', () => {
  it('resolves each pending respond with null (deny) and empties the map', () => {
    const answered: Array<string | null> = [];
    const pending = new Map<string, (o: string | null) => void>([
      ['tc-1', (o) => answered.push(o)],
      ['tc-2', (o) => answered.push(o)],
    ]);
    drainPermissions(pending);
    expect(answered).toEqual([null, null]); // both asks cancelled, none left hanging
    expect(pending.size).toBe(0);
  });
  it('is a no-op on an empty map', () => {
    const pending = new Map<string, (o: string | null) => void>();
    expect(() => drainPermissions(pending)).not.toThrow();
    expect(pending.size).toBe(0);
  });
});
