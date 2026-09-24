// SystemAlertRow.test.ts — the dropped-stream card, mounted through the SAME
// dispatch a real transcript uses (t-q90gj9).
//
// The rows go through ChatTranscript rather than the card alone, because the
// defect being fixed was never the card: it was that the notice reached the
// transcript as an AGENT message and so wore the agent's name. A test of the
// card in isolation could pass with the dispatch still routing it to
// MessageRow. So every case below asserts on what the transcript drew.
//
// NOTE, per the agent guide's Part 6: vitest.config.mts sets no `css: true`,
// so no <style> element ever reaches this DOM. Nothing here asserts a COLOUR —
// the state class and the token names are what is checked (architecture.test.ts
// separately fails on any --og-* this package does not define). The card's
// actual appearance needs a human eye.

import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatTranscript from './ChatTranscript.svelte';
import type { Message } from '../panes/chatMessage';
import type { StreamDropNotice } from '../panes/streamDropNotice';

const DETAIL = 'fetch failed (ECONNRESET)';

const notice = (over: Partial<StreamDropNotice> = {}): StreamDropNotice => ({
  kind: 'retrying', attempt: 2, max: 3, detail: DETAIL, terminal: false, ...over,
});

function mount(messages: Message[], props: Record<string, unknown> = {}) {
  return render(ChatTranscript, {
    messages,
    sessionId: 'ses_1',
    inFlight: false,
    currentThoughtMsgId: null,
    currentAgentMsgId: null,
    openThoughtIds: undefined,
    onThoughtOpenIds: () => {},
    ...props,
  });
}

const dropRow = (over: Partial<StreamDropNotice> = {}, recovered?: boolean): Message => ({
  id: 1, kind: 'streamDrop', label: 'System', text: '',
  streamDrop: { notice: notice(over), ...(recovered ? { recovered: true } : {}) },
});

describe('the three states', () => {
  it('draws RETRYING on the warning tokens, counting the engine attempts', () => {
    const { container } = mount([dropRow()]);
    const alert = container.querySelector('[data-state]');
    expect(alert?.getAttribute('data-state')).toBe('retrying');
    expect(alert?.textContent).toContain('Retrying');
    expect(alert?.textContent).toContain('attempt 2 of 3');
    // The provider's own sentence survives verbatim — brackets and all, which is
    // why no client may be asked to parse it back out of a formatted line.
    expect(alert?.textContent).toContain(DETAIL);
  });

  it('draws RECOVERED once prose landed', () => {
    const { container } = mount([dropRow({}, true)]);
    const alert = container.querySelector('[data-state]');
    expect(alert?.getAttribute('data-state')).toBe('recovered');
    expect(alert?.textContent).toContain('Recovered on attempt 2 of 3');
  });

  it('draws STOPPED with a Retry action', () => {
    const { container, getByRole } = mount([dropRow({ kind: 'stopped', attempt: 3, terminal: true })], {
      onRetryTurn: () => {},
    });
    expect(container.querySelector('[data-state]')?.getAttribute('data-state')).toBe('stopped');
    expect(getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('offers Retry ONLY on the stopped card', () => {
    const { queryByRole } = mount([dropRow()], { onRetryTurn: () => {} });
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('hides Retry in a read-only transcript, where no turn can be sent', () => {
    const { queryByRole } = mount([dropRow({ kind: 'stopped', attempt: 3, terminal: true })], {
      onRetryTurn: () => {}, readOnly: true,
    });
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('it is the SYSTEM speaking', () => {
  // The whole defect. The notice used to be a text part, so the transcript drew
  // it as an agent turn headed with the agent's name and it read as something
  // the model said.
  it('shows no agent name and no rewind affordance on the card', () => {
    const { container } = mount([
      { id: 1, kind: 'agent', label: 'Tsuru', text: 'working on it', engineMsgId: 'eng-1' },
      { ...dropRow(), id: 2 },
    ]);
    const alert = container.querySelector('[data-state]');
    expect(alert?.textContent).not.toContain('Tsuru');
    // The card is not inside the agent row, so it carries none of its chrome.
    expect(alert?.closest('.agent-row')).toBeNull();
  });

  it('draws ONE card per row, however many attempts it counted', () => {
    const { container } = mount([dropRow({ attempt: 3 })]);
    expect(container.querySelectorAll('[data-state]')).toHaveLength(1);
  });
});

describe('Retry', () => {
  it('asks the pane to send the turn again, naming the session', () => {
    const onRetryTurn = vi.fn();
    const { getByRole } = mount([dropRow({ kind: 'stopped', attempt: 3, terminal: true })], { onRetryTurn });
    fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(onRetryTurn).toHaveBeenCalledWith('ses_1');
  });
});

describe('a session stored before the structured notice', () => {
  // The old form is a plain agent text part. It must keep rendering as it did —
  // there is no pattern matching anywhere on this side that could turn it into
  // a card, and inventing one is the thing the owner ruled out.
  it('still renders the text form, as agent prose, with nothing thrown', () => {
    const { container } = mount([
      { id: 1, kind: 'agent', label: 'Tsuru',
        text: 'Stream dropped (fetch failed) — retrying, attempt 1 of 3.' },
    ]);
    expect(container.textContent).toContain('Stream dropped');
    expect(container.querySelector('[data-state]')).toBeNull();
  });

  // Fail-closed at the row level too: a 'streamDrop' row whose rider did not
  // survive (a log from a build that wrote the kind but not the notice) draws
  // nothing rather than a card full of undefined.
  it('draws nothing for a streamDrop row with no notice on it', () => {
    const { container } = mount([{ id: 1, kind: 'streamDrop', label: 'System', text: '' }]);
    expect(container.querySelector('[data-state]')).toBeNull();
  });
});
