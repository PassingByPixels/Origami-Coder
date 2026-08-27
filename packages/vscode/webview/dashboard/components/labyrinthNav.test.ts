// The rules that decide WHICH run gets opened, and how the reader gets back.
//
// The failure the cwd half exists to catch is the quietest one on this pane: a
// run asked for without its directory comes back EMPTY, and an empty run looks
// exactly like a run that recorded nothing. There is no error to see.

import { describe, it, expect } from 'vitest';
import { runCwd, stepsRequest, wantsBack } from './labyrinthNav';

const RUNS = [
  { sessionId: 'ses_a', title: 'A', folder: 'proj', cwd: 'C:/x', updatedAt: '2026-07-27T14:05:00.000Z' },
  { sessionId: 'ses_m', title: 'M', folder: 'proj', cwd: 'C:/y', updatedAt: '2026-07-27T14:05:00.000Z', collabId: 'flock1', agentSlug: 'build' },
];

describe('runCwd — the directory a run is resolved against', () => {
  it('is the listed run\'s own, not its folder basename', () => {
    expect(runCwd(RUNS, 'ses_a')).toBe('C:/x');
  });

  it('for a COLLAB header comes from its members, which are the rows that carry one', () => {
    expect(runCwd(RUNS, 'collab:flock1')).toBe('C:/y');
  });

  it('is EMPTY for a run the index does not list, rather than a neighbour\'s', () => {
    // A borrowed directory would resolve the id somewhere real and answer with
    // the wrong run, which is worse than answering with nothing.
    expect(runCwd(RUNS, 'ses_unknown')).toBe('');
    expect(runCwd([], 'ses_a')).toBe('');
  });
});

describe('stepsRequest — which wire a run is asked for on', () => {
  it('an ordinary run goes to requestRunSteps, carrying its directory', () => {
    expect(stepsRequest('ses_a', 'C:/x')).toEqual({ type: 'requestRunSteps', sessionId: 'ses_a', cwd: 'C:/x' });
  });

  it('a collab header goes to requestCollabSteps, by collab id', () => {
    expect(stepsRequest('collab:flock1', 'C:/y')).toEqual({ type: 'requestCollabSteps', collabId: 'flock1', cwd: 'C:/y' });
  });
});

describe('wantsBack — when Escape means "out of this click-through"', () => {
  const el = (html: string): Element => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it('yes on Escape, inside a click-through, from ordinary chrome', () => {
    expect(wantsBack(el('<button>x</button>'), 'Escape', 1)).toBe(true);
  });

  it('no at depth 0 — there is no run to go back to', () => {
    expect(wantsBack(el('<button>x</button>'), 'Escape', 0)).toBe(false);
  });

  it('no for any other key', () => {
    expect(wantsBack(el('<button>x</button>'), 'Enter', 2)).toBe(false);
    expect(wantsBack(el('<button>x</button>'), 'Backspace', 2)).toBe(false);
  });

  it('no while a FIELD has the key — Escape there is about the field', () => {
    // The price panel is a grid of inputs sitting over this very pane.
    expect(wantsBack(el('<input />'), 'Escape', 1)).toBe(false);
    expect(wantsBack(el('<textarea></textarea>'), 'Escape', 1)).toBe(false);
    expect(wantsBack(el('<select></select>'), 'Escape', 1)).toBe(false);
    expect(wantsBack(el('<div contenteditable="true"></div>'), 'Escape', 1)).toBe(false);
    // ...including a field the press only bubbled out of.
    expect(wantsBack(el('<label><input /></label>').querySelector('input'), 'Escape', 1)).toBe(false);
  });

  it('survives a target that is not an element at all', () => {
    expect(wantsBack(null, 'Escape', 1)).toBe(true);
    expect(wantsBack(window, 'Escape', 1)).toBe(true);
  });
});
