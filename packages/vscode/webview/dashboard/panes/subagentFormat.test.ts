// subagentFormat — how a sub-agent row prints.
//
// The age tests came with the formatter when it split out of subagentRows.ts;
// the activity ones are new with the live tail. Both are boundary tests: a
// formatter is only ever wrong at its edges (59s vs 1m, the line the tail cuts).

import { describe, expect, it } from 'vitest';
import { ACTIVITY_LINES, activityTail, elapsedText, rosterSummary } from './subagentFormat';

describe('subagentFormat — how an age reads', () => {
  it('prints nothing for an unknown age', () => {
    // "0s" on an agent that has been out a minute is worse than silence.
    expect(elapsedText(0)).toBe('');
    expect(elapsedText(-5)).toBe('');
  });

  it('seconds, then minutes, then hours', () => {
    expect(elapsedText(4_200)).toBe('4s');
    expect(elapsedText(59_999)).toBe('59s');
    expect(elapsedText(125_000)).toBe('2m 05s');
    expect(elapsedText(3_600_000)).toBe('1h 00m');
    expect(elapsedText(4_320_000)).toBe('1h 12m');
  });
});

describe('subagentFormat — the live activity tail', () => {
  it('nothing at all for a child that has streamed nothing', () => {
    expect(activityTail(undefined)).toBe('');
    expect(activityTail('')).toBe('');
    expect(activityTail('\n\n  \n')).toBe('');
  });

  it('keeps the LAST lines, oldest first — the row must track what it does NOW', () => {
    const stream = Array.from({ length: 12 }, (_, i) => `> read: file-${i}.ts`).join('\n');
    expect(activityTail(stream)).toBe('> read: file-9.ts\n> read: file-10.ts\n> read: file-11.ts');
  });

  it('never exceeds the line budget, however the stream is shaped', () => {
    // One unbroken 4KB paragraph is one line, and a fan-out of ten of those must
    // not push the roster off the panel — the cap is on LINES, so it holds.
    expect(activityTail('x'.repeat(4096)).split('\n')).toHaveLength(1);
    expect(activityTail('a\n\nb\n\nc\n\nd\n\ne').split('\n')).toHaveLength(ACTIVITY_LINES);
  });

  it('drops blank lines first, so a prose child still shows real content', () => {
    expect(activityTail('done thinking\n\n\n')).toBe('done thinking');
  });
});

describe('subagentFormat — the roster summary line', () => {
  const rows = (...states: string[]) => states.map((state) => ({ state }));

  it('always answers the running count, even at zero', () => {
    // The drawer exists to answer "is anything still out". A roster of one
    // refused spawn has to say zero out loud, not leave the number off.
    expect(rosterSummary([])).toBe('0 running');
    expect(rosterSummary(rows('failed'))).toBe('0 running · 1 failed');
  });

  it('names a refused spawn rather than folding it into the queued count', () => {
    // The old line printed `rows.length - running` as "queued", so a failed row
    // would have been reported as an agent waiting its turn.
    expect(rosterSummary(rows('running', 'queued', 'failed'))).toBe('1 running · 1 queued · 1 failed');
    expect(rosterSummary(rows('running', 'running', 'failed'))).toBe('2 running · 1 failed');
  });

  it('says nothing about a state with nobody in it', () => {
    expect(rosterSummary(rows('running', 'running'))).toBe('2 running');
    expect(rosterSummary(rows('queued'))).toBe('0 running · 1 queued');
  });
});
