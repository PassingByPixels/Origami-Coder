// The Vision tri-state ROW — what it draws, what it posts, and what it must
// leave alone.
//
// Component level on purpose, the same reasoning VisionProfileMenu.test.ts
// gives: the row's job is "given a state, look like this and post that", and
// driving it through InputBar would prove InputBar's props instead.
//
// THE TWO HALVES FAIL INDEPENDENTLY. A row that draws the right line but posts
// the wrong wire value silently pins the opposite of what was clicked; a row
// that posts correctly but draws Auto for a pinned model tells the owner their
// choice did not take. Both are asserted for every state.
//
// The last block guards the OTHER control in the popover. The pin row was
// inserted above the vision-PROFILE picker (the proxy path — a second, sighted
// agent that looks at the image on a blind model's behalf), and those are
// different settings with different owners: the pin writes origami.json through
// the host, the profile writes an ACP config option through InputBar. A click on
// one must never be a click on the other.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import VisionPinRow from './VisionPinRow.svelte';
import VisionProfileMenu from './VisionProfileMenu.svelte';
import { visionPinLine, type VisionState } from './visionPinState';

afterEach(cleanup);
beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

const SID = 'session-7';
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll('button.pin-btn')) as HTMLButtonElement[];
const armed = (c: HTMLElement) => buttons(c).filter((b) => b.classList.contains('active')).map((b) => b.textContent?.trim());
const line = (c: HTMLElement) => c.querySelector('.pin-line')?.textContent ?? '';
const note = (c: HTMLElement) => c.querySelector('.pin-note')?.textContent ?? '';

function mount(vision: VisionState) {
  return render(VisionPinRow, { props: { vision, sessionId: SID } });
}

describe('what the row draws', () => {
  it.each<[VisionState, string]>([
    ['auto-on', 'Auto'],
    ['auto-off', 'Auto'],
    ['on', 'On'],
    ['off', 'Off'],
  ])('%s arms exactly one button: %s', (vision, expected) => {
    const { container } = mount(vision);
    expect(buttons(container).map((b) => b.textContent?.trim())).toEqual(['Auto', 'On', 'Off']);
    expect(armed(container)).toEqual([expected]);
  });

  it.each<VisionState>(['auto-on', 'auto-off', 'on', 'off'])('%s reads out who decided it', (vision) => {
    const { container } = mount(vision);
    expect(line(container)).toBe(visionPinLine(vision));
  });

  it('says nothing about reloading until something has actually changed', () => {
    // A note that is always there is a note nobody reads by the third time.
    const { container } = mount('auto-off');
    expect(note(container)).toBe('');
  });
});

describe('what the row posts', () => {
  it.each<[VisionState, string, string]>([
    ['auto-off', 'On', 'on'],
    ['auto-off', 'Off', 'off'],
    ['on', 'Off', 'off'],
    ['off', 'On', 'on'],
    ['on', 'Auto', ''],
    ['auto-on', 'Off', 'off'],
  ])('from %s, clicking %s posts mode "%s"', async (vision, label, wire) => {
    const { container } = mount(vision);
    const btn = buttons(container).find((b) => b.textContent?.trim() === label)!;
    await fireEvent.click(btn);
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: wire, sessionId: SID }]);
  });

  it('tags the post with THIS chat\'s session — a pin in a grid cell is not a pin in every cell', async () => {
    const { container } = render(VisionPinRow, { props: { vision: 'auto-off' as VisionState, sessionId: 'other-chat' } });
    await fireEvent.click(buttons(container).find((b) => b.textContent?.trim() === 'On')!);
    expect(posts()[0]).toMatchObject({ sessionId: 'other-chat' });
  });

  it.each<[VisionState, string]>([
    ['auto-on', 'Auto'],
    ['auto-off', 'Auto'],
    ['on', 'On'],
    ['off', 'Off'],
  ])('from %s, clicking the ARMED button (%s) posts nothing', async (vision, label) => {
    // No write means no origami.json rewrite, no .bak, and no reload note for a
    // change that did not happen.
    const { container } = mount(vision);
    await fireEvent.click(buttons(container).find((b) => b.textContent?.trim() === label)!);
    expect(posts()).toEqual([]);
    expect(note(container)).toBe('');
  });

  it('shows the reload note only AFTER a change, and says why', async () => {
    // The engine freezes model capabilities when it builds the provider — no TTL,
    // no fs watch — so the pin changes what the NEXT engine reads.
    const { container } = mount('auto-off');
    await fireEvent.click(buttons(container).find((b) => b.textContent?.trim() === 'On')!);
    expect(note(container)).toContain('reload');
    expect(note(container)).toContain('capabilities');
  });
});

describe('the proxy path is untouched', () => {
  /** The popover as a blind model sees it: pin row on top, profile picker below. */
  function popover(props: { native?: boolean; visionState?: VisionState } = {}) {
    const onSelect = vi.fn();
    const rendered = render(VisionProfileMenu, {
      props: {
        profile: '',
        agents: ['vision-eye', 'vision-owl'],
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

  it('a blind model still gets its full profile picker beside the pin row', () => {
    const { container } = popover();
    expect(buttons(container)).toHaveLength(3);
    expect(Array.from(container.querySelectorAll('.vision-item')).map((b) => b.textContent?.trim()))
      .toEqual(['Off', '@vision-eye', '@vision-owl']);
  });

  it('clicking a pin button does not select a profile', async () => {
    const { container, onSelect } = popover();
    await fireEvent.click(buttons(container).find((b) => b.textContent?.trim() === 'On')!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(posts()).toEqual([{ type: 'setVisionPin', mode: 'on', sessionId: SID }]);
  });

  it('choosing a profile does not pin anything', async () => {
    const { container, onSelect } = popover();
    const item = Array.from(container.querySelectorAll('.vision-item'))
      .find((b) => b.textContent?.trim() === '@vision-eye') as HTMLButtonElement;
    await fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('vision-eye');
    // The profile write is InputBar's (it owns the optimistic echo); the row must
    // not have posted a pin alongside it.
    expect(posts()).toEqual([]);
  });

  it('a NATIVE model gets the pin row too — that is the state most worth correcting', () => {
    // A model that declares image input and cannot actually read one is exactly
    // the case Off exists for, and it is the branch with no picker to hide behind.
    const { container } = popover({ native: true, visionState: 'auto-on' });
    expect(buttons(container)).toHaveLength(3);
    expect(container.querySelectorAll('.vision-item')).toHaveLength(0);
    expect(line(container)).toBe(visionPinLine('auto-on'));
  });
});
