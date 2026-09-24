// browserReveal.test.ts — the reveal POLICY (src/browserReveal.ts, t-qcwpyy).
//
// The rule these guard is the ticket's first acceptance item, in its smallest
// form: under the default, a page id may be revealed ONCE. Everything about
// "the second verb must not move the tab" reduces to allowReveal('first', true)
// being false, so that is asserted directly here and end-to-end through
// lookupPage in browserPage.test.ts.
//
// The enum is not invented: the three values are the ones contributed in
// package.json, and the test below reads that manifest rather than restating it,
// so a setting renamed in one place and not the other goes red.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { fake } = vi.hoisted(() => ({ fake: { settings: {} as Record<string, unknown>, throws: false } }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => {
      if (fake.throws) throw new Error('no configuration service');
      return { get: (key: string) => fake.settings[key] };
    },
  },
}));

import {
  DEFAULT_REVEAL,
  REVEAL_POLICIES,
  REVEAL_SETTING,
  allowReveal,
  markRevealed,
  mayReveal,
  readRevealPolicy,
  resetRevealedPages,
  toRevealPolicy,
  wasRevealed,
} from '../../../src/browserReveal';

beforeEach(() => {
  fake.settings = {};
  fake.throws = false;
  resetRevealedPages();
});

describe('allowReveal — the decision, pure', () => {
  it('"first" allows the first reveal of a page and refuses every one after it', () => {
    expect(allowReveal('first', false)).toBe(true);
    expect(allowReveal('first', true)).toBe(false);
  });

  it('"never" refuses even the first', () => {
    expect(allowReveal('never', false)).toBe(false);
  });

  it('"always" is the old behaviour — a hidden page is revealed however often', () => {
    expect(allowReveal('always', true)).toBe(true);
  });
});

describe('toRevealPolicy — a settings value is never trusted raw', () => {
  it('keeps the three contributed values', () => {
    for (const policy of REVEAL_POLICIES) expect(toRevealPolicy(policy)).toBe(policy);
  });

  it('falls back to the default for junk, so a hand-edited file cannot break a verb', () => {
    expect(toRevealPolicy('sometimes')).toBe(DEFAULT_REVEAL);
    expect(toRevealPolicy(undefined)).toBe(DEFAULT_REVEAL);
    expect(toRevealPolicy(null)).toBe(DEFAULT_REVEAL);
    expect(toRevealPolicy(1)).toBe(DEFAULT_REVEAL);
  });
});

describe('readRevealPolicy', () => {
  it('is "first" when nothing is set — the quiet default', () => {
    expect(readRevealPolicy()).toBe('first');
  });

  it('reads the contributed key, live', () => {
    fake.settings[REVEAL_SETTING] = 'always';
    expect(readRevealPolicy()).toBe('always');
  });

  it('a configuration read that THROWS is the default, not a failed verb', () => {
    fake.throws = true;
    expect(readRevealPolicy()).toBe(DEFAULT_REVEAL);
  });
});

describe('the session set', () => {
  it('mayReveal goes false for a page once it has been revealed', () => {
    expect(mayReveal('page-1')).toBe(true);
    markRevealed('page-1');
    expect(wasRevealed('page-1')).toBe(true);
    expect(mayReveal('page-1')).toBe(false);
    // Per PAGE, not global: a second page still gets its one reveal.
    expect(mayReveal('page-2')).toBe(true);
  });

  it('"always" ignores the set entirely', () => {
    markRevealed('page-1');
    fake.settings[REVEAL_SETTING] = 'always';
    expect(mayReveal('page-1')).toBe(true);
  });

  it('"never" refuses a page that was never revealed', () => {
    fake.settings[REVEAL_SETTING] = 'never';
    expect(mayReveal('fresh')).toBe(false);
  });
});

describe('the contributed setting', () => {
  it('package.json contributes exactly these three values, with "first" as the default', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> } } };
    const prop = manifest.contributes.configuration.properties[REVEAL_SETTING];
    expect(prop, `${REVEAL_SETTING} is not contributed, so it would never persist`).toBeDefined();
    expect(prop.enum).toEqual([...REVEAL_POLICIES]);
    expect(prop.default).toBe(DEFAULT_REVEAL);
  });
});
