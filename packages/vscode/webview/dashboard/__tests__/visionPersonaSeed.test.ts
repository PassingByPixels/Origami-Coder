// t-kgtr6c round 3 — the vision profile's SHIPPED DEFAULT PERSONA.
//
// The defect this guards: round 2 seeded a new vision profile out of
// collabPersonaSeed with `preset: 'observer'`, so every profile was born reading
// "You are Eye, a reviewer in this collab ... find what is wrong ... Attack
// proposals with concrete failure cases". A profile is shown one picture and
// asked one question; the seed told it to critique instead of to look, and a
// user who never opened the persona box would never know why the answers came
// back as opinions.
//
// So the assertions come in two halves, and BOTH are needed:
//  - the describe half, on the phrases that make a description usable to a model
//    that cannot see (verbatim text, counts, positions, and what is unreadable);
//  - the review half, which asserts the reviewer vocabulary is ABSENT. That is
//    only checkable because the seed states its prohibition in other words
//    ("report, not to judge"). If someone re-words it back to "do not review or
//    critique", this test goes red — deliberately: the negative guard is worth
//    more than that phrasing, and the seed is written to keep it possible.
//
// This does NOT assert the whole text. A test that pinned every sentence would
// fail on any edit, and the thing worth protecting is what the text MEANS.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visionPersonaSeed } from '../components/visionPersonaSeed';
import { personaSeed } from '../components/collabPersonaSeed';

const here = path.dirname(fileURLToPath(import.meta.url));
const seed = visionPersonaSeed('vision-eye');

describe('the vision profile seed describes, and does not review', () => {
  it('addresses the profile by name, without its filing prefix', () => {
    expect(seed.startsWith('You are Eye.')).toBe(true);
    expect(seed).not.toContain('vision-eye');
  });

  it('asks for the question answered FIRST, then the full contents', () => {
    // A model handed a picture and no instruction writes an essay; the caller
    // (tool/vision-request.ts) always sends a specific question and pays for it.
    expect(seed).toContain('Answer the question first');
    expect(seed).toContain('in full');
  });

  it('names the specifics a blind caller cannot ask for twice', () => {
    for (const phrase of ['layout', 'verbatim', 'colours', 'counts', 'in relation to']) {
      expect(seed, `the seed never mentions "${phrase}"`).toContain(phrase);
    }
  });

  it('requires the unreadable parts to be named rather than guessed', () => {
    // The one failure the asking model cannot detect: a confident guess reads
    // exactly like a good answer once it is only text.
    expect(seed).toContain('unreadable');
    expect(seed.toLowerCase()).toContain('confident guess');
  });

  it('carries NO review vocabulary — the round-2 defect, stated as an absence', () => {
    for (const word of ['review', 'reviewer', 'critique', 'suggest', 'improve']) {
      expect(seed.toLowerCase(), `the seed uses review language: "${word}"`).not.toContain(word);
    }
  });

  it('carries no collab vocabulary either — a profile is in no room', () => {
    for (const word of ['collab', 'room', 'protocol', 'task board', '@mention']) {
      expect(seed.toLowerCase(), `the seed talks about a collab: "${word}"`).not.toContain(word);
    }
  });

  it('is not either collab seed — the copy that caused this is impossible again', () => {
    expect(seed).not.toBe(personaSeed('observer', 'vision-eye'));
    expect(seed).not.toBe(personaSeed('worker', 'vision-eye'));
  });
});

// The seed text is worth nothing if the form does not reach for it. This is the
// one line that connects them, and without it every assertion above stays green
// while a new profile is still born a reviewer.
describe('the form seeds a PROFILE from this text and a collab agent from the other', () => {
  it('CollabAgentForm branches its reseed on kind', () => {
    const src = readFileSync(path.join(here, '..', 'components/CollabAgentForm.svelte'), 'utf8');
    expect(src).toContain("import { visionPersonaSeed } from './visionPersonaSeed'");
    expect(src).toMatch(/kind === 'vision'\s*\?\s*visionPersonaSeed\(draft\.slug\)/);
  });
});
