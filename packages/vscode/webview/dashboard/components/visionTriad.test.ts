// The Vision triad's TRUTH TABLE — and the one property the redesign exists to
// hold: exactly one answer, in every reachable state.
//
// THE DEFECT THIS PINS. The popover used to draw two independent armed rows —
// the Auto/On/Off pin above the Off/@slug profile list — so a blind model with
// a describer armed showed "Auto" lit above "@vision-qen" lit, and a pinned-on
// model showed "On" lit above "Off" lit. The owner read that as the control
// giving two contradictory answers to one question, because it was. Every case
// below asserts the count, not just the identity: an assertion that says "On is
// active" passes just as happily on a table that lights On AND Profile.
//
// EXHAUSTIVE, not sampled. The inputs are four states x profile-or-not x
// native-or-not x profiles-exist-or-not, which is sixteen reachable rows — small
// enough to enumerate, and enumerating is the only way the count property means
// anything. A table, so none of this needs a DOM.

import { describe, expect, it } from 'vitest';
import { TRIAD_CHOICES, visionTriad, type TriadMode } from './visionTriad';
import { visionPinLine, type VisionState } from './visionPinState';

const STATES: VisionState[] = ['auto-on', 'auto-off', 'on', 'off'];
const AGENTS = ['vision-eye', 'vision-owl'];

/** Every combination the popover can be opened in. */
function every(): Array<{ vision: VisionState; profile: string; agents: string[]; native: boolean }> {
  const out = [];
  for (const vision of STATES)
    for (const profile of ['', 'vision-eye'])
      for (const agents of [[], AGENTS])
        for (const native of [false, true]) out.push({ vision, profile, agents, native });
  return out;
}

/** Which of the four modes the control is REPORTING as the answer, counted the
 *  way the component draws it: a mode is answered when it is `active`, and it is
 *  drawable when it is offered (or, for `off`, reported). */
function answers(t: ReturnType<typeof visionTriad>): TriadMode[] {
  const drawn: TriadMode[] = ['auto', 'on'];
  if (t.showProfile) drawn.push('profile');
  if (t.showLegacyOff) drawn.push('off');
  return drawn.filter((m) => m === t.active);
}

describe('exactly one answer', () => {
  it.each(every())(
    'vision=$vision profile="$profile" agents=$agents.length native=$native lights one choice and one only',
    (input) => {
      const t = visionTriad(input);
      expect(answers(t)).toHaveLength(1);
    },
  );

  it('the active mode is always one the control actually draws', () => {
    // An `active` of 'profile' on a model with no profiles would light nothing
    // at all, and the popover would silently have no answer in it.
    for (const input of every()) {
      const t = visionTriad(input);
      if (t.active === 'profile') expect(t.showProfile).toBe(true);
      if (t.active === 'off') expect(t.showLegacyOff).toBe(true);
    }
  });
});

describe('which answer, and why', () => {
  it('a pin of On wins outright, armed profile or not', () => {
    // The engine drops the profile for a model it believes can see
    // (session/vision.ts), so naming the profile here would name a route
    // nothing takes.
    expect(visionTriad({ vision: 'on', profile: '', agents: AGENTS, native: false }).active).toBe('on');
    expect(visionTriad({ vision: 'on', profile: 'vision-eye', agents: AGENTS, native: false }).active).toBe('on');
  });

  it('an armed profile IS the answer for a model that cannot see', () => {
    expect(visionTriad({ vision: 'auto-off', profile: 'vision-eye', agents: AGENTS, native: false }).active).toBe('profile');
  });

  it('pinned OFF with a describer armed shows Profile, not Off', () => {
    // The canonical pairing: the owner said the model is blind AND armed
    // something to look for it. What happens to the next image is the profile.
    expect(visionTriad({ vision: 'off', profile: 'vision-eye', agents: AGENTS, native: false }).active).toBe('profile');
  });

  it('pinned OFF with nothing routed reports itself', () => {
    const t = visionTriad({ vision: 'off', profile: '', agents: AGENTS, native: false });
    expect(t.active).toBe('off');
    expect(t.showLegacyOff).toBe(true);
    expect(t.line).toContain('pinned');
  });

  it('everything else is Auto', () => {
    expect(visionTriad({ vision: 'auto-on', profile: '', agents: [], native: false }).active).toBe('auto');
    expect(visionTriad({ vision: 'auto-off', profile: '', agents: [], native: false }).active).toBe('auto');
  });

  it('a NATIVE model is on Auto even with a profile set — the engine drops it', () => {
    // Round 3's rule, unchanged: `capabilities.input.image` true means the
    // engine looks itself and `activeProfile` returns undefined. Lighting
    // Profile there would claim a route the engine refuses to take.
    const t = visionTriad({ vision: 'auto-on', profile: 'vision-eye', agents: AGENTS, native: true });
    expect(t.active).toBe('auto');
    expect(t.showProfile).toBe(false);
  });

  it('carries the read-out line for its state, so the words and the lit choice cannot disagree', () => {
    for (const vision of STATES) {
      expect(visionTriad({ vision, profile: '', agents: [], native: false }).line).toBe(visionPinLine(vision));
    }
  });
});

