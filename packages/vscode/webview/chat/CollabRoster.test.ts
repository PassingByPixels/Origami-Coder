// CollabRoster — the roster strip's three room affordances (X2).
//
// 1. THE LEAD STAR IS A CONTROL (report 1.5 / S8). The lead takes every human
//    message that names nobody, and until now the only way to change it was
//    `/lead <slug>` in the composer — the star on the chip was decoration. A
//    roster fact you can see and cannot touch is the friction.
//
// 2. THE EMPTY ROSTER COACHES (report 1.6). "No agents in this collab." states
//    a fact and offers no next action. It is also the first screen every new
//    user sees, because create makes an EMPTY room by design (M3).
//
// 3. THE ROOM IS SEALED, and nothing said so (report C5). Collab presets deny
//    `send_message`, so agents in a room coordinate only through the room —
//    correct, and invisible.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CollabRoster from './CollabRoster.svelte';

interface P { agentSlug: string; displayName: string; model: string | null; removedAt?: string; sessionId?: string }

const CRANE: P = { agentSlug: 'collab-crane', displayName: 'Crane', model: 'lmstudio/qwen' };
const HERON: P = { agentSlug: 'collab-heron', displayName: 'Heron', model: null };

interface Calls {
  lead: string[];
  invited: string[][];
  stopped: string[];
  redirected: Array<{ slug: string; text: string }>;
}

function mount(over: Record<string, unknown> = {}) {
  const calls: Calls = { lead: [], invited: [], stopped: [], redirected: [] };
  render(CollabRoster, {
    props: {
      title: 'Storm plan',
      archived: false,
      participants: [CRANE, HERON],
      agents: [{ slug: 'collab-crane', state: 'idle' }, { slug: 'collab-heron', state: 'idle' }],
      glyphs: {},
      captureSlug: null,
      capture: null,
      captureError: null,
      captureLoaded: false,
      onContext: () => {},
      onCloseCapture: () => {},
      onUnarchive: () => {},
      invitable: [],
      onInvite: (slugs: string[]) => calls.invited.push(slugs),
      lead: 'collab-crane',
      onSetLead: (slug: string) => calls.lead.push(slug),
      objective: null,
      onSetObjective: () => {},
      loaded: true,
      onStopAgent: (slug: string) => calls.stopped.push(slug),
      onRedirect: (slug: string, text: string) => calls.redirected.push({ slug, text }),
      stopOutcome: null,
      ...over,
    },
  });
  return calls;
}

const rings = (): (string | null)[] =>
  Array.from(document.querySelectorAll('.chip-ring')).map((r) => r.getAttribute('data-state'));

describe('CollabRoster — the lead star is a button', () => {
  it('a non-lead chip carries a control that sets that agent as lead', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('button', { name: /Make Heron the lead/i }));
    expect(calls.lead).toEqual(['collab-heron']);
  });

  it("the LEAD's own chip offers no set-lead control — there is nothing to set", () => {
    mount();
    expect(screen.queryByRole('button', { name: /Make Crane the lead/i })).toBeNull();
    // It is still marked as the lead, which is the roster fact a reader needs.
    expect(screen.getByTitle('lead')).toBeInTheDocument();
  });

  it('a REMOVED participant is not offerable as lead', () => {
    mount({ participants: [CRANE, { ...HERON, removedAt: '2026-08-04T10:00:00.000Z' }] });
    expect(screen.queryByRole('button', { name: /Make Heron the lead/i })).toBeNull();
  });

  it('with NO lead set, every active chip offers the control', () => {
    mount({ lead: null });
    expect(screen.getByRole('button', { name: /Make Crane the lead/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Make Heron the lead/i })).toBeInTheDocument();
  });

  it('setting the lead does not open the context drawer — the two controls are separate', async () => {
    let contexts = 0;
    mount({ onContext: () => { contexts += 1; } });
    await fireEvent.click(screen.getByRole('button', { name: /Make Heron the lead/i }));
    expect(contexts).toBe(0);
  });
});

