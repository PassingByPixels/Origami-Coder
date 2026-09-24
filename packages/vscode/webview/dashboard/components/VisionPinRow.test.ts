// The Vision control's BODY — what it draws, what it posts, and the property
// the whole redesign is for: ONE lit answer, never two.
//
// Component level on purpose, the same reasoning VisionProfileMenu.test.ts
// gives: the control's job is "given a state, look like this and post that", and
// driving it through InputBar would prove InputBar's props instead.
//
// THE TWO HALVES FAIL INDEPENDENTLY. A control that draws the right line but
// posts the wrong wire value silently pins the opposite of what was clicked; one
// that posts correctly but draws Auto for a pinned model tells the owner their
// choice did not take. Both are asserted for every state.
//
// THE COUNT, NOT THE IDENTITY. visionTriad.ts holds the table and its own test
// enumerates all sixteen combinations; what is asserted HERE is that the
// rendering does not add a second lit thing of its own — the legacy Off chip and
// the profile list are both drawn in this file, and both were capable of lighting
// beside a lit choice before the fold.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import VisionPinRow from './VisionPinRow.svelte';
import VisionProfileMenu from './VisionProfileMenu.svelte';
import { visionPinLine, type VisionState } from './visionPinState';

afterEach(cleanup);
beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

const SID = 'session-7';
const AGENTS = ['vision-eye', 'vision-owl'];
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const choices = (c: HTMLElement) => Array.from(c.querySelectorAll('.pin-row .pin-btn')) as HTMLElement[];
const names = (c: HTMLElement) => choices(c).map((b) => b.querySelector('.pin-name')?.textContent?.trim());
/** Everything the ROW lights. The profile list lights its own row separately —
 *  that is a second question (which profile), not a second answer. */
const armed = (c: HTMLElement) =>
  choices(c).filter((b) => b.classList.contains('active')).map((b) => b.querySelector('.pin-name')?.textContent?.trim());
const line = (c: HTMLElement) => c.querySelector('.pin-line')?.textContent ?? '';
const note = (c: HTMLElement) => c.querySelector('.pin-note')?.textContent ?? '';
const subs = (c: HTMLElement) => Array.from(c.querySelectorAll('.vision-item')).map((b) => b.textContent?.trim());
const click = (c: HTMLElement, name: string) =>
  fireEvent.click(choices(c).find((b) => b.querySelector('.pin-name')?.textContent?.trim() === name)!);

function mount(props: { vision?: VisionState; profile?: string; agents?: string[]; native?: boolean } = {}) {
  const onSelect = vi.fn();
  const rendered = render(VisionPinRow, {
    props: {
      vision: (props.vision ?? 'auto-off') as VisionState,
      sessionId: SID,
      profile: props.profile ?? '',
      agents: props.agents ?? AGENTS,
      native: props.native ?? false,
      onSelect,
    },
  });
  return { ...rendered, onSelect };
}

describe('one answer, never two', () => {
  it.each<[string, { vision?: VisionState; profile?: string; agents?: string[]; native?: boolean }, string]>([
    ['detected off', { vision: 'auto-off' }, 'Auto'],
    ['detected on', { vision: 'auto-on' }, 'Auto'],
    ['pinned on', { vision: 'on' }, 'On'],
    ['pinned on with a profile armed', { vision: 'on', profile: 'vision-eye' }, 'On'],
    ['profile armed', { vision: 'auto-off', profile: 'vision-eye' }, 'Profile'],
    ['LEGACY pinned off', { vision: 'off' }, 'Off'],
    ['LEGACY pinned off with a profile armed', { vision: 'off', profile: 'vision-eye' }, 'Profile'],
    ['native model', { vision: 'auto-on', native: true, profile: 'vision-eye' }, 'Auto'],
    ['no profiles on disk', { vision: 'auto-off', agents: [] }, 'Auto'],
  ])('%s lights exactly one choice: %s', (_label, props, expected) => {
    const { container } = mount(props);
    expect(armed(container)).toEqual([expected]);
  });

  it.each<VisionState>(['auto-on', 'auto-off', 'on', 'off'])('%s reads out who decided it', (vision) => {
    const { container } = mount({ vision });
    expect(line(container)).toBe(visionPinLine(vision));
  });

  it('says nothing about when it applies until something has actually changed', () => {
    // A note that is always there is a note nobody reads by the third time.
    expect(note(mount().container)).toBe('');
  });
});

