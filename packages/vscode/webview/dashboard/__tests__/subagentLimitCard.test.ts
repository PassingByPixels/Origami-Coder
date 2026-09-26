// The Insights pane's sub-agent time limit, both halves.
//
// The failure this guards is quiet in both directions. Write a value the engine
// will not take and the setting reads as set while the engine runs its own
// default (`positiveInteger` DISCARDS a bad value rather than clamping it).
// Show a value the host never stored and the pane lies about what is in force.
// Neither throws, and neither is visible without looking at a running agent's
// wall-clock a few hours later.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: { settings: {} as Record<string, unknown>, writes: [] as unknown[], throws: false },
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
      update: async (key: string, value: unknown, target: unknown) => {
        if (fake.throws) throw new Error('settings.json is read-only');
        fake.writes.push([key, value, target]);
        fake.settings[key] = value;
      },
    }),
  },
}));

import { SUBAGENT_LIMIT_MESSAGE_TYPES, handleSubagentLimitMessage } from '../../../src/dashboard/subagentLimitPane';
import { SUBAGENT_LIMIT_SETTING } from '../../../src/subagentLimit';
import SubagentLimitCard from '../components/SubagentLimitCard.svelte';

beforeEach(() => { fake.settings = {}; fake.writes = []; fake.throws = false; });
afterEach(cleanup);

describe('subagentLimitPane — the host half', () => {
  const posted: Record<string, unknown>[] = [];
  const host = { post: (m: Record<string, unknown>) => { posted.push(m); } };
  beforeEach(() => { posted.length = 0; });

  it('claims both of its message types and nothing else', () => {
    expect([...SUBAGENT_LIMIT_MESSAGE_TYPES].sort()).toEqual(['requestSubagentLimit', 'subagentLimitSet']);
  });

  it('reports the DEFAULT, flagged as not stored, when nothing is set', async () => {
    // `stored: false` is what lets the pane say "the engine's own default
    // applies" instead of claiming the user chose four hours.
    await handleSubagentLimitMessage(host, { type: 'requestSubagentLimit' });
    expect(posted[0]).toMatchObject({ hours: 4, stored: false, min: 0.5, default: 4 });
  });

  it('writes the setting and reports it back as stored', async () => {
    await handleSubagentLimitMessage(host, { type: 'subagentLimitSet', hours: 2 });
    expect(fake.writes).toEqual([[SUBAGENT_LIMIT_SETTING, 2, 1]]);
    expect(posted[0]).toMatchObject({ hours: 2, stored: true });
    expect(posted[0].error).toBeUndefined();
  });

  it('REFUSES a value below the minimum rather than storing one the engine drops', async () => {
    // The webview's `min` is not a validator — a message can arrive from a
    // stale view. A stored 0.1 would be silently discarded engine-side and the
    // pane would show a cap that is not in force.
    await handleSubagentLimitMessage(host, { type: 'subagentLimitSet', hours: 0.1 });
    expect(fake.writes).toEqual([]);
    expect(posted[0].error).toContain('at least 0.5');
    expect(posted[0]).toMatchObject({ hours: 4, stored: false });
  });

  it('refuses a non-number outright', async () => {
    await handleSubagentLimitMessage(host, { type: 'subagentLimitSet', hours: '3' });
    await handleSubagentLimitMessage(host, { type: 'subagentLimitSet' });
    expect(fake.writes).toEqual([]);
    expect(posted).toHaveLength(2);
  });

  it('reports a write that FAILED instead of reporting success', async () => {
    fake.throws = true;
    await handleSubagentLimitMessage(host, { type: 'subagentLimitSet', hours: 3 });
    expect(posted[0].error).toContain('read-only');
    expect(posted[0]).toMatchObject({ hours: 4, stored: false });
  });

  it('ignores a message that is not its own', async () => {
    await handleSubagentLimitMessage(host, { type: 'flockRequest' });
    expect(posted).toEqual([]);
  });
});

describe('SubagentLimitCard — the pane half', () => {
  const data = (over: Record<string, unknown> = {}) =>
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'subagentLimitData', hours: 4, stored: false, min: 0.5, default: 4, ...over },
    }));

  it('asks the host for the setting on mount', () => {
    render(SubagentLimitCard);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestSubagentLimit' });
  });

  it('shows the stored hours and sends a change to the host', async () => {
    const { container } = render(SubagentLimitCard);
    data({ hours: 6, stored: true });
    const input = container.querySelector('.sal-input') as HTMLInputElement;
    await vi.waitFor(() => expect(input.value).toBe('6'));

    await fireEvent.change(input, { target: { value: '2' } });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'subagentLimitSet', hours: 2 });
  });

  it('never SENDS a value under the minimum, and snaps the box back', async () => {
    const { container } = render(SubagentLimitCard);
    data({ hours: 4, stored: true });
    const input = container.querySelector('.sal-input') as HTMLInputElement;
    await fireEvent.change(input, { target: { value: '0.1' } });

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith({ type: 'subagentLimitSet', hours: 0.1 });
    await vi.waitFor(() => expect(input.value).toBe('4'));
    expect(container.querySelector('.sal-error')?.textContent).toContain('at least 0.5');
  });

  it('says the change applies to NEW chats, because the engine reads the env at spawn (t-xtimx0)', () => {
    // Without this the setting looks broken: it is written, and the sub-agent
    // running right now keeps the cap it was spawned with.
    // t-s9jr6u: the caveat is the Settings row's "reload" pill (its tooltip).
    const { container } = render(SubagentLimitCard);
    expect(container.querySelector('.pill')?.getAttribute('data-tip')?.toLowerCase()).toContain('new chats');
    expect(container.querySelector('.pill')?.getAttribute('data-tip')?.toLowerCase()).not.toContain('reload');
    expect(container.querySelector('.pill')?.textContent).toBe('new chats'); // the pill word said "reload" too
  });

  it('says the ENGINE default applies while nothing is stored, and stops saying so once it is', async () => {
    const { container } = render(SubagentLimitCard);
    data({ stored: false });
    // t-s9jr6u (round 5): unset = an EMPTY box whose placeholder is the engine default.
    const input = container.querySelector('.sal-input') as HTMLInputElement;
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(input.placeholder).toBe('4');
    data({ hours: 3, stored: true });
    await vi.waitFor(() => expect(input.value).toBe('3'));
  });
});
