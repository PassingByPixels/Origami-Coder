// The chip-to-map binding, with no DOM in the way.
//
// jsdom has no layout and no computed opacity, so the render tests can only
// assert which markers carry the class. THIS file is where the rule itself is
// checked: which steps a chip is about, and — the part that actually misleads
// — when the honest answer is to fade nothing at all.

import { describe, it, expect } from 'vitest';
import { mapFade, type HighlightStep, type HighlightTarget } from './labyrinthHighlight';

const step = (ordinal: number, over: Partial<HighlightStep> = {}): HighlightStep =>
  ({ ordinal, kind: 'reply', ...over }) as HighlightStep;

/** A `build` trunk that delegates one stretch to `general`. */
const RUN: HighlightStep[] = [
  step(0, { kind: 'prompt', agent: 'build' }),
  step(1, { kind: 'subagent', agent: 'build' } as Partial<HighlightStep>),
  step(2, { depth: 1, parentOrdinal: 1, agent: 'general' } as Partial<HighlightStep>),
  step(3, { depth: 1, parentOrdinal: 1, agent: 'general' } as Partial<HighlightStep>),
  step(4, { agent: 'build' }),
];
const faded = (t: HighlightTarget | null, run: HighlightStep[] = RUN) =>
  [...mapFade(run, t).steps].sort((a, b) => a - b);
const rails = (t: HighlightTarget | null, run: HighlightStep[] = RUN) =>
  [...mapFade(run, t).branches].sort((a, b) => a - b);

describe('mapFade — what fades when a spend chip is hovered', () => {
  it('nothing hovered fades nothing', () => {
    expect(faded(null)).toEqual([]);
  });

  it('a BRANCH keeps its own steps and its spawn, and fades the trunk either side', () => {
    expect(faded({ kind: 'branch', first: 1 })).toEqual([0, 4]);
  });

  it('an AGENT keeps only the steps that agent took', () => {
    expect(faded({ kind: 'agent', agent: 'general' })).toEqual([0, 1, 4]);
    expect(faded({ kind: 'agent', agent: 'build' })).toEqual([2, 3]);
  });

  it('a step with no agent is in the `unknown` bucket, exactly as the totals are', () => {
    const mixed = [step(0), step(1, { agent: 'build' })];
    expect(faded({ kind: 'agent', agent: 'unknown' }, mixed)).toEqual([1]);
  });

  it('an agent that ran the WHOLE run fades nothing — a total highlight says nothing', () => {
    const solo = [step(0, { agent: 'build' }), step(1, { agent: 'build' })];
    expect(faded({ kind: 'agent', agent: 'build' }, solo)).toEqual([]);
  });

  it('a target NO step matches fades nothing, rather than fading the whole map', () => {
    // A chip whose branch the thresholds filter took off the map: fading every
    // marker would read as "this run did none of that work".
    expect(faded({ kind: 'agent', agent: 'nobody' })).toEqual([]);
    expect(faded({ kind: 'branch', first: 99 })).toEqual([]);
  });

  it('an empty run fades nothing and does not throw', () => {
    expect(faded({ kind: 'branch', first: 0 }, [])).toEqual([]);
  });

  // THE RAIL RULE. A `task` call is the step of the thread that MADE it, so
  // `build` hovering keeps the spawn lit — and a rail keyed on that spawn would
  // stay bright around a branch whose every step had just faded.
  it('a branch RAIL fades with the work on it, not with its spawn', () => {
    expect(rails({ kind: 'agent', agent: 'build' })).toEqual([1]);
    expect(rails({ kind: 'agent', agent: 'general' })).toEqual([]);
    expect(rails({ kind: 'branch', first: 1 })).toEqual([]);
  });

  it('no rail fades when nothing fades', () => {
    expect(rails(null)).toEqual([]);
    expect(rails({ kind: 'agent', agent: 'nobody' })).toEqual([]);
  });
});
