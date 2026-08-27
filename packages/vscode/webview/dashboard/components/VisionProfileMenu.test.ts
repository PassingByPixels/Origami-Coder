// t-kgtr6c round 3 — the Vision button's STATE MATRIX.
//
// Round 2 shipped two controls for one subject: this button ("Eye"), and a
// separate read-out chip that lit whenever the chat's model declared image
// input. They never agreed — the chip could be lit (this model sees) beside a
// button offering to route around a model that cannot. Round 3 folds them, so
// the button now has to carry THREE facts at once, and this is the table of
// what each combination must show and must do.
//
// Component level on purpose. The button's job is "given native + profile, look
// like this and open that"; driving it through InputBar would prove InputBar's
// wiring (which InputBar.test.ts already does) and hide which of the two got a
// case wrong.
//
// Every case asserts the CLICK as well as the look, because the two halves fail
// independently: a native button that opens the picker offers a setting the
// engine refuses to spend (session/vision.ts drops the profile for a model that
// sees), and a blind button that opens a note strands the user with no way to
// arm anything.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import VisionProfileMenu from './VisionProfileMenu.svelte';

afterEach(cleanup);

const AGENTS = ['vision-eye', 'vision-owl'];

function mount(props: { native?: boolean; profile?: string; open?: boolean } = {}) {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const rendered = render(VisionProfileMenu, {
    props: {
      profile: props.profile ?? '',
      agents: AGENTS,
      open: props.open ?? false,
      native: props.native ?? false,
      onToggle,
      onSelect,
      onClose,
    },
  });
  return { ...rendered, onToggle, onSelect, onClose };
}

const btn = (c: HTMLElement) => c.querySelector('button.vision-btn') as HTMLButtonElement;
const items = (c: HTMLElement) => Array.from(c.querySelectorAll('.vision-item')).map((b) => b.textContent?.trim());
const note = (c: HTMLElement) => c.querySelector('.vision-empty')?.textContent ?? '';

describe('Vision button — one control, three states', () => {
  it('NO native vision, nothing armed: neutral, and named just "Vision"', () => {
    const { container } = mount();
    expect(btn(container).textContent?.trim()).toBe('Vision');
    expect(btn(container).classList.contains('active')).toBe(false);
    expect(btn(container).classList.contains('native')).toBe(false);
  });

  it('NO native vision, ARMED: lit, and it NAMES the profile', () => {
    const { container } = mount({ profile: 'vision-eye' });
    // "On" without a name is the state a user cannot check against the board.
    expect(btn(container).textContent?.trim()).toBe('Vision: vision-eye');
    expect(btn(container).classList.contains('active')).toBe(true);
    expect(btn(container).classList.contains('native')).toBe(false);
  });

  it('NATIVE vision: lit in its own tone, and never named after a profile', () => {
    const { container } = mount({ native: true });
    expect(btn(container).textContent?.trim()).toBe('Vision');
    expect(btn(container).classList.contains('active')).toBe(true);
    expect(btn(container).classList.contains('native')).toBe(true);
  });

  // The case a user reaches by switching models mid-chat. The row setting
  // survives; the route does not. Naming the profile here would claim a route
  // that `SessionVision.activeProfile` refuses to take.
  it('NATIVE and armed: the native fact wins the label', () => {
    const { container } = mount({ native: true, profile: 'vision-eye' });
    expect(btn(container).textContent?.trim()).toBe('Vision');
    expect(btn(container).classList.contains('native')).toBe(true);
  });

  it('is the ONLY vision control in the component — the read-out chip is gone', () => {
    const { container } = mount({ native: true });
    expect(container.querySelectorAll('button.vision-btn')).toHaveLength(1);
    expect(container.querySelector('.vision-indicator')).toBeNull();
  });
});

describe('Vision button — what a click opens', () => {
  it('a blind model opens the PICKER: Off plus every profile', () => {
    const { container } = mount({ open: true });
    expect(items(container)).toEqual(['Off', '@vision-eye', '@vision-owl']);
  });

  it('picking a profile reports the slug; Off reports the empty string', async () => {
    const { container, onSelect } = mount({ open: true, profile: 'vision-eye' });
    const owl = Array.from(container.querySelectorAll('.vision-item')).find((b) =>
      b.textContent?.includes('vision-owl'),
    )!;
    await fireEvent.click(owl);
    expect(onSelect).toHaveBeenCalledWith('vision-owl');

    const off = Array.from(container.querySelectorAll('.vision-item')).find((b) => b.textContent?.trim() === 'Off')!;
    await fireEvent.click(off);
    // '' is the engine's clear-word (acp/service.ts); "off" would arm a profile
    // by that name, or be refused.
    expect(onSelect).toHaveBeenCalledWith('');
  });

  it('a NATIVE model opens a note and offers nothing to pick', () => {
    const { container } = mount({ native: true, open: true });
    expect(items(container)).toEqual([]);
    expect(note(container)).toContain('native vision');
  });

  it('a NATIVE model with a profile still set says that profile is idle', () => {
    const { container } = mount({ native: true, profile: 'vision-eye', open: true });
    expect(items(container)).toEqual([]);
    expect(note(container)).toContain('@vision-eye');
    expect(note(container)).toContain('idle');
  });

  it('with no profiles at all it sends you to the Agents board, not to an empty list', () => {
    const { container } = render(VisionProfileMenu, {
      props: { profile: '', agents: [], open: true, native: false, onToggle: vi.fn(), onSelect: vi.fn(), onClose: vi.fn() },
    });
    expect(items(container)).toEqual([]);
    expect(note(container)).toContain('Vision Agents');
  });

  it('the parent owns the open flag — a click only reports it', async () => {
    const { container, onToggle } = mount();
    await fireEvent.click(btn(container));
    expect(onToggle).toHaveBeenCalledTimes(1);
    // ...and it did NOT open itself, which is what keeps InputBar the one place
    // that knows whether this popover or the approve one is showing.
    expect(container.querySelector('.vision-pop')).toBeNull();
  });
});
