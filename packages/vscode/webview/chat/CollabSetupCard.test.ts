// CollabSetupCard — the guided card an empty room opens with (report S2).
//
// Create makes an EMPTY room on purpose (M3): the old create form gated its
// Create button on a roster list that arrived asynchronously, so a fast typist
// hit a DISABLED button, a disabled button fires no click, and the form's own
// refusal message never ran either. No collab, no error, nothing on screen said
// why. That is the scar this card is written against.
//
// SO THE ONE RULE THAT OUTRANKS EVERY OTHER HERE: THE CARD GATES NOTHING. It is
// not a modal, it has no backdrop, no step is a precondition for another, and
// dismissing it costs nothing — the room exists and works identically with the
// card up, shut, or never looked at. Every test in the first block is that one
// rule, stated as a behaviour that can fail.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CollabSetupCard from './CollabSetupCard.svelte';
import type { InviteCandidate } from './collabInvite';

const candidate = (slug: string, name: string): InviteCandidate => ({
  slug, displayName: name, disabled: false, model: null, health: { kind: 'unpinned', provider: '' },
});
const CRANE = candidate('collab-crane', 'Crane');
const HERON = candidate('collab-heron', 'Heron');

interface Calls { invited: string[][]; lead: string[]; objective: string[] }

function mount(over: Record<string, unknown> = {}): Calls {
  const calls: Calls = { invited: [], lead: [], objective: [] };
  render(CollabSetupCard, {
    props: {
      participants: [],
      candidates: [CRANE, HERON],
      lead: null,
      objective: null,
      archived: false,
      loaded: true,
      onInvite: (s: string[]) => calls.invited.push(s),
      onSetLead: (s: string) => calls.lead.push(s),
      onSetObjective: (t: string) => calls.objective.push(t),
      ...over,
    },
  });
  return calls;
}

const step = (n: number) => screen.getByRole('button', { name: new RegExp(`step ${n}`, 'i') });

/** Mount EMPTY (the only state that arms the card), then let the room fill —
 *  which is the real sequence: the card is offered to a room that opened with
 *  nobody in it, and stays through the steps it is guiding. */
async function mountThenFill(fill: Record<string, unknown>): Promise<Calls> {
  const calls: Calls = { invited: [], lead: [], objective: [] };
  const base = {
    participants: [], candidates: [CRANE, HERON], lead: null, objective: null, archived: false, loaded: true,
    onInvite: (s: string[]) => calls.invited.push(s),
    onSetLead: (s: string) => calls.lead.push(s),
    onSetObjective: (t: string) => calls.objective.push(t),
  };
  const { rerender } = render(CollabSetupCard, { props: base });
  await rerender({ ...base, ...fill });
  return calls;
}

