// What the composer does with a mid-turn Enter it will NOT deliver, and what it
// says about it (components/interjectHold.ts).
//
// The rule exists because of a silence. Before t-4ahs3u the in-flight branch of
// `doSend` had one outcome for everything it could not interject — return, with
// no post, no chip and no word — so a composer holding a picture looked exactly
// like a broken Send button. Now every refusal names itself, and the sentence is
// a PROMISE: "sent when the turn ends" over a draft nothing will ever send would
// be a worse lie than the silence it replaced. So the pairing of `held` with its
// wording is the thing under test here, not the wording alone.

import { describe, it, expect } from 'vitest';
import { HELD_FOR_IDLE, NO_TURN_ROUTE, SLASH_WAITS, interjectHold } from '../components/interjectHold';

describe('interjectHold — deliver it, or say why not', () => {
  it('delivers an ordinary line into the turn: no verdict, nothing to explain', () => {
    expect(interjectHold(false, true, false)).toBeNull();
  });

  it('delivers a line WITH attachments too — that is the whole of t-4ahs3u', () => {
    // The defect in one assertion: this used to be a hold, and the hold said
    // nothing.
    expect(interjectHold(false, true, true)).toBeNull();
  });

  it('refuses a slash command and keeps the draft for the user to re-send', () => {
    expect(interjectHold(true, true, false)).toEqual({ held: false, reason: SLASH_WAITS });
    expect(interjectHold(true, true, true), 'a picture does not make it interjectable').toEqual({
      held: false,
      reason: SLASH_WAITS,
    });
  });

  it('a composer with no route holds an ATTACHED draft, and says it will send it', () => {
    // The bare collab surface. It has no turn of its own to reach into, so the
    // draft waits for the boundary — which this mount really does honour, and
    // the sentence therefore really can promise.
    expect(interjectHold(false, false, true)).toEqual({ held: true, reason: HELD_FOR_IDLE });
  });

  it('a composer with no route and nothing attached promises nothing it will not do', () => {
    const verdict = interjectHold(false, false, false)!;
    expect(verdict.held, 'nobody re-sends this one').toBe(false);
    expect(verdict.reason).toBe(NO_TURN_ROUTE);
    expect(verdict.reason, 'so it must not claim the composer will').not.toContain('is sent when');
  });

  it('every sentence names the running turn, so the reason is readable where it appears', () => {
    for (const sentence of [SLASH_WAITS, HELD_FOR_IDLE, NO_TURN_ROUTE]) {
      expect(sentence).toContain('running turn');
      expect(sentence.endsWith('.'), 'one line, finished — it sits in a chip').toBe(true);
    }
  });
});