describe('the choices on offer', () => {
  it('is Auto, On, Profile — and never an Off button', () => {
    const { container } = mount();
    expect(names(container)).toEqual(['Auto', 'On', 'Profile']);
  });

  it('hides Profile when no vision profiles exist on disk', () => {
    expect(names(mount({ agents: [] }).container)).toEqual(['Auto', 'On']);
  });

  it('hides Profile from a NATIVE model — the engine drops it there', () => {
    expect(names(mount({ native: true }).container)).toEqual(['Auto', 'On']);
  });

  it('names the SCOPE each choice acts on, so a model setting cannot read as a chat one', () => {
    const { container } = mount();
    const scopes = choices(container).map((b) => b.querySelector('.pin-scope')?.textContent?.trim());
    // Auto's slot carries what the engine currently thinks instead of the word
    // "this model" — it is the only choice whose sublabel has a fact to report.
    expect(scopes[0]).toBe('no vision detected');
    expect(scopes[1]).toBe('this model');
    expect(scopes[2]).toBe('this chat');
  });

  it('Auto reports the DETECTED answer for a model nobody pinned', () => {
    const { container } = mount({ vision: 'auto-on' });
    expect(container.querySelector('.pin-scope')?.textContent?.trim()).toBe('detected: vision');
  });
});

describe('the legacy Off pin', () => {
  it('is reported for a stored off pin, and only then', () => {
    expect(mount({ vision: 'off' }).container.querySelector('.pin-legacy')).not.toBeNull();
    for (const vision of ['auto-on', 'auto-off', 'on'] as VisionState[]) {
      expect(mount({ vision }).container.querySelector('.pin-legacy')).toBeNull();
      cleanup();
    }
  });

  it('is not a button — there is nothing left to set it TO', () => {
    // Retiring the setting means retiring the way to make it. Obeying one that
    // is already stored is a different obligation.
    const chip = mount({ vision: 'off' }).container.querySelector('.pin-legacy')!;
    expect(chip.tagName).toBe('SPAN');
  });

  it('is cleared by Auto, which is the only exit offered', async () => {
    const { container } = mount({ vision: 'off' });
    await click(container, 'Auto');
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: '', sessionId: SID }]);
  });
});

