// The audience reader, on its own. The behaviour that matters is the ASYMMETRY:
// it suppresses only on an explicit, well-formed list that leaves the user out,
// and renders on everything else. A stricter reader would silently delete turns
// from a replayed transcript whenever a rider arrived half-formed — the failure
// mode nobody would report, because the evidence is what went missing.

import { describe, expect, it } from 'vitest';
import { modelOnlyContent } from '../../../src/acpAudience';

const withAudience = (audience: unknown) => ({ type: 'text', text: 'x', annotations: { audience } });

describe('modelOnlyContent', () => {
  it('suppresses content addressed to the assistant alone (a synthetic replayed part)', () => {
    expect(modelOnlyContent(withAudience(['assistant']))).toBe(true);
  });

  it('keeps content addressed to the user alone (an `ignored` part: the human reads it, the model does not)', () => {
    expect(modelOnlyContent(withAudience(['user']))).toBe(false);
  });

  it('keeps content addressed to both', () => {
    expect(modelOnlyContent(withAudience(['user', 'assistant']))).toBe(false);
  });

  it('keeps ordinary content, which carries no rider at all', () => {
    expect(modelOnlyContent({ type: 'text', text: 'who are you' })).toBe(false);
    expect(modelOnlyContent({ type: 'text', text: 'x', annotations: {} })).toBe(false);
  });

  it('fails OPEN on every malformed rider — never delete a turn on a broken annotation', () => {
    for (const bad of [[], null, undefined, 'assistant', 42, {}]) {
      expect(modelOnlyContent(withAudience(bad)), `audience: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('survives absent or non-object input', () => {
    expect(modelOnlyContent(undefined)).toBe(false);
    expect(modelOnlyContent(null)).toBe(false);
    expect(modelOnlyContent('not a block')).toBe(false);
  });

  it('suppresses an unknown NON-user audience too — the rule is "excludes the user", not "names the model"', () => {
    expect(modelOnlyContent(withAudience(['auditor']))).toBe(true);
  });
});
