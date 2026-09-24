// FlockScopePills — the tick groups inside a contact's Edit popover.
//
// contactScope.test.ts asserts the MATHS (on/isDefault/differs as values);
// this file is the one place that has to prove the DOM actually reflects
// them, because jsdom cannot see a mark — a `default` tag that stopped
// rendering, or a checkbox left unchecked for an `on` pill, would be
// invisible to every other test in the suite.

import { describe, expect, it, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import FlockScopePills from './FlockScopePills.svelte';
import type { ScopePill } from '../panes/contactScope';

afterEach(() => cleanup());

const PILLS: ScopePill[] = [
  { kind: 'repos', value: 'C:/Repos/work/api', label: 'api', on: true, isDefault: true, differs: false },
  { kind: 'repos', value: 'C:/Repos/side/tools', label: 'tools', on: false, isDefault: false, differs: false },
];

const tick = (container: HTMLElement, label: string): HTMLElement =>
  Array.from(container.querySelectorAll('.fk-tick')).find(
    (el) => el.querySelector('span')?.textContent?.trim() === label,
  ) as HTMLElement;

describe('FlockScopePills', () => {
  it('a default pill is checked and carries the `default` tag', () => {
    const { container } = render(FlockScopePills, { props: { pills: PILLS, onbrowse: () => {}, ontoggle: () => {} } });
    const api = tick(container, 'api');
    expect((api.querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(api.querySelector('.fk-tag')?.textContent).toBe('default');
  });

  it('a known, non-default pill is unchecked and carries no tag', () => {
    const { container } = render(FlockScopePills, { props: { pills: PILLS, onbrowse: () => {}, ontoggle: () => {} } });
    const tools = tick(container, 'tools');
    expect((tools.querySelector('input') as HTMLInputElement).checked).toBe(false);
    expect(tools.querySelector('.fk-tag')).toBeNull();
  });

  it('clicking a pill calls ontoggle with its kind and value', async () => {
    const calls: Array<[string, string]> = [];
    const { container } = render(FlockScopePills, {
      props: { pills: PILLS, onbrowse: () => {}, ontoggle: (kind: string, value: string) => calls.push([kind, value]) },
    });
    await fireEvent.click(tick(container, 'tools').querySelector('input') as HTMLInputElement);
    expect(calls).toEqual([['repos', 'C:/Repos/side/tools']]);
  });
});
