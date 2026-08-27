// collabPersonaSeed — the default persona a NEW bot's body arrives pre-filled
// with. Pure, so what matters is assertable with no DOM.
//
// W9 REPLACED THE TWO SEEDS WITH ONE. There used to be a worker text and an
// observer text, chosen by whichever preset button was lit; the buttons went
// (a new bot is born ticked on every tool), so there is no preset left for a
// seed to follow and the only input is the name box. What the seed says changed
// with it — see personaDefaults.test.ts, which holds this text to the SAME rules
// as the engine's scaffold and the two shipped seeds, because all three are text
// this build puts in front of a stranger's model without being asked.
//
// What is tested HERE is what only this module owns: the name it addresses, and
// that the body is a role card rather than generic filler.

import { describe, it, expect } from 'vitest';
import { personaSeed, seedName } from '../components/collabPersonaSeed';

describe('seedName — an agent is addressed by its name, not its filing prefix', () => {
  it('drops the collab- prefix and capitalises what is left', () => {
    expect(seedName('collab-crane')).toBe('Crane');
    expect(seedName('collab-heron')).toBe('Heron');
  });

  it('handles a slug that never carried the prefix', () => {
    expect(seedName('scribe')).toBe('Scribe');
  });

  it('drops only a LEADING prefix — the word is not scrubbed out of the middle', () => {
    expect(seedName('collab-precollab-thing')).toBe('Precollab-thing');
  });

  it('falls back to a placeholder rather than addressing nobody', () => {
    // The form opens with the slug box holding the bare 'collab-' stub, and a
    // seed reading "You are , a builder" is worse than no seed at all.
    expect(seedName('collab-')).toBe('Agent');
    expect(seedName('')).toBe('Agent');
    expect(seedName('   ')).toBe('Agent');
  });
});

describe('personaSeed — one seed, addressed to the bot being made', () => {
  it('opens as a BOT IDENTITY carrying the typed name', () => {
    expect(personaSeed('collab-crane')).toContain('You are the bot Crane.');
    // Live, on every keystroke: the box follows the name box while untouched,
    // so a seed that lagged by one character would be visible and wrong.
    expect(personaSeed('collab-scribe')).toContain('You are the bot Scribe.');
    expect(personaSeed('collab-scrib')).toContain('You are the bot Scrib.');
    // ...and the bare stub still addresses somebody rather than nobody.
    expect(personaSeed('collab-')).toContain('You are the bot Agent.');
  });

  // The failure this file was written against, unchanged by W9: a seed that
  // reads as generic filler is WORSE than the empty box it replaced, because
  // the user keeps it believing it said something. Each clause below is a habit
  // the owner named, and each one is the difference between a role card and
  // pleasant noise.
  it('is a role card with real instructions in it, not filler', () => {
    const text = personaSeed('collab-crane');
    expect(text).toContain('Read before you write');
    expect(text).toContain('full path');
    expect(text).toMatch(/small, surgical changes/);
    expect(text).toContain('Prove what you claim');
    expect(text).toMatch(/never call something done that you have not seen work/i);
    expect(text).toContain('Do not guess quietly');
  });

  // NO ROOM LANGUAGE. The same def runs alone, in a room and as a sub-agent, and
  // the room's rules are injected by the runner at turn time — so this text was
  // wrong two times in three while it named the room. It no longer even POINTS
  // at the room manual: a solo bot has no manual to be pointed at.
  it('says nothing about rooms, collabs or the protocol', () => {
    const text = personaSeed('collab-crane');
    for (const word of [/\bcollab\b/i, /\broom\b/i, /shared stream/i, /@mention/i, /task board/i]) {
      expect(text, `still says ${word}`).not.toMatch(word);
    }
  });

  // It composes ON TOP of the base agent prompt, which already says what this
  // thing is. Restating it spends context and contradicts it on disagreement.
  it('does not re-declare being a coding assistant', () => {
    expect(personaSeed('collab-crane')).not.toMatch(/interactive CLI tool|you are origami/i);
  });

  it('names no file that only exists in one workspace', () => {
    // It ships to strangers; their repo is not ours.
    expect(personaSeed('collab-crane')).not.toMatch(/AGENTS\.md|HANDOFF\.md|CLAUDE\.md|\.origami\//);
    // ...so the notes habit is stated as a CONDITION, never as an order.
    expect(personaSeed('collab-crane')).toContain('If this workspace keeps its own notes');
  });
});