describe('when Profile is offered at all', () => {
  it('is hidden when no vision profiles exist on disk', () => {
    // "None configured" is a different problem from "none chosen", and only one
    // of them is solved by going to the Agents board — VisionProfileMenu still
    // says so in the note beside this.
    expect(visionTriad({ vision: 'auto-off', profile: '', agents: [], native: false }).showProfile).toBe(false);
  });

  it('is shown when they do', () => {
    expect(visionTriad({ vision: 'auto-off', profile: '', agents: AGENTS, native: false }).showProfile).toBe(true);
  });

  it('is withheld from a native model even when profiles exist', () => {
    expect(visionTriad({ vision: 'auto-off', profile: '', agents: AGENTS, native: true }).showProfile).toBe(false);
  });
});

describe('what Auto says the engine currently thinks', () => {
  it.each([
    ['auto-on', 'detected: vision'],
    ['auto-off', 'no vision detected'],
  ])('%s reads "%s"', (vision, note) => {
    expect(visionTriad({ vision: vision as VisionState, profile: '', agents: [], native: false }).autoNote).toBe(note);
  });

  it('a PINNED model does not report a detected answer it cannot know', () => {
    // The pin overwrote the config flag, so `readModelVision` now returns the
    // owner's value. Claiming "detected: vision" there would be reporting the
    // pin back as if the server had said it.
    for (const vision of ['on', 'off'] as VisionState[]) {
      const note = visionTriad({ vision, profile: '', agents: [], native: false }).autoNote;
      expect(note).not.toContain('detected');
      expect(note).toContain('server');
    }
  });
});

describe('the choices offered', () => {
  it('is Auto, On, Profile — in that order, and NO Off', () => {
    expect(TRIAD_CHOICES.map((c) => c.mode)).toEqual(['auto', 'on', 'profile']);
    expect(TRIAD_CHOICES.map((c) => c.name)).toEqual(['Auto', 'On', 'Profile']);
  });

  it('Auto is the ABSENCE of a pin on the wire; Profile writes no pin at all', () => {
    expect(TRIAD_CHOICES.find((c) => c.mode === 'auto')?.wire).toBe('');
    expect(TRIAD_CHOICES.find((c) => c.mode === 'on')?.wire).toBe('on');
    // A profile is a session config option, not a capability pin. A wire value
    // here would send the two settings down one path.
    expect(TRIAD_CHOICES.find((c) => c.mode === 'profile')?.wire).toBeUndefined();
  });

  it('every choice names the SCOPE it acts on', () => {
    // The pin is per-model and global; the profile is per-chat. Without this
    // said out loud, three buttons in a row read as one setting with three
    // values — which is how the old stack got misread in the first place.
    expect(TRIAD_CHOICES.find((c) => c.mode === 'auto')?.scope).toBe('this model');
    expect(TRIAD_CHOICES.find((c) => c.mode === 'on')?.scope).toBe('this model');
    expect(TRIAD_CHOICES.find((c) => c.mode === 'profile')?.scope).toBe('this chat');
  });

  it('each choice explains what it does, and Auto names the servers that answer', () => {
    for (const c of TRIAD_CHOICES) expect(c.title.length).toBeGreaterThan(20);
    const auto = TRIAD_CHOICES.find((c) => c.mode === 'auto')!;
    expect(auto.title).toContain('LM Studio');
    expect(auto.title).toContain('Ollama');
  });

  it('no offered choice claims a reload is needed, and On says when it lands', () => {
    // The pin is live now (providerRefresh.ts + the panel's writeVision seam).
    // Copy that still asked for a window reload would be the feature's old
    // limitation surviving its fix.
    for (const c of TRIAD_CHOICES) expect(c.title.toLowerCase()).not.toContain('reload');
    expect(TRIAD_CHOICES.find((c) => c.mode === 'on')?.title).toContain('next message');
  });

  it('every offered mode is reachable — each is some state\'s answer', () => {
    const reachable = new Set(every().map((i) => visionTriad(i).active));
    for (const c of TRIAD_CHOICES) expect(reachable).toContain(c.mode);
  });
});
