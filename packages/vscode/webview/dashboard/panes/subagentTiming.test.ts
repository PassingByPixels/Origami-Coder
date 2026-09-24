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
    expect(subagentElapsed({ taskStartedAt: START, taskEndedAt: END }, RELOADED_AT, true)).toBe(END - START);
  });

  it('does not move when the clock does', () => {
    // Live, the drawer's 1s tick runs for as long as ANY agent is out. A
    // finished row that aged off that tick reported a total that kept growing
    // while a sibling worked — wrong in the live chat as well as after a reload.
    const at = (now: number) => subagentElapsed({ taskStartedAt: START, taskEndedAt: END }, now, true);
    expect(at(END + 1000)).toBe(at(END + 3_600_000));
  });

  it('never reports a negative run when the two stamps disagree', () => {
    // Start and end come from different engine surfaces (the stored tool state
    // and the injected completion), so a skew between them is possible.
    expect(subagentElapsed({ taskStartedAt: END, taskEndedAt: START }, RELOADED_AT, true)).toBe(0);
  });
});

describe('subagentElapsed — a child still out ages from its REAL start', () => {
  it('ticks from the engine stamp, not from when the card was rebuilt', () => {
    // The reload case: `timestamp` IS the reload instant, and preferring it is
    // exactly the defect. 2h30m out, not "0s".
    const row = { taskStartedAt: START, timestamp: RELOADED_AT };
    expect(subagentElapsed(row, RELOADED_AT, false)).toBe(RELOADED_AT - START);
    expect(elapsedText(subagentElapsed(row, RELOADED_AT, false))).toBe('2h 30m');
  });

  it('clamps a backwards clock rather than printing a negative age', () => {
    expect(subagentElapsed({ taskStartedAt: START }, START - 5000, false)).toBe(0);
  });
});

describe('subagentElapsed — what happens with no engine stamp at all', () => {
  it('falls back to the card build time, which keeps the LIVE path working', () => {
    // Against an engine older than the riders there is nothing better; live
    // that stamp is right, because the card is built as the agent is spawned.
    expect(subagentElapsed({ timestamp: START }, START + 5000, false)).toBe(5000);
  });

  it('an unknown start is 0 — which the drawer prints as NOTHING', () => {
    // subagentFormat's own rule: "0s" reads as "it just started", which is the
    // most convincing possible way to be wrong about an agent out for an hour.
    expect(subagentElapsed({}, RELOADED_AT, false)).toBe(0);
    expect(elapsedText(subagentElapsed({}, RELOADED_AT, false))).toBe('');
  });

  it('refuses junk stamps rather than printing 1970', () => {
    expect(subagentElapsed({ taskStartedAt: 0, timestamp: 0 }, RELOADED_AT, false)).toBe(0);
    expect(subagentElapsed({ taskStartedAt: Number.NaN, timestamp: START }, START + 1000, false)).toBe(1000);
  });

  it('an end with no start cannot fabricate a total', () => {
    // Half a span is not a span. It falls through to the age, which at least
    // has an honest source.
    expect(subagentElapsed({ taskEndedAt: END, timestamp: START }, START + 7000, false)).toBe(7000);
  });
});

// t-d93fjo — the owner's screenshot: a drawer header reading "2 running · 5 done
// · 4 error" over rows saying "23h 47m" and "23h 24m", on agents that had
// finished within minutes a day earlier. Both rows had a START (the engine
// rides it) and no END: a detached child whose terminal marker carried no
// `time.created`, and a chat reopened after the finish happened off-window.
// `settled` is what closes that hole — the rule is not "do I have an end?" but
// "has this row stopped?".
describe('subagentElapsed — a STOPPED row never ages, end stamp or not', () => {
  // A fake clock, advanced by hand: the defect is only visible across time, and
  // a test that waits for real seconds is a test nobody runs.
  const clock = { now: END + 1000 };
  const tick = (ms: number) => (clock.now += ms);

  it('freezes a finished row that has NO end stamp, instead of counting on', () => {
    const settledNoEnd = { taskStartedAt: START };
    const first = subagentElapsed(settledNoEnd, clock.now, true);
    tick(86_400_000); // a day later, which is exactly when the screenshot was taken
    expect(subagentElapsed(settledNoEnd, clock.now, true)).toBe(first);
    // And it is UNKNOWN, not a number: printing `now - start` here is the
    // 23h 47m in the screenshot, and printing 0s would claim it never ran.
    expect(first).toBe(0);
    expect(elapsedText(first)).toBe('');
  });

  it('refuses the CARD BUILD stamp once the row has stopped', () => {
    // The hydration case. A reopened chat rebuilds every card with a fresh
    // `Date.now()`, so a finished row with no engine start would otherwise age
    // from the instant of the reload — a clock that starts at 0s and climbs for
    // as long as the window stays open.
    const hydrated = { timestamp: START };
    tick(3_600_000);
    expect(subagentElapsed(hydrated, clock.now, true)).toBe(0);
    tick(3_600_000);
    expect(subagentElapsed(hydrated, clock.now, true)).toBe(0);
    // The SAME row while still out keeps its live age — the fallback is gated,
    // not deleted, or a live drawer against an older engine goes blank.
    expect(subagentElapsed(hydrated, START + 9000, false)).toBe(9000);
  });

  it('still reports the real total when the engine DID ride both ends', () => {
    // The guard must not swallow the good case: `settled` decides whether to
    // fall back, never whether to use a span that is actually there.
    tick(50_000_000);
    expect(subagentElapsed({ taskStartedAt: START, taskEndedAt: END }, clock.now, true)).toBe(END - START);
    expect(elapsedText(END - START)).toBe('1h 30m');
  });
});
