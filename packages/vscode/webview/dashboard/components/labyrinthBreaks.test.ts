// WHERE the run changed hands, as opposed to how many times it did.
//
// LabyrinthSpendModels.svelte already counts the switches. The failure this
// file exists to catch is the map claiming a switch the run never made, which
// is worse than showing none: a divider labelled `grok-4.5` across a lane is
// read as "everything past here was that model's work", and there is nothing
// on screen to check it against.
//
// Two rules produce every false break, and both have a test here:
//   1. a DELEGATED child's steps are inlined straight after the spawn that made
//      them, and a sub-agent commonly runs on a different model — walking every
//      step reports a switch into the child and another back out of it,
//   2. an older payload carries no `model` at all, and reading absent as a
//      model of its own reports a switch into and back out of "unknown".

import { describe, it, expect } from 'vitest';
import { modelBreaks, shortModel, type BreakStep } from './labyrinthBreaks';

const step = (ordinal: number, over: Partial<BreakStep> = {}): BreakStep =>
  ({ ordinal, kind: 'reply', ...over }) as BreakStep;

const GPT = 'openai/gpt-5.6-sol';
const GROK = 'xai/grok-4.5';

describe('modelBreaks — a break is drawn only where the run really changed model', () => {
  it('a run that never changed model has NO break', () => {
    expect(modelBreaks([step(0, { model: GPT }), step(1, { model: GPT }), step(2, { model: GPT })])).toEqual([]);
  });

  it('one break per change, at the FIRST step on the new model, naming both sides', () => {
    const breaks = modelBreaks([
      step(0, { model: GPT }), step(1, { model: GPT }),
      step(2, { model: GROK }), step(3, { model: GROK }),
      step(4, { model: GPT }),
    ]);
    expect(breaks.map((b) => [b.index, b.from, b.to])).toEqual([
      [2, GPT, GROK],
      [4, GROK, GPT],
    ]);
    expect(breaks.map((b) => b.ordinal)).toEqual([2, 4]);
  });

  it('the label is the incoming model SHORT — the divider has one lane to fit in', () => {
    expect(modelBreaks([step(0, { model: GPT }), step(1, { model: GROK })])[0]!.label).toBe('grok-4.5');
    expect(shortModel(GPT)).toBe('gpt-5.6-sol');
    // No provider prefix to strip: the id is already its own label.
    expect(shortModel('qwen3-30b')).toBe('qwen3-30b');
  });

  it('an OLD payload that recorded no model at all produces no break', () => {
    expect(modelBreaks([step(0), step(1), step(2)])).toEqual([]);
  });

  it('a step with no model is SKIPPED, not read as a model of its own', () => {
    // RED with the naive rule: it reports GPT -> unknown at 1 and back at 2.
    expect(modelBreaks([step(0, { model: GPT }), step(1), step(2, { model: GPT })])).toEqual([]);
  });

  it('a model that appears only after some unrecorded steps still breaks once', () => {
    const breaks = modelBreaks([step(0, { model: GPT }), step(1), step(2, { model: GROK })]);
    expect(breaks.map((b) => [b.index, b.from, b.to])).toEqual([[2, GPT, GROK]]);
  });

  it('a DELEGATED child on another model is NOT a break in the run that spawned it', () => {
    // RED with the naive rule: two breaks, one into the child and one back out.
    // `run_steps` inlines a child's steps directly after its spawn, so this is
    // the shape of every run that delegated anything at all.
    expect(modelBreaks([
      step(0, { model: GPT }),
      step(1, { kind: 'subagent', tool: 'task', model: GPT } as Partial<BreakStep>),
      step(2, { depth: 1, parentOrdinal: 1, model: GROK } as Partial<BreakStep>),
      step(3, { depth: 1, parentOrdinal: 1, model: GROK } as Partial<BreakStep>),
      step(4, { model: GPT }),
    ])).toEqual([]);
  });

  it('...but a change on the TRUNK either side of a delegation still breaks once', () => {
    const breaks = modelBreaks([
      step(0, { model: GPT }),
      step(1, { kind: 'subagent', tool: 'task', model: GPT } as Partial<BreakStep>),
      step(2, { depth: 1, parentOrdinal: 1, model: GPT } as Partial<BreakStep>),
      step(3, { model: GROK }),
    ]);
    expect(breaks.map((b) => [b.index, b.from, b.to])).toEqual([[3, GPT, GROK]]);
  });

  it('an empty run has no breaks and does not throw', () => {
    expect(modelBreaks([])).toEqual([]);
  });
});
