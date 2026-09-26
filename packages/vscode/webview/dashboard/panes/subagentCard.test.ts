// subagentCard.test.ts — the one card both sub-agent views print (t-yyz57i).
import { describe, expect, it } from 'vitest';
import { cardJob, cardLine2, cardWho, hubLine, stateCounts, wirePath } from './subagentCard';
import { subagentLabel } from './subagentLabel';
import { row, tokens } from './subagentRowFixture';

describe('card line 1', () => {
  it('who + job rebuild the full label, so no surface loses a part', () => {
    const r = row({ agentType: 'explore', ordinal: 3, description: 'audit icons' });
    expect(cardWho(r)).toBe('explore · T3');
    expect(cardJob(r)).toBe('audit icons');
    expect(`${cardWho(r)} · ${cardJob(r)}`).toBe(subagentLabel(r));
  });

  it('no agent type prints the T-number alone; no description is no job, never the `task` header', () => {
    const r = row({ agentType: undefined, description: undefined, title: 'task' });
    expect(cardWho(r)).toBe('T1');
    expect(cardJob(r)).toBe('');
  });
});

describe('card line 2', () => {
  it('a running agent that printed something shows its LATEST line and its age', () => {
    expect(cardLine2(row({ activity: 'read a.ts\nedit b.ts\n', elapsedMs: 65_000 })))
      .toEqual({ kind: 'activity', text: 'edit b.ts', age: '1m 05s' });
  });

  it('a silent running agent shows totals, not an empty activity line', () => {
    expect(cardLine2(row({ activity: '', tokens: tokens() })).kind).toBe('totals');
  });

  it('a done agent shows totals even when it has activity left over', () => {
    const l = cardLine2(row({ state: 'done', settled: true, activity: 'last words', elapsedMs: 639_000, tokens: tokens() }));
    expect(l).toEqual({ kind: 'totals', tokens: '14.5k tokens', age: '10m 39s' });
  });

  it('a failed agent shows its reason, and a stated fallback when there is none', () => {
    expect(cardLine2(row({ state: 'error', settled: true, activity: 'Error: rate limited' })))
      .toEqual({ kind: 'reason', text: 'Error: rate limited' });
    expect(cardLine2(row({ state: 'failed', settled: true }))).toEqual({ kind: 'reason', text: 'failed to start' });
    expect(cardLine2(row({ state: 'error', settled: true }))).toEqual({ kind: 'reason', text: 'failed' });
  });
});

describe('header counts', () => {
  it('queued is not running; error and failed both count as failed', () => {
    const states = ['running', 'queued', 'done', 'done', 'error', 'failed'] as const;
    expect(stateCounts(states.map((state) => ({ state })))).toEqual({ running: 1, done: 2, failed: 2 });
  });
});

describe('map hub line', () => {
  it('sums tokens over the rows that rode them', () => {
    const rows = [row({ tokens: { input: 1000, output: 500 } }), row({ tokens: { input: 400_000, output: 1_000_000 } }), row()];
    expect(hubLine(rows)).toBe('This chat · 3 sub-agents · 1.4M tokens');
  });

  it('no token figure anywhere: no token part, and one agent is singular', () => {
    expect(hubLine([row()])).toBe('This chat · 1 sub-agent');
  });
});

describe('map wire', () => {
  it('is an S-curve that starts at the hub and ends at the card', () => {
    expect(wirePath(8, 50, 64, 10)).toBe('M 8 50 C 36 50, 36 10, 64 10');
  });
});
