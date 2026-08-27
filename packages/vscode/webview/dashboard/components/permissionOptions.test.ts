// permissionOptions — the rules that decide whether the bar is asking for
// CONSENT or asking a QUESTION, and what a "just do it" click may grant.
//
// Both are safety rules. Getting the first wrong puts a bypass-everything
// button on a prompt the model meant as a question; getting the second wrong
// makes a yolo click grant a standing allow_always where pressing Approve
// would only have granted allow_once.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OTHER_OPTION_NAME, isQuestionShaped, otherOption, pickAllowOption } from './permissionOptions';

// The engine's real shapes: a consent ask carries the fixed triple; a question
// carries one option per choice and NO allow_always.
const CONSENT = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const QUESTION = [
  { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
  { optionId: 'b', name: 'Patch the caller', kind: 'allow_once' },
  { optionId: 'c', name: 'Cancel', kind: 'reject_once' },
];

describe('permissionOptions — question vs consent', () => {
  it('the fixed allow_always triple is a CONSENT ask', () => {
    expect(isQuestionShaped(CONSENT)).toBe(false);
  });

  it('an ask with no allow_always is a QUESTION', () => {
    expect(isQuestionShaped(QUESTION)).toBe(true);
  });

  it('a ONE-option question is still a question', () => {
    expect(isQuestionShaped([{ kind: 'allow_once' }])).toBe(true);
  });

  it('an empty option set is question-shaped — it cannot grant anything', () => {
    // Degenerate, but it must not fall to the consent branch and grow a yolo
    // button that has nothing to approve.
    expect(isQuestionShaped([])).toBe(true);
  });
});

describe('permissionOptions — which option a "just do it" click picks', () => {
  it('prefers allow_once over allow_always — never a wider grant than Approve', () => {
    // The whole safety property. allow_always persists a rule across restarts;
    // a button labelled "approve this" must not silently do that.
    expect(pickAllowOption(CONSENT)).toBe('once');
  });

  it('falls back to allow_always when there is no allow_once', () => {
    expect(pickAllowOption([
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ])).toBe('always');
  });

  it('takes any non-rejecting option when the engine offers an unfamiliar kind', () => {
    expect(pickAllowOption([
      { optionId: 'weird', name: 'Proceed', kind: 'proceed_something' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ])).toBe('weird');
  });

  it('returns null rather than picking a REJECTION as "allow"', () => {
    // The caller then leaves the ask alone. Answering a deny-only ask with its
    // deny option under a button the user pressed to say YES is the worst
    // available outcome.
    expect(pickAllowOption([
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
      { optionId: 'r2', name: 'Reject always', kind: 'reject_always' },
    ])).toBeNull();
    expect(pickAllowOption([])).toBeNull();
  });
});

describe('permissionOptions — the free-text "Other" option', () => {
  it('finds the engine\'s Other on a question', () => {
    const opts = [...QUESTION, { optionId: 'other', name: OTHER_OPTION_NAME, kind: 'allow_once' }];
    expect(otherOption(opts)!.optionId).toBe('other');
  });

  it('an engine that does not send it yields null — the bar is unchanged', () => {
    // The defensive requirement: no Other option, no text box, today's UI.
    expect(otherOption(QUESTION)).toBeNull();
  });

  it('IGNORES an option called Other on a real CONSENT ask', () => {
    // A tool-approval bar must not turn into a text box the user can type
    // consent into, whatever a tool happens to name its options.
    const opts = [...CONSENT, { optionId: 'other', name: 'Other', kind: 'allow_once' }];
    expect(otherOption(opts)).toBeNull();
  });

  it('tolerates the padding a wire round trip can add to the name', () => {
    const opts = [...QUESTION, { optionId: 'o', name: ' Other ', kind: 'allow_once' }];
    expect(otherOption(opts)!.optionId).toBe('o');
  });
});

describe('permissionOptions — the mirrors cannot drift from the host rules', () => {
  // These are COPIES of rules the extension host owns. tsconfig.webview.json
  // pins rootDir to `webview/`, so this module cannot import them — and a copy
  // with no guard silently stops matching the day the host's version changes.
  const hostSrc = (...rel: string[]) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', 'src', ...rel), 'utf8');

  it('the host still discriminates a question by the ABSENCE of allow_always', () => {
    const src = hostSrc('dashboard', 'agentManager', 'questionRouting.ts');
    expect(src).toContain("!options.some((o) => o.kind === 'allow_always')");
  });

  it('the host still prefers allow_once, then allow_always, then any non-reject', () => {
    const src = hostSrc('dashboard', 'agentManager', 'permissions.ts').replace(/\s+/g, ' ');
    expect(src).toContain("byKind('allow_once') ?? byKind('allow_always') ?? options.find((o) => !o.kind.startsWith('reject'))");
  });
});