describe('what the control posts', () => {
  it.each<[VisionState, string, string]>([
    ['auto-off', 'On', 'on'],
    ['auto-on', 'On', 'on'],
    ['on', 'Auto', ''],
    ['off', 'On', 'on'],
  ])('from %s, clicking %s posts mode "%s"', async (vision, label, wire) => {
    const { container } = mount({ vision });
    await click(container, label);
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: wire, sessionId: SID }]);
  });

  it('tags the post with THIS chat\'s session — a pin in a grid cell is not a pin in every cell', async () => {
    const { container } = render(VisionPinRow, {
      props: { vision: 'auto-off' as VisionState, sessionId: 'other-chat', profile: '', agents: AGENTS, native: false, onSelect: vi.fn() },
    });
    await click(container as HTMLElement, 'On');
    expect(posts()[0]).toMatchObject({ sessionId: 'other-chat' });
  });

  it.each<[VisionState, string]>([
    ['auto-on', 'Auto'],
    ['auto-off', 'Auto'],
    ['on', 'On'],
  ])('from %s, clicking the ARMED choice (%s) posts nothing', async (vision, label) => {
    // No write means no origami.json rewrite, no .bak, and no "it applies next
    // message" note for a change that did not happen.
    const { container } = mount({ vision });
    await click(container, label);
    expect(posts()).toEqual([]);
    expect(note(container)).toBe('');
  });

  it('says WHEN a change applies, and never asks for a reload', async () => {
    // The pin is live: the panel's writeVision seam fires provider_refresh, and
    // the engine re-resolves the model per step. Asking for a window reload here
    // would be the old limitation outliving its fix.
    const { container } = mount();
    await click(container, 'On');
    expect(note(container)).toContain('next message');
    expect(note(container).toLowerCase()).not.toContain('reload');
  });

  it('Profile opens the list and writes no pin', async () => {
    const { container } = mount();
    expect(subs(container)).toEqual([]);
    await click(container, 'Profile');
    expect(subs(container)).toEqual(['None', '@vision-eye', '@vision-owl']);
    expect(posts()).toEqual([]);
  });

  it('the null-profile row is "None" — the old "Off" said the same word as the pin', async () => {
    const { container } = mount();
    await click(container, 'Profile');
    expect(subs(container)).not.toContain('Off');
  });

  it('shows the armed profile straight away, without a click to find out which', () => {
    const { container } = mount({ profile: 'vision-owl' });
    expect(subs(container)).toEqual(['None', '@vision-eye', '@vision-owl']);
    const lit = Array.from(container.querySelectorAll('.vision-item.active')).map((b) => b.textContent?.trim());
    expect(lit).toEqual(['@vision-owl']);
  });

  it('picking a profile reports the slug and posts no pin', async () => {
    const { container, onSelect } = mount({ profile: 'vision-eye' });
    const owl = Array.from(container.querySelectorAll('.vision-item')).find((b) => b.textContent?.includes('owl'))!;
    await fireEvent.click(owl);
    expect(onSelect).toHaveBeenCalledWith('vision-owl');
    expect(posts()).toEqual([]);
  });

  it('AUTO clears the armed profile as well as the pin', async () => {
    // Auto is the "nothing manual" answer. Clearing only the pin would leave a
    // describer still routing every image while the control said Auto — the
    // exact two-answers-at-once defect this control replaced.
    const { container, onSelect } = mount({ vision: 'on', profile: 'vision-eye' });
    await click(container, 'Auto');
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: '', sessionId: SID }]);
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('ON leaves the profile set — a chat armed before a model switch keeps it', async () => {
    // Round 3's rule: the engine drops the profile for a sighted model but the
    // session row still holds it, and throwing it away here would lose the
    // setting on a switch the user may undo in a minute.
    const { container, onSelect } = mount({ vision: 'auto-off', profile: 'vision-eye' });
    await click(container, 'On');
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: 'on', sessionId: SID }]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('inside the popover', () => {
  /** The control as InputBar mounts it. */
  function popover(props: { native?: boolean; visionState?: VisionState; agents?: string[]; profile?: string } = {}) {
    const onSelect = vi.fn();
    const rendered = render(VisionProfileMenu, {
      props: {
        profile: props.profile ?? '',
        agents: props.agents ?? AGENTS,
        open: true,
        native: props.native ?? false,
        visionState: (props.visionState ?? 'auto-off') as VisionState,
        sessionId: SID,
        onToggle: vi.fn(),
        onSelect,
        onClose: vi.fn(),
      },
    });
    return { ...rendered, onSelect };
  }

  it('is the ONLY control in the popover — no second armed row underneath it', () => {
    // The defect, pinned: the profile list used to be a sibling of this row with
    // its own lit item, so "Auto" and "@vision-eye" were both lit at once.
    const { container } = popover({ profile: 'vision-eye' });
    expect(armed(container)).toEqual(['Profile']);
    expect(container.querySelectorAll('.pin-row')).toHaveLength(1);
  });

  it('a NATIVE model gets the control too — that is the state most worth correcting', () => {
    // A model that declares image input and cannot actually read one is exactly
    // what On exists to overrule, and it is the branch with no picker to hide in.
    const { container } = popover({ native: true, visionState: 'auto-on' });
    expect(names(container)).toEqual(['Auto', 'On']);
    expect(container.querySelector('.vision-empty')?.textContent).toContain('native vision');
  });

  it('with no profiles at all it still offers the pin, and points at the Agents board', () => {
    const { container } = popover({ agents: [] });
    expect(names(container)).toEqual(['Auto', 'On']);
    expect(container.querySelector('.vision-empty')?.textContent).toContain('Vision Agents');
  });

  it('clicking a pin choice does not select a profile', async () => {
    const { container, onSelect } = popover();
    await click(container as HTMLElement, 'On');
    expect(onSelect).not.toHaveBeenCalled();
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: 'on', sessionId: SID }]);
  });
});
