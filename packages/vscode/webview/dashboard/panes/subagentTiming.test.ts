// subagentTiming — WHICH clock a sub-agent row is aged from.
//
// The owner's defect in one sentence: after a reload every row read "0s". The
// drawer aged from the card's own build stamp, and a reopened chat rebuilds
// every card from the engine's `session/load` replay — so the whole roster was
// stamped with the instant of the reload and `now - stamp` was milliseconds.
//
// These assert the RULE, not the formula: which source wins, what a missing
// source prints, and that a finished run stops moving. The end-to-end proof
// that the source actually survives a reload lives in reloadReplay.test.ts,
// which drives the real log + restore path.

import { describe, expect, it } from 'vitest';
import { subagentElapsed } from './subagentTiming';
import { elapsedText } from './subagentFormat';

const START = 1_700_000_000_000;
const END = START + 5_400_000; // 1h 30m
const RELOADED_AT = START + 9_000_000;

describe('subagentElapsed — a settled run reports its TOTAL', () => {
  it('is end-minus-start, not now-minus-start', () => {
    expect(subagentElapsed({ taskStartedAt: START, taskEndedAt: END }, RELOADED_AT)).toBe(END - START);
  });

  it('does not move when the clock does', () => {
    // Live, the drawer's 1s tick runs for as long as ANY agent is out. A
    // finished row that aged off that tick reported a total that kept growing
    // while a sibling worked — wrong in the live chat as well as after a reload.
    const at = (now: number) => subagentElapsed({ taskStartedAt: START, taskEndedAt: END }, now);
    expect(at(END + 1000)).toBe(at(END + 3_600_000));
  });

  it('never reports a negative run when the two stamps disagree', () => {
    // Start and end come from different engine surfaces (the stored tool state
    // and the injected completion), so a skew between them is possible.
    expect(subagentElapsed({ taskStartedAt: END, taskEndedAt: START }, RELOADED_AT)).toBe(0);
  });
});

describe('subagentElapsed — a child still out ages from its REAL start', () => {
  it('ticks from the engine stamp, not from when the card was rebuilt', () => {
    // The reload case: `timestamp` IS the reload instant, and preferring it is
    // exactly the defect. 2h30m out, not "0s".
    const row = { taskStartedAt: START, timestamp: RELOADED_AT };
    expect(subagentElapsed(row, RELOADED_AT)).toBe(RELOADED_AT - START);
    expect(elapsedText(subagentElapsed(row, RELOADED_AT))).toBe('2h 30m');
  });

  it('clamps a backwards clock rather than printing a negative age', () => {
    expect(subagentElapsed({ taskStartedAt: START }, START - 5000)).toBe(0);
  });
});

describe('subagentElapsed — what happens with no engine stamp at all', () => {
  it('falls back to the card build time, which keeps the LIVE path working', () => {
    // Against an engine older than the riders there is nothing better; live
    // that stamp is right, because the card is built as the agent is spawned.
    expect(subagentElapsed({ timestamp: START }, START + 5000)).toBe(5000);
  });

  it('an unknown start is 0 — which the drawer prints as NOTHING', () => {
    // subagentFormat's own rule: "0s" reads as "it just started", which is the
    // most convincing possible way to be wrong about an agent out for an hour.
    expect(subagentElapsed({}, RELOADED_AT)).toBe(0);
    expect(elapsedText(subagentElapsed({}, RELOADED_AT))).toBe('');
  });

  it('refuses junk stamps rather than printing 1970', () => {
    expect(subagentElapsed({ taskStartedAt: 0, timestamp: 0 }, RELOADED_AT)).toBe(0);
    expect(subagentElapsed({ taskStartedAt: Number.NaN, timestamp: START }, START + 1000)).toBe(1000);
  });

  it('an end with no start cannot fabricate a total', () => {
    // Half a span is not a span. It falls through to the age, which at least
    // has an honest source.
    expect(subagentElapsed({ taskEndedAt: END, timestamp: START }, START + 7000)).toBe(7000);
  });
});
