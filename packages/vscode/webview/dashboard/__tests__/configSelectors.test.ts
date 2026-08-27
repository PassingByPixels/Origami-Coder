// configSelectors — the composer's Effort / Session-Mode / Approve controls are
// PUSHED by the host, and every chat needs its own push.
//
// THE REGRESSION these pin (owner report, 0.4.58): a chat sitting on
// `xai/grok-4.5` showed no Effort button, while the engine plainly reported
// `low / medium / high` for that model (verified against both the shipped
// 0.4.58 engine and a fresh build over ACP `session/set_config_option`). The
// composer hides the button when it holds zero options, and it only ever holds
// what the host last pushed — and the host pushed the ACTIVE session's options
// only, once, at moments of its own choosing. Two chats therefore never got
// theirs at all:
//   - a chat that is not the host-active one (a popped-out solo tab NEVER posts
//     `activeSessionChanged`, so it cannot become active by itself);
//   - a chat view that ATTACHED after the host had already pushed (the chat and
//     config side-bar views share one host; the second one to resolve is caught
//     up by a replay that carried messages, context and focus but not these).
//
// So the contract is per-SESSION, not per-window: given N sessions, N sets of
// messages, each tagged with its OWN id. The failing input is any session that
// is not the active one.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { configSelectorMessages, allConfigSelectorMessages } from '../../../src/dashboard/configSelectors';
import InputBar from '../components/InputBar.svelte';

const option = (value: string) => ({ value, name: value.toUpperCase() });

/** A stand-in for AcpClient's three configOption readers. */
const client = (over: {
  effort?: { current: string; options: Array<{ value: string; name: string }> } | null;
  mode?: { current: string; options: Array<{ value: string; name: string }> } | null;
  permission?: string | null;
} = {}) => ({
  getEffortOption: () => over.effort ?? null,
  getModeOption: () => over.mode ?? null,
  getPermissionOption: () => over.permission ?? null,
});

const grok = client({
  effort: { current: 'low', options: [option('low'), option('medium'), option('high')] },
  mode: { current: 'build', options: [option('build'), option('plan')] },
  permission: 'bypass',
});

describe('configSelectorMessages', () => {
  it("tags every message with the session it was computed for", () => {
    const msgs = configSelectorMessages('session-2', grok);
    expect(msgs.every((m) => (m as { sessionId: string }).sessionId === 'session-2')).toBe(true);
  });

  it("carries the model's real effort variants", () => {
    const effort = configSelectorMessages('session-1', grok).find((m) => (m as { type: string }).type === 'effortOptions');
    expect(effort).toEqual({
      type: 'effortOptions',
      sessionId: 'session-1',
      current: 'low',
      options: [option('low'), option('medium'), option('high')],
    });
  });

  it('sends an EMPTY effort list for a model with no variants, so the control hides instead of keeping the last model’s levels', () => {
    const msgs = configSelectorMessages('session-1', client({ effort: null }));
    expect(msgs).toContainEqual({ type: 'effortOptions', sessionId: 'session-1', current: '', options: [] });
  });

  it('omits a mode select with nothing in it (a select whose current value is absent renders as nothing chosen)', () => {
    const msgs = configSelectorMessages('session-1', client({ mode: { current: 'build', options: [] } }));
    expect(msgs.some((m) => (m as { type: string }).type === 'modeOptions')).toBe(false);
  });

  it('omits the approve preset when the engine reported none, rather than asserting a default', () => {
    const msgs = configSelectorMessages('session-1', client({ permission: null }));
    expect(msgs.some((m) => (m as { type: string }).type === 'approveUpdate')).toBe(false);
  });

  it('answers nothing for a session whose engine is not up', () => {
    expect(configSelectorMessages('session-1', undefined)).toEqual([]);
  });
});

describe('allConfigSelectorMessages', () => {
  it('serves EVERY session, not only the one the window calls active', () => {
    // THE REGRESSION. `session-2` is the popped-out tab / late-attached view:
    // it is never the host-active session, so before this it received nothing
    // and its Effort button stayed hidden over a model with three levels.
    const sessions = new Map([
      ['session-1', { client: client({ effort: { current: 'on', options: [option('off'), option('on')] } }) }],
      ['session-2', { client: grok }],
    ]);
    const forSecond = allConfigSelectorMessages(sessions).filter(
      (m) => (m as { sessionId: string }).sessionId === 'session-2',
    );
    expect(forSecond).toContainEqual({
      type: 'effortOptions',
      sessionId: 'session-2',
      current: 'low',
      options: [option('low'), option('medium'), option('high')],
    });
  });

  it('skips a session with no engine and still serves the others', () => {
    const sessions = new Map<string, { client?: ReturnType<typeof client> }>([
      ['session-1', {}],
      ['session-2', { client: grok }],
    ]);
    const ids = new Set(allConfigSelectorMessages(sessions).map((m) => (m as { sessionId: string }).sessionId));
    expect([...ids]).toEqual(['session-2']);
  });
});

// The seam itself: the messages this leaf builds are the ones the REAL composer
// reads, so a shape that drifted on either side would leave the button hidden
// again while both halves' own tests stayed green.
describe('the host payload, through the real composer', () => {
  afterEach(cleanup);
  const mount = (sessionId: string) =>
    render(InputBar, {
      props: { inFlight: false, agentName: 'Tsuru', modelName: 'grok-4.5', modelOnline: true, sessionId, onSend: () => {}, onCancel: () => {} },
    });
  const send = (msg: object) => window.dispatchEvent(new MessageEvent('message', { data: msg }));
  const effortBtn = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.mode-row button')).find((b) => b.textContent?.trim() === 'Effort');

  it('raises the Effort button on the chat the messages are addressed to', async () => {
    const { container } = mount('session-2');
    expect(effortBtn(container)).toBeUndefined(); // nothing pushed yet — hidden, as it was for the whole session
    for (const msg of configSelectorMessages('session-2', grok)) send(msg);
    await waitFor(() => expect(effortBtn(container)).toBeDefined());
    // …offering the model's REAL levels, not a hardcoded think/quick.
    await fireEvent.click(effortBtn(container)!);
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll('.effort-label')).map((s) => s.textContent)).toEqual(['LOW', 'MEDIUM', 'HIGH']),
    );
  });

  it('leaves a DIFFERENT chat alone (the tagging is what keeps two composers apart)', async () => {
    const { container } = mount('session-1');
    for (const msg of configSelectorMessages('session-2', grok)) send(msg);
    await waitFor(() => expect(effortBtn(container)).toBeUndefined());
  });
});