describe('CollabSetupCard — it gates nothing', () => {
  it('is not a modal — no dialog role and no backdrop over the room', () => {
    const { container } = render(CollabSetupCard, {
      props: {
        participants: [], candidates: [CRANE], lead: null, objective: null, archived: false, loaded: true,
        onInvite: () => {}, onSetLead: () => {}, onSetObjective: () => {},
      },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.sc-backdrop')).toBeNull();
  });

  it('every step is reachable with nothing done — no step is another step’s precondition', async () => {
    mount();
    await fireEvent.click(step(3));
    expect(screen.getByRole('textbox', { name: /objective/i })).toBeInTheDocument();
    await fireEvent.click(step(2));
    await fireEvent.click(step(1));
    expect(screen.getByRole('checkbox', { name: /Crane/ })).toBeInTheDocument();
  });

  it('the objective can be set before anyone is invited — an empty roster blocks no control', async () => {
    const calls = mount();
    await fireEvent.click(step(3));
    const box = screen.getByRole('textbox', { name: /objective/i });
    await fireEvent.input(box, { target: { value: 'Ship the storm plan' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(calls.objective).toEqual(['Ship the storm plan']);
  });

  // Two dismiss controls on purpose — the header ✕ where a card is closed and
  // the footer button where the eye ends up. Both must actually close it, and
  // the card must not re-arm itself while the roster is still empty.
  it.each([
    ['the footer button', 'Dismiss'],
    ['the header close', 'Dismiss the setup guide'],
  ])('%s removes the card, and it does not reappear while the roster stays empty', async (_label, name) => {
    const { container } = render(CollabSetupCard, {
      props: {
        participants: [], candidates: [CRANE], lead: null, objective: null, archived: false, loaded: true,
        onInvite: () => {}, onSetLead: () => {}, onSetObjective: () => {},
      },
    });
    await fireEvent.click(screen.getByRole('button', { name }));
    expect(container.querySelector('.sc-card')).toBeNull();
  });

  it('an ARCHIVED room draws no card at all — there is nothing left to set up', () => {
    const { container } = render(CollabSetupCard, {
      props: {
        participants: [], candidates: [CRANE], lead: null, objective: null, archived: true, loaded: true,
        onInvite: () => {}, onSetLead: () => {}, onSetObjective: () => {},
      },
    });
    expect(container.querySelector('.sc-card')).toBeNull();
  });

  // The pane starts with an EMPTY participants array and fills it from its
  // first poll reply, so arming on "roster is empty" alone would flash the
  // guide over every existing room for one round trip.
  it('does not arm before the room’s first state payload has arrived', async () => {
    const calls: Calls = { invited: [], lead: [], objective: [] };
    const base = {
      participants: [], candidates: [CRANE], lead: null, objective: null, archived: false, loaded: false,
      onInvite: (s: string[]) => calls.invited.push(s),
      onSetLead: (s: string) => calls.lead.push(s),
      onSetObjective: (t: string) => calls.objective.push(t),
    };
    const { container, rerender } = render(CollabSetupCard, { props: base });
    expect(container.querySelector('.sc-card')).toBeNull();

    // The poll answers, and the room really is empty — now it is offered.
    await rerender({ ...base, loaded: true });
    expect(container.querySelector('.sc-card')).not.toBeNull();
  });

  it('a room whose first payload already carries a roster is never greeted with a setup card', async () => {
    const calls: Calls = { invited: [], lead: [], objective: [] };
    const base = {
      participants: [], candidates: [CRANE], lead: null, objective: null, archived: false, loaded: false,
      onInvite: (s: string[]) => calls.invited.push(s),
      onSetLead: (s: string) => calls.lead.push(s),
      onSetObjective: (t: string) => calls.objective.push(t),
    };
    const { container, rerender } = render(CollabSetupCard, { props: base });
    await rerender({ ...base, loaded: true, participants: [{ agentSlug: 'collab-crane', displayName: 'Crane' }] });
    expect(container.querySelector('.sc-card')).toBeNull();
  });

  it('a room that already has a roster is not greeted with a setup card', () => {
    const { container } = render(CollabSetupCard, {
      props: {
        participants: [{ agentSlug: 'collab-crane', displayName: 'Crane' }],
        candidates: [HERON], lead: 'collab-crane', objective: null, archived: false, loaded: true,
        onInvite: () => {}, onSetLead: () => {}, onSetObjective: () => {},
      },
    });
    expect(container.querySelector('.sc-card')).toBeNull();
  });
});

describe('CollabSetupCard — the three steps', () => {
  it('step 1 mounts the SAME multi-select list the roster uses', () => {
    mount();
    expect(screen.getByRole('checkbox', { name: /Crane/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Heron/ })).toBeInTheDocument();
  });

  it('step 2 offers each roster member as the lead', async () => {
    const calls = await mountThenFill({ participants: [{ agentSlug: 'collab-crane', displayName: 'Crane' }] });
    await fireEvent.click(step(2));
    await fireEvent.click(screen.getByRole('button', { name: /Crane/ }));
    expect(calls.lead).toEqual(['collab-crane']);
  });

  it('step 2 with an empty roster explains the automatic lead rather than showing an empty list', async () => {
    mount();
    await fireEvent.click(step(2));
    expect(screen.getByText(/first agent to join/i)).toBeInTheDocument();
  });

  it('marks a step done once the room actually carries that state', async () => {
    await mountThenFill({
      participants: [{ agentSlug: 'collab-crane', displayName: 'Crane' }],
      lead: 'collab-crane',
      objective: 'Ship it',
    });
    // With every step satisfied the card still renders — it is a guide, not a
    // gate — but says so.
    expect(step(1)).toHaveAttribute('data-done', 'true');
    expect(step(2)).toHaveAttribute('data-done', 'true');
    expect(step(3)).toHaveAttribute('data-done', 'true');
  });

  it('a step the room has not satisfied is not marked done', () => {
    mount();
    expect(step(1)).toHaveAttribute('data-done', 'false');
    expect(step(2)).toHaveAttribute('data-done', 'false');
    expect(step(3)).toHaveAttribute('data-done', 'false');
  });
});

// W6 owner UAT: "on the FINAL step the button must be a finisher — Done — that
// CLOSES the card". What he hit was a Next that was DISABLED on step 3, so the
// walk he had just completed ended on a dead control and the only way out was
// Dismiss — which reads as "abandon this", not as "I am finished". A guide that
// cannot be finished is the same shape of failure as the M3 disabled Create
// button this whole component is written against: a control that fires no click
// and says nothing about why.
describe('CollabSetupCard — the last step finishes', () => {
  const nav = (name: RegExp) => screen.queryByRole('button', { name });

  it('offers Next on the earlier steps and Done on the last one, never a dead Next', async () => {
    mount();
    expect(nav(/^Next$/)).toBeEnabled();
    expect(nav(/^Done$/)).toBeNull();
    await fireEvent.click(step(3));
    expect(nav(/^Next$/)).toBeNull();
    expect(nav(/^Done$/)).toBeEnabled();
  });

  it('Done CLOSES the card', async () => {
    const { container } = render(CollabSetupCard, {
      props: {
        participants: [], candidates: [CRANE], lead: null, objective: null, archived: false, loaded: true,
        onInvite: () => {}, onSetLead: () => {}, onSetObjective: () => {},
      },
    });
    await fireEvent.click(step(3));
    await fireEvent.click(screen.getByRole('button', { name: /^Done$/ }));
    expect(container.querySelector('.sc-card')).toBeNull();
  });

  // It GATES NOTHING, still. A finisher that refused to finish until the three
  // steps were satisfied would be the M3 bug back in a new place.
  it('finishes with nothing done at all', async () => {
    const { container } = render(CollabSetupCard, {
      props: {
        participants: [], candidates: [CRANE], lead: null, objective: null, archived: false, loaded: true,
        onInvite: () => {}, onSetLead: () => {}, onSetObjective: () => {},
      },
    });
    await fireEvent.click(step(3));
    expect(step(1)).toHaveAttribute('data-done', 'false');
    await fireEvent.click(screen.getByRole('button', { name: /^Done$/ }));
    expect(container.querySelector('.sc-card')).toBeNull();
  });

  // The box is on screen with the user's words in it. A Done that threw them
  // away would lose work at the exact moment it claims the setup is finished.
  it('commits an objective typed but not entered, rather than discarding it', async () => {
    const calls = mount();
    await fireEvent.click(step(3));
    await fireEvent.input(screen.getByRole('textbox', { name: /objective/i }), { target: { value: 'Ship the storm plan' } });
    await fireEvent.click(screen.getByRole('button', { name: /^Done$/ }));
    expect(calls.objective).toEqual(['Ship the storm plan']);
  });

  it('Back still walks the other way', async () => {
    mount();
    await fireEvent.click(step(3));
    await fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(screen.getByRole('button', { name: /^Next$/ })).toBeEnabled();
  });
});

// W8 owner UAT: on the invite step he ticked agents and pressed Next. NOTHING
// was invited. Next only walked, and the sole committer was the list's own
// Invite button beside it — which his screenshot caught GREYED, because the
// ticks live inside CollabInviteList and the step change UNMOUNTS it, taking
// them with it (verified: with the old code, tick → step 2 → step 1 left the
// row unchecked and Invite `disabled={chosen.length === 0}`).
//
// Ruling: "Clicking next on invite agents should of course invite selected
// agents." So LEAVING step 1 commits, through the list's OWN commit — one wire,
// reached by `bind:this`, never a second copy of the send. With Next committing,
// a second Invite button on this step is one button too many, so the card mounts
// the list without it; the roster's ＋ popover keeps its own.
//
// It still GATES NOTHING (the rule that outranks everything here): an empty
// selection is not an error, it is a user who does not want to invite anyone
// yet, and Next walks on.
describe('CollabSetupCard — Next commits the invite', () => {
  const onStep2 = () => screen.getByText(/first agent to join/i);

  it('invites exactly the ticked agents and then advances', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Heron/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(calls.invited).toEqual([['collab-crane', 'collab-heron']]);
    expect(onStep2()).toBeInTheDocument();
  });

  it('invites only what is still ticked — an untick is not resurrected by Next', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Heron/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(calls.invited).toEqual([['collab-heron']]);
  });

  it('with nothing ticked, Next advances and posts nothing — it gates nothing', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(calls.invited).toEqual([]);
    expect(onStep2()).toBeInTheDocument();
  });

  // The stepper dots leave step 1 too. A commit on Next alone would put the
  // dropped-selection bug straight back on the control beside it.
  it('a stepper jump off step 1 commits as well — no exit silently drops the ticks', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(step(3));
    expect(calls.invited).toEqual([['collab-crane']]);
  });

  // ONE committer on this step. Two buttons for one wire is the duplication the
  // shared list exists to remove, and the greyed one is what he screenshotted.
  it('offers no second Invite button beside Next', async () => {
    mount();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    expect(screen.queryByRole('button', { name: /^Invite/ })).toBeNull();
  });

  // The escape hatch for a room with no bot worth inviting is NOT the commit
  // button, and must survive its removal.
  it('keeps the way out to the Bots section', () => {
    mount();
    expect(screen.getByRole('button', { name: /Manage bots/i })).toBeInTheDocument();
  });

  // The remaining control is honest about being a walk: it is never disabled,
  // on this step or any other.
  it('never disables Next on the invite step, ticked or not', async () => {
    mount();
    expect(screen.getByRole('button', { name: /^Next$/ })).toBeEnabled();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    expect(screen.getByRole('button', { name: /^Next$/ })).toBeEnabled();
  });

  it('commits ONCE — walking back and forward does not re-send what it invited', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    await fireEvent.click(step(1));
    await fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(calls.invited).toEqual([['collab-crane']]);
  });

  // Done sits on the LAST step, so it must not reach for the invite list — the
  // jump that got there already committed, and a second send would double it.
  it('Done adds no further invite on top of the jump that committed', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(step(3));
    await fireEvent.click(screen.getByRole('button', { name: /^Done$/ }));
    expect(calls.invited).toEqual([['collab-crane']]);
  });
});
