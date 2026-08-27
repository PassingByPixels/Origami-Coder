import { describe, expect, it } from 'vitest';
import { mergeInviteCandidates, FS_ONLY_REASON } from './collabInvite';

/** A def that pins no model, with no provider probe answered — the shape every
 *  merge-RULE case below carries now that the candidate reports readiness too.
 *  Spelled once so those cases keep asserting the merge and nothing else. */
const UNPINNED = { model: null, health: { kind: 'unpinned', provider: '' } };

describe('mergeInviteCandidates', () => {
  it('lists an engine-known agent as invitable, not disabled', () => {
    const out = mergeInviteCandidates([{ slug: 'collab-heron', displayName: 'Heron' }], [], []);
    expect(out).toEqual([{ slug: 'collab-heron', displayName: 'Heron', disabled: false, ...UNPINNED }]);
  });

  it('an fs-only def (not yet loaded by the engine) is DISABLED with the restart reason', () => {
    const out = mergeInviteCandidates([], [{ slug: 'collab-new', displayName: 'New Agent' }], []);
    expect(out).toEqual([
      { slug: 'collab-new', displayName: 'New Agent', disabled: true, reason: FS_ONLY_REASON, ...UNPINNED },
    ]);
  });

  it('a slug the engine already knows is never shown disabled, even if it also has an fs def', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-heron', displayName: 'Heron' }],
      [{ slug: 'collab-heron', displayName: 'Heron (fs)' }],
      [],
    );
    expect(out).toEqual([{ slug: 'collab-heron', displayName: 'Heron', disabled: false, ...UNPINNED }]);
  });

  it('an ACTIVE participant is excluded — cannot re-invite someone already in the room', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-heron', displayName: 'Heron' }],
      [],
      [{ agentSlug: 'collab-heron' }],
    );
    expect(out).toEqual([]);
  });

  it('a REMOVED participant is offered again — removal frees the slot', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-heron', displayName: 'Heron' }],
      [],
      [{ agentSlug: 'collab-heron', removedAt: '2026-08-04T10:00:00.000Z' }],
    );
    expect(out).toEqual([{ slug: 'collab-heron', displayName: 'Heron', disabled: false, ...UNPINNED }]);
  });

  it('sorts by slug for a stable popover order', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-zzz', displayName: 'Z' }, { slug: 'collab-aaa', displayName: 'A' }],
      [],
      [],
    );
    expect(out.map((c) => c.slug)).toEqual(['collab-aaa', 'collab-zzz']);
  });
});

// Report 1.4 / S6 — the invite list could not tell you whether an agent will
// actually run. The candidate now carries the def's PIN and the verdict on it,
// so both surfaces that draw candidates read one rule.
describe('mergeInviteCandidates — model + provider health', () => {
  const PROVIDERS = [{ id: 'lmstudio', live: true }, { id: 'openrouter', live: false }];

  it("carries the engine def's pinned model onto the candidate", () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-crane', displayName: 'Crane', model: 'lmstudio/qwen3.5-35b' }],
      [], [], PROVIDERS,
    );
    expect(out[0].model).toBe('lmstudio/qwen3.5-35b');
    expect(out[0].health).toEqual({ kind: 'live', provider: 'lmstudio' });
  });

  it('marks a candidate pinned to an unreachable provider DEAD', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-heron', displayName: 'Heron', model: 'openrouter/poolside/laguna-s-2.1:free' }],
      [], [], PROVIDERS,
    );
    expect(out[0].health).toEqual({ kind: 'dead', provider: 'openrouter' });
  });

  it('an UNPINNED seed reads as "needs a model", not as a dead provider', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-crane', displayName: 'Crane', model: null }],
      [], [], PROVIDERS,
    );
    expect(out[0].model).toBeNull();
    expect(out[0].health).toEqual({ kind: 'unpinned', provider: '' });
  });

  // The fs half of the merge is a def the engine has not loaded; its `model:`
  // frontmatter is still the pin the user wrote, and '' there means unpinned.
  it("an fs-only def carries its own pin, and a blank one reads as unpinned", () => {
    const out = mergeInviteCandidates(
      [], [{ slug: 'collab-new', displayName: 'New', model: '' }], [], PROVIDERS,
    );
    expect(out[0].model).toBeNull();
    expect(out[0].health.kind).toBe('unpinned');
  });

  it('with NO provider status yet, a pinned candidate is unknown — never dead', () => {
    const out = mergeInviteCandidates(
      [{ slug: 'collab-crane', displayName: 'Crane', model: 'lmstudio/qwen3.5-35b' }],
      [], [],
    );
    expect(out[0].health).toEqual({ kind: 'unknown', provider: 'lmstudio' });
  });
});
