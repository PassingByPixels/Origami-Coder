// t-qn0wj5, proposal 25 (port of Mock-Redesign CHANGES.md #40's SpringCheck):
// the real "Auto-approve agent permissions" checkbox now renders through
// SpringCheckbox.svelte (its CSS/spring behaviour is covered by
// SpringCheckbox.test.ts) — this file proves RepoHeader's own wiring: the
// checkbox still reflects the prop and still posts the same wire message.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import RepoHeader from './RepoHeader.svelte';
import type { RepoBoard } from './boardBuckets';

afterEach(cleanup);

const repo: RepoBoard = {
  root: 'C:/repo', name: 'repo', workspace: true, missing: false,
  defaultModel: '', rows: [], map: { status: 'none' }, tickets: [],
};

function mount(autoApprove: boolean) {
  const posted: Record<string, unknown>[] = [];
  const { container } = render(RepoHeader, {
    props: {
      repo, displayNames: {}, modelOptions: [], providerStatus: [],
      filter: '', onfilter: () => {}, autoApprove,
      renaming: false, onrenaming: () => {},
      post: (m: Record<string, unknown>) => posted.push(m),
    },
  });
  return { container, posted };
}

describe('RepoHeader auto-approve checkbox — behaviour is unchanged by the SpringCheckbox styling', () => {
  it('is still a real checkbox reflecting the autoApprove prop', () => {
    const { container } = mount(true);
    const input = container.querySelector<HTMLInputElement>('.og-spring-check');
    expect(input).not.toBeNull();
    expect(input!.type).toBe('checkbox');
    expect(input!.checked).toBe(true);
  });

  it('still posts amSetAutoApprove with the toggled value on change', async () => {
    const { container, posted } = mount(false);
    const input = container.querySelector<HTMLInputElement>('.og-spring-check')!;
    input.checked = true;
    await fireEvent.change(input);
    expect(posted).toEqual([{ type: 'amSetAutoApprove', on: true }]);
  });

  it('has one accessible name from the wrapping <label>, not a second one from the input', () => {
    const { container } = mount(false);
    const input = container.querySelector<HTMLInputElement>('.og-spring-check')!;
    expect(input.hasAttribute('aria-label')).toBe(false);
    expect(container.querySelector('label.am-autoapprove')?.textContent?.trim()).toBe('Auto-approve agent permissions');
  });
});