describe('CollabRoster — the empty roster coaches', () => {
  const empty = { participants: [], agents: [], lead: null };
  const CANDIDATE = { slug: 'collab-crane', displayName: 'Crane', disabled: false, model: null, health: { kind: 'unpinned', provider: '' } };
  /** Take the setup card off the screen the way a user does. */
  const dismissCard = () => fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

  it('never leaves the bare "No agents in this collab." fact on screen', () => {
    mount(empty);
    expect(screen.queryByText('No agents in this collab.')).toBeNull();
  });

  // The card's first step IS this list, so a second inline invite button beside
  // it would be two invite lists on one screen — the duplication the card
  // exists to remove.
  it('stands its own invite button down while the setup card is showing', () => {
    mount(empty);
    expect(screen.queryByRole('button', { name: /Invite agents to this collab/i })).toBeNull();
  });

  it('takes the invite affordance back over once the card is dismissed', async () => {
    mount(empty);
    await dismissCard();
    expect(screen.getByRole('button', { name: /Invite agents to this collab/i })).toBeInTheDocument();
  });

  it('the coaching affordance opens the same multi-select invite list', async () => {
    const calls = mount({ ...empty, invitable: [CANDIDATE] });
    await dismissCard();
    await fireEvent.click(screen.getByRole('button', { name: /Invite agents to this collab/i }));

    await fireEvent.click(screen.getByRole('checkbox', { name: /Crane/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite \(/ }));
    expect(calls.invited).toEqual([['collab-crane']]);
  });

  it('exactly one invite list is ever on screen for an empty room', async () => {
    mount({ ...empty, invitable: [CANDIDATE] });
    expect(screen.getAllByRole('checkbox', { name: /Crane/ })).toHaveLength(1);
    await dismissCard();
    await fireEvent.click(screen.getByRole('button', { name: /Invite agents to this collab/i }));
    expect(screen.getAllByRole('checkbox', { name: /Crane/ })).toHaveLength(1);
  });

  // CollabBanners already says "Nobody is in this collab yet — invite an
  // agent." when a POST reached nobody. That is a different claim (your message
  // woke no one) on a different trigger, and the two must not read as one line
  // printed twice.
  it('does not repeat the no-lead banner sentence', () => {
    mount(empty);
    expect(screen.queryByText(/Nobody is in this collab yet/i)).toBeNull();
  });
});

describe('CollabRoster — the room is sealed', () => {
  it('states once that agents here coordinate only through this room', () => {
    mount();
    expect(screen.getByText(/only through this room/i)).toBeInTheDocument();
  });

  it('says nothing about sealing while the roster is still empty', () => {
    mount({ participants: [], agents: [], lead: null });
    expect(screen.queryByText(/only through this room/i)).toBeNull();
  });
});

// W3 wave 3 (report 2.4 / F7): STOP IS NO LONGER A SLEDGEHAMMER. The only
// interrupt used to be room-wide — it killed the whole chain and spent the
// budget — so correcting one agent meant stopping everyone. Wave 1 gave the
// engine `collab_stop_agent` and `collab_redirect`; these are their controls.
describe('CollabRoster — per-agent Stop', () => {
  const working = [
    { slug: 'collab-crane', state: 'running' },
    { slug: 'collab-heron', state: 'queued' },
  ];

  it('offers Stop on a running agent and on a queued one', () => {
    mount({ agents: working });
    expect(screen.getByRole('button', { name: /Stop Crane/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop Heron/i })).toBeInTheDocument();
  });

  // `collab_stop_agent` on an idle agent can only answer "nothing happened".
  it('offers no Stop on an idle agent — there is no turn to end', () => {
    mount();
    expect(screen.queryByRole('button', { name: /Stop Crane/i })).toBeNull();
  });

  it('stops exactly the agent whose chip was clicked', async () => {
    const calls = mount({ agents: working });
    await fireEvent.click(screen.getByRole('button', { name: /Stop Heron/i }));
    expect(calls.stopped).toEqual(['collab-heron']);
  });

  // The whole difference between this and the room's Stop: everyone else keeps
  // their place. Asserted on the RENDERED state, not on the absence of a call.
  it('leaves every other chip live in the rendered state', async () => {
    const calls = mount({ agents: working });
    await fireEvent.click(screen.getByRole('button', { name: /Stop Heron/i }));
    expect(rings()).toEqual(['running', 'queued']);
    expect(screen.getByRole('button', { name: /Stop Crane/i })).toBeInTheDocument();
    expect(calls.stopped).toEqual(['collab-heron']);
  });

  // W5: under parallel dispatch "running" stops being one agent at a time. A
  // roster that ringed a single worker would show a room half as busy as it is,
  // and the stop control has to reach the agent it names rather than "the"
  // running one.
  it('rings EVERY agent running at once, and stops only the one named', async () => {
    const calls = mount({
      agents: [{ slug: 'collab-crane', state: 'running' }, { slug: 'collab-heron', state: 'running' }],
    });
    expect(rings()).toEqual(['running', 'running']);
    await fireEvent.click(screen.getByRole('button', { name: /Stop Heron/i }));
    expect(calls.stopped).toEqual(['collab-heron']);
  });

  it('offers nothing at all on an archived room', () => {
    mount({ agents: working, archived: true });
    expect(screen.queryByRole('button', { name: /Stop Crane/i })).toBeNull();
  });
});

describe('CollabRoster — the stop outcome is reported honestly', () => {
  const working = [{ slug: 'collab-crane', state: 'running' }, { slug: 'collab-heron', state: 'idle' }];

  it('says what was interrupted and what was dropped', () => {
    mount({ agents: working, stopOutcome: { agentSlug: 'collab-crane', interrupted: true, dequeued: true } });
    expect(screen.getByText(/Stopped Crane/i)).toBeInTheDocument();
  });

  // The case a bare "Stopped." would lie about: a nested ask has no turn of its
  // own, and an idle agent has nothing at all.
  it('reports an agent that was neither interrupted nor dequeued as already idle', () => {
    mount({ agents: working, stopOutcome: { agentSlug: 'collab-crane', interrupted: false, dequeued: false } });
    expect(screen.getByText(/already idle/i)).toBeInTheDocument();
  });

  it('shows the outcome on the stopped chip alone, never on every chip', () => {
    mount({ agents: working, stopOutcome: { agentSlug: 'collab-crane', interrupted: true, dequeued: false } });
    expect(screen.getAllByText(/its turn was interrupted/i)).toHaveLength(1);
  });
});

describe('CollabRoster — Redirect one agent', () => {
  it('sends the typed correction to that agent alone', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('button', { name: /Redirect Heron/i }));
    const box = screen.getByRole('textbox', { name: /Correction for Heron/i });
    await fireEvent.input(box, { target: { value: 'use the other table' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send correction to Heron/i }));
    expect(calls.redirected).toEqual([{ slug: 'collab-heron', text: 'use the other table' }]);
  });

  // The engine refuses an empty correction ("an empty correction corrects
  // nothing and would wake the target to read a blank line"), so the box does
  // not offer to send one.
  it('will not send a blank correction', async () => {
    const calls = mount();
    await fireEvent.click(screen.getByRole('button', { name: /Redirect Heron/i }));
    await fireEvent.input(screen.getByRole('textbox', { name: /Correction for Heron/i }), { target: { value: '   ' } });
    await fireEvent.click(screen.getByRole('button', { name: /Send correction to Heron/i }));
    expect(calls.redirected).toEqual([]);
  });

  it('opens exactly one correction box at a time', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: /Redirect Heron/i }));
    await fireEvent.click(screen.getByRole('button', { name: /Redirect Crane/i }));
    expect(screen.queryByRole('textbox', { name: /Correction for Heron/i })).toBeNull();
    expect(screen.getByRole('textbox', { name: /Correction for Crane/i })).toBeInTheDocument();
  });

  it('offers no correction box on an archived room', () => {
    mount({ archived: true });
    expect(screen.queryByRole('button', { name: /Redirect Crane/i })).toBeNull();
  });
});

// F13: a failed agent used to fall back to a blank ring plus a 14px `!` that
// had to be clicked. The ring vocabulary now has a fourth state.
describe('CollabRoster — the error ring (F13)', () => {
  it('draws an error ring for an idle agent whose last turn failed', () => {
    mount({ agents: [
      { slug: 'collab-crane', state: 'idle', lastError: '@collab-crane has no model — pick one in its agent definition' },
      { slug: 'collab-heron', state: 'idle' },
    ] });
    expect(rings()).toEqual(['error', 'idle']);
  });

  it('lets a working agent look like it is working, failure or not', () => {
    mount({ agents: [
      { slug: 'collab-crane', state: 'running', lastError: 'boom' },
      { slug: 'collab-heron', state: 'queued', lastError: 'boom' },
    ] });
    expect(rings()).toEqual(['running', 'queued']);
  });
});
