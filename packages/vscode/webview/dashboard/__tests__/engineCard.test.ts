// engineCard.test.ts — the chat's engine state on the reconnect card (t-v5qn37).
//
// The host (src/dashboard/engineGate.ts) posts `engineState` while a prompt waits for the
// engine, when a start fails, and when it is up. The owner asked for these states to use the
// card a dropped provider stream uses (SystemAlertRow: `.alert[data-state]`), never the red
// Error row. The posts below are the exact shapes engineGate.ts's `tell` produces, spread by
// DashboardPanel.ts into `{ type: 'engineState', sessionId, stage, reason, held }`.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane never unbinds its window listener: a fresh session id per mount.
let seq = 0;

async function mountStarting(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `engine-card-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru', starting: true });
  await tick();
  return { c: container as HTMLElement, sid };
}

const cards = (c: HTMLElement) => [...c.querySelectorAll('.alert')] as HTMLElement[];
const errorRows = (c: HTMLElement) => [...c.querySelectorAll('.row')].filter((r) => /\bError\b|Disconnected/.test(r.textContent ?? ''));
const engineState = (sid: string, stage: string, reason: string, held: number, retry = stage === 'failed') => post({ type: 'engineState', sessionId: sid, stage, reason, held, retry });

describe('the chat engine state is drawn on the reconnect card, not the red Error row', () => {
  it('a prompt waiting for the engine shows ONE card that goes from waiting to ready', async () => {
    const { c, sid } = await mountStarting();
    engineState(sid, 'starting', '', 1);
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['retrying']);
    expect(cards(c)[0]?.textContent).toContain('will send when the engine is up');
    engineState(sid, 'ready', '', 1);
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['recovered']);
    expect(cards(c)[0]?.textContent).toContain('Your message was sent');
    expect(errorRows(c)).toEqual([]);
  });

  it('a failed start shows the reason and a Retry that asks the host to start again', async () => {
    const { c, sid } = await mountStarting();
    engineState(sid, 'starting', '', 1);
    engineState(sid, 'failed', 'spawn origami.exe ENOENT', 1);
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['stopped']);
    expect(cards(c)[0]?.textContent).toContain('spawn origami.exe ENOENT');
    expect(cards(c)[0]?.textContent).toContain('Retry sends it');
    expect(errorRows(c)).toEqual([]);
    // The house warm tip, not a native title (webview/shared/nativeTitleGuard.test.ts).
    expect((c.querySelector('.alert-retry') as HTMLElement).dataset.tip).toContain("Start this chat's engine again");
    expect(c.querySelector('.alert-retry')?.hasAttribute('title')).toBe(false);
    await fireEvent.click(c.querySelector('.alert-retry') as HTMLElement);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'engineRetry', sessionId: sid });
    // The retry's own states land on the SAME card.
    engineState(sid, 'starting', '', 1);
    engineState(sid, 'ready', '', 1);
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['recovered']);
  });

  it('a start that fails with no prompt waiting still says so on the card', async () => {
    const { c, sid } = await mountStarting();
    engineState(sid, 'failed', 'origami-acp exited (code=1, signal=null)', 0);
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['stopped']);
    expect(c.querySelector('.alert-retry')).not.toBeNull();
  });

  it('a fork the host will not retry shows why, and no Retry button', async () => {
    const { c, sid } = await mountStarting();
    engineState(sid, 'failed', 'ACP connection closed · The fork did not open, and a new try could make a second copy. Close this tab and use the Fork button again.', 1, false);
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['stopped']);
    expect(cards(c)[0]?.textContent).toContain('use the Fork button again');
    expect(cards(c)[0]?.textContent).not.toContain('Retry sends it');
    expect(c.querySelector('.alert-retry')).toBeNull();
  });

  it('an engine that exits after it was up is the card too, with no Retry', async () => {
    const { c, sid } = await mountStarting();
    post({ type: 'closed', sessionId: sid, reason: 'origami-acp exited (code=null, signal=SIGKILL)' });
    await tick();
    expect(cards(c).map((a) => a.dataset.state)).toEqual(['stopped']);
    expect(cards(c)[0]?.textContent).toContain('SIGKILL');
    expect(c.querySelector('.alert-retry')).toBeNull();
    expect(errorRows(c)).toEqual([]);
  });

  it('a start nobody waits on draws no card', async () => {
    const { c, sid } = await mountStarting();
    engineState(sid, 'starting', '', 0);
    await tick();
    expect(cards(c)).toEqual([]);
  });
});

describe('t-x3a89j: the failed card says when, and offers Copy details and Open engine log', () => {
  it('a failed restore shows the time; Copy details copies the host text; Open engine log asks the host', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { c, sid } = await mountStarting();
    const at = new Date(2026, 8, 25, 9, 5, 1).getTime();
    const details = 'Origami: The engine did not start again (restore of a stopped chat)\nWhen: x\nWhy: origami-acp exited (code=3, signal=null)';
    post({ type: 'engineState', sessionId: sid, stage: 'failed', reason: 'origami-acp exited (code=3, signal=null)', held: 1, retry: true, at, details });
    await tick();
    const card = cards(c)[0]!;
    expect(card.textContent).toContain('at 09:05:01');
    const copy = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Copy details')!;
    const open = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Open engine log')!;
    await fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(details);
    await fireEvent.click(open);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'openEngineLog' });
    expect(c.querySelector('.alert-retry')).not.toBeNull(); // Retry stays
  });

  it('a card with no details (an old host, or a start still running) shows neither button', async () => {
    const { c, sid } = await mountStarting();
    engineState(sid, 'failed', 'spawn origami.exe ENOENT', 1);
    await tick();
    const labels = [...cards(c)[0]!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Retry']);
  });
});
