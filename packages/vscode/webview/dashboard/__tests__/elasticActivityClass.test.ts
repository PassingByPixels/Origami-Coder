// t-w2qv3o — the pure activity classifier (src/elastic/activityClass.ts), driven by EVENT SEQUENCES
// over time the way the tracker feeds it. The bugs each block catches:
//
// - a hidden chat with a running turn, an open ask, running sub-agents or an armed /loop dropped to
//   `idle` (the engine would then take IDLE priority + EcoQoS and starve the work);
// - a chat on the phone treated as hidden (owner decision: a phone chat is active);
// - a running turn in a HIDDEN chat reported `active` (owner decision: it is background);
// - the idle clock not restarting after work or a host read, so a chat idles minutes too early.
import { describe, expect, it } from 'vitest';
import { QUIET, START, nextClass, type ClassState, type EngineSignals } from '../../../src/elastic/activityClass';

const MIN = 60_000;
const IDLE = 5 * MIN;

/** Feed a timeline of [time, signals] and return the class after each step. */
function run(steps: Array<[number, Partial<EngineSignals>]>): string[] {
  let st: ClassState = START;
  return steps.map(([t, s]) => {
    st = nextClass(st, { ...QUIET, ...s }, t, IDLE);
    return st.cls;
  });
}

describe('on screen or on the phone = active', () => {
  it('a visible chat is active whatever else is true, and a hidden one is not', () => {
    expect(run([[0, { onScreen: true }], [1, { onScreen: true, turnBusy: true }], [2, {}]])).toEqual(['active', 'active', 'background']);
  });
  it('a chat open on the phone stays active while hidden on the desk, for hours', () => {
    expect(run([[0, { phone: true }], [60 * MIN, { phone: true }], [600 * MIN, { phone: true }]])).toEqual(['active', 'active', 'active']);
  });
  it('a running turn in a HIDDEN chat is background, not active (owner decision)', () => {
    expect(run([[0, { turnBusy: true }]])).toEqual(['background']);
  });
});

describe('work never goes below background, however long it runs hidden', () => {
  const work: Array<[string, Partial<EngineSignals>]> = [
    ['a host-awaited turn', { turnBusy: true }],
    ['a turn the engine started itself (sessionStatus busy)', { engineBusy: true }],
    ['an open permission or question', { pendingAsk: true }],
    ['running background sub-agents', { runningChildren: true }],
    ['an armed /loop', { loopArmed: true }],
  ];
  for (const [name, s] of work) {
    it(name, () => {
      expect(run([[0, s], [IDLE, s], [10 * IDLE, s], [100 * IDLE, s]])).toEqual(['background', 'background', 'background', 'background']);
    });
  }
});

describe('idle = hidden, no work, quiet for the whole idle period', () => {
  it('goes idle exactly at the idle mark, not before', () => {
    expect(run([[0, {}], [IDLE - 1, {}], [IDLE, {}]])).toEqual(['background', 'background', 'idle']);
  });
  it('the clock starts when the work ENDS, not when the chat was hidden', () => {
    // Hidden at 0 with a turn running until minute 4, then quiet.
    expect(run([[0, { turnBusy: true }], [4 * MIN, {}], [4 * MIN + IDLE - 1, {}], [4 * MIN + IDLE, {}]]))
      .toEqual(['background', 'background', 'background', 'idle']);
  });
  it('an idle chat that starts work, or comes on screen, leaves idle at once and restarts the clock', () => {
    expect(run([[0, {}], [IDLE, {}], [IDLE + 1, { pendingAsk: true }], [IDLE + 2, {}], [2 * IDLE + 1, {}], [2 * IDLE + 2, {}]]))
      .toEqual(['background', 'idle', 'background', 'background', 'background', 'idle']);
    expect(run([[0, {}], [IDLE, {}], [IDLE + 1, { onScreen: true }], [IDLE + 2, {}]])).toEqual(['background', 'idle', 'active', 'background']);
  });
  it('a host read (lastActivityAt) restarts the quiet clock: an engine being read is not idle', () => {
    expect(run([[0, {}], [4 * MIN, { lastActivityAt: 4 * MIN }], [IDLE, { lastActivityAt: 4 * MIN }], [4 * MIN + IDLE, { lastActivityAt: 4 * MIN }]]))
      .toEqual(['background', 'background', 'background', 'idle']);
  });
});
